import { withContext, withPlatform, withTenant, type PoolClient } from '@clubedarifa/db';
import {
  DEFAULT_PROGRESS_MODE,
  DRAW_STATUSES_BLOCKED_UNTIL_REFUND,
  DRAW_STATUS_TRANSITIONS,
  ORGANIZER_DRAW_TRANSITIONS,
  PLATFORM_REVIEW_DECISIONS,
  RESERVATION_TTL_MINUTES,
  drawReadinessProblems,
  drawTransitionEvents,
  isDrawStatus,
  labelDigitsForGridSize,
  validateDrawRules,
  type CreateDrawRequest,
  type DrawCustomization,
  type DrawNumbersResponse,
  type OrderResponse,
  type OrganizerDraw,
  type PublicDrawDetail,
  type DrawCloseMode,
  type DrawResultSource,
  type NoWinnerPolicy,
  type DrawStatus,
  type Prize,
  type PublicDrawSummary,
  type ReservationResponse,
  type ReviewQueueResponse,
  type UpdateDrawRequest,
} from '@clubedarifa/shared';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';
import { isUniqueViolation } from '../../lib/pgError.js';
import { paginate, type Keyset } from '../../lib/cursor.js';
import { recordAuditEvent } from '../audit/auditService.js';
import { withEntitlementErrors } from '../billing/entitlementService.js';
import { enqueueOutboxEvent } from '../outbox/outboxService.js';

/** De onde veio a acao. Vai para a trilha de auditoria (RN11). */
export interface ActionOrigin {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/**
 * M02/M03/M04 · sorteio, grade, reserva e pedido.
 *
 * DUAS IDEIAS SUSTENTAM ESTE ARQUIVO.
 *
 * 1. LIVRE E AUSENCIA. `draw_numbers` so guarda numero ocupado. A grade de 1000
 *    com 40 vendidos devolve 40 linhas, nao 1000 — e o telefone do participante,
 *    que e onde a compra acontece, agradece.
 *
 * 2. QUEM DECIDE O EMPATE E O BANCO. A reserva nao pergunta "esta livre?" para
 *    depois gravar: entre a pergunta e a resposta cabe outra transacao inteira.
 *    Ela TENTA gravar, e o indice unico `(draw_id, number)` decide. Um `if` na
 *    aplicacao nunca substituiria isso.
 */

interface DrawRow {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  category: string | null;
  regulation: string | null;
  /** Ajustes do organizador; `{}` = tudo no padrao. A forma exata e validada na entrada. */
  customization: {
    progressMode?: string;
    headline?: string;
    ctaLabel?: string;
    bannerUrl?: string;
    accentColor?: string;
    showCountdown?: boolean;
    showBuyers?: boolean;
    minPerOrder?: number;
    maxPerOrder?: number;
  };
  description: string | null;
  prize_name: string;
  prize_description: string | null;
  prize_image_url: string | null;
  /** Legado, espelhado de `ticket_price_cents` pelo banco (0012). Nao ler. */
  unit_price_cents: number;
  ticket_price_cents: number;
  promotional_price_cents: number | null;
  promo_until: string | null;
  /** Calculado pelo BANCO (`PROMO_ACTIVE_SQL`): promocao vigente agora. */
  promo_active: boolean;
  total_numbers: number;
  label_digits: 2 | 3;
  status: string;
  draw_date: string | null;
  sales_start_at: string | null;
  close_mode: DrawCloseMode;
  close_at: string | null;
  result_source: DrawResultSource;
  no_winner_policy: NoWinnerPolicy;
  thresholds: number[];
  review_note: string | null;
  created_at: string;
}

/**
 * Promocao vigente, decidida pelo RELOGIO DO BANCO. O relogio da aplicacao pode
 * discordar por segundos; o preco cobrado e o preco mostrado saem da mesma fonte.
 */
const PROMO_ACTIVE_SQL = '(promotional_price_cents IS NOT NULL AND promo_until > now())';

/** Projecao padrao de `draws`: todas as colunas mais o estado da promocao. */
const DRAW_COLUMNS = `*, ${PROMO_ACTIVE_SQL} AS promo_active`;

/** Preco efetivo por numero, em SQL: o promocional vigente ou o cheio. */
const EFFECTIVE_PRICE_SQL = `CASE WHEN ${PROMO_ACTIVE_SQL}
            THEN promotional_price_cents ELSE ticket_price_cents END`;

function precoEfetivo(row: DrawRow): number {
  return row.promo_active && row.promotional_price_cents !== null
    ? row.promotional_price_cents
    : row.ticket_price_cents;
}

async function carregarPremios(client: PoolClient, drawId: string): Promise<Prize[]> {
  const { rows } = await client.query<{
    position: number;
    name: string;
    description: string | null;
    image_url: string | null;
    estimated_value_cents: number | null;
  }>(
    `SELECT position, name, description, image_url, estimated_value_cents
       FROM prizes WHERE draw_id = $1 ORDER BY position`,
    [drawId],
  );
  return rows.map((r) => ({
    position: r.position,
    name: r.name,
    description: r.description,
    imageUrl: r.image_url,
    estimatedValueCents: r.estimated_value_cents,
  }));
}

/** Texto so de espacos vira nulo: o banco recusa texto vazio, e o organizador nao precisa ver um 500. */
function semBrancos(texto: string | null | undefined): string | null {
  const limpo = texto?.trim();
  return limpo ? limpo : null;
}

/** O que a vitrine aplica: o ajuste do organizador onde houve, o padrao onde nao. */
function personalizacaoResolvida(row: DrawRow): DrawCustomization {
  const c = row.customization ?? {};
  const modo = c.progressMode;
  return {
    progressMode: modo === 'FALTAM' || modo === 'PERCENTUAL' || modo === 'OCULTAR' ? modo : DEFAULT_PROGRESS_MODE,
    headline: typeof c.headline === 'string' ? c.headline : null,
    ctaLabel: typeof c.ctaLabel === 'string' ? c.ctaLabel : null,
    bannerUrl: typeof c.bannerUrl === 'string' ? c.bannerUrl : null,
    accentColor: typeof c.accentColor === 'string' ? c.accentColor : null,
    showCountdown: c.showCountdown === true,
    showBuyers: c.showBuyers === true,
    minPerOrder: Number.isInteger(c.minPerOrder) && c.minPerOrder! >= 1 ? c.minPerOrder! : 1,
    maxPerOrder: Number.isInteger(c.maxPerOrder) && c.maxPerOrder! >= 1 ? c.maxPerOrder! : null,
  };
}

/** Estados em que a vitrine mostra o sorteio. RASCUNHO nao aparece ao publico. */
const STATUS_VISIVEL_NA_VITRINE = [
  'ATIVA',
  'PAUSADA',
  'VENDAS ENCERRADAS',
  // O sorteio continua na vitrine ate depois do resultado: e la que o
  // participante o encontra, e a pagina publica do resultado parte dele.
  'APURAÇÃO',
  'RESULTADO PUBLICADO',
];

/** Somente ATIVA aceita reserva nova. */
const STATUS_QUE_VENDE = 'ATIVA';

function toSummary(row: DrawRow, paidCount: number): PublicDrawSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    description: row.description,
    prizeName: row.prize_name,
    prizeImageUrl: row.prize_image_url,
    unitPriceCents: precoEfetivo(row),
    ticketPriceCents: row.ticket_price_cents,
    promotionalPriceCents: row.promo_active ? row.promotional_price_cents : null,
    promoUntil: row.promo_active ? row.promo_until : null,
    promoActive: row.promo_active,
    totalNumbers: row.total_numbers,
    labelDigits: row.label_digits,
    status: row.status as PublicDrawSummary['status'],
    drawDate: row.draw_date,
    paidCount,
  };
}

/**
 * Contagem por estado de UM sorteio.
 *
 * `RESERVADO` vencido NAO conta: a reserva expirada ja liberou o numero, mesmo
 * que nenhuma varredura tenha passado por ele ainda. Contar pelo registro em vez
 * de pelo relogio mostraria ao participante uma grade mais cheia do que ela e.
 */
async function contarPorEstado(
  client: PoolClient,
  drawId: string,
): Promise<{ paid: number; pending: number; reserved: number; taken: number }> {
  const { rows } = await client.query<{ status: string; total: string }>(
    `SELECT status, count(*)::text AS total
       FROM draw_numbers
      WHERE draw_id = $1
        AND (status <> 'RESERVADO' OR expires_at > now())
      GROUP BY status`,
    [drawId],
  );

  const por = new Map(rows.map((r) => [r.status, Number(r.total)]));
  const paid = por.get('PAGO') ?? 0;
  const pending = por.get('PENDENTE') ?? 0;
  const reserved = por.get('RESERVADO') ?? 0;
  return { paid, pending, reserved, taken: paid + pending + reserved };
}

// ---------------------------------------------------------------------------
// Vitrine
// ---------------------------------------------------------------------------

export async function listPublicDraws(
  deps: AppDeps,
  tenantId: string,
  page: { cursor: Keyset | null; limit: number },
): Promise<{ draws: PublicDrawSummary[]; nextCursor: string | null }> {
  return withTenant(deps.pool, { tenantId }, async (client) => {
    // Faixa 0 = vendendo agora (e o que a pessoa veio ver); faixa 1 = o resto. O
    // cursor leva a faixa: a ordem e (faixa, criacao DESC, id DESC).
    const { rows } = await client.query<DrawRow & { paid_count: string; faixa: number; cursor_t: string }>(
      `SELECT d.*,
              (d.promotional_price_cents IS NOT NULL AND d.promo_until > now()) AS promo_active,
              (SELECT count(*) FROM draw_numbers n
                WHERE n.draw_id = d.id AND n.status = 'PAGO')::text AS paid_count,
              CASE WHEN d.status = 'ATIVA' THEN 0 ELSE 1 END AS faixa,
              d.created_at::text AS cursor_t
         FROM draws d
        WHERE d.status = ANY($1::draw_status[])
          AND (
            $2::int IS NULL
            OR (CASE WHEN d.status = 'ATIVA' THEN 0 ELSE 1 END) > $2::int
            OR ((CASE WHEN d.status = 'ATIVA' THEN 0 ELSE 1 END) = $2::int
                AND (d.created_at, d.id) < ($3::timestamptz, $4::uuid))
          )
        ORDER BY faixa, d.created_at DESC, d.id DESC
        LIMIT $5`,
      [
        STATUS_VISIVEL_NA_VITRINE,
        page.cursor?.b ?? null,
        page.cursor?.t ?? null,
        page.cursor?.id ?? null,
        page.limit + 1,
      ],
    );
    const { pagina, nextCursor } = paginate(rows, page.limit, (r) => ({ t: r.cursor_t, id: r.id, b: r.faixa }));
    return { draws: pagina.map((row) => toSummary(row, Number(row.paid_count))), nextCursor };
  });
}

export async function getPublicDraw(
  deps: AppDeps,
  tenantId: string,
  slug: string,
): Promise<PublicDrawDetail> {
  return withTenant(deps.pool, { tenantId }, async (client) => {
    const { rows } = await client.query<DrawRow>(
      `SELECT ${DRAW_COLUMNS} FROM draws WHERE slug = $1 AND status = ANY($2::draw_status[])`,
      [slug, STATUS_VISIVEL_NA_VITRINE],
    );
    const row = rows[0];
    if (!row) throw ApiError.notFound('Sorteio não encontrado.');

    const contagem = await contarPorEstado(client, row.id);
    return {
      ...toSummary(row, contagem.paid),
      prizeDescription: row.prize_description,
      category: row.category,
      regulation: row.regulation,
      customization: personalizacaoResolvida(row),
      prizes: await carregarPremios(client, row.id),
      closeMode: row.close_mode,
      closeAt: row.close_at,
      salesStartAt: row.sales_start_at,
      resultSource: row.result_source,
      noWinnerPolicy: row.no_winner_policy,
      takenCount: contagem.taken,
    };
  });
}

/** Somente os numeros OCUPADOS. Os livres o cliente deriva. */
export async function getDrawNumbers(
  deps: AppDeps,
  tenantId: string,
  drawId: string,
): Promise<DrawNumbersResponse> {
  return withTenant(deps.pool, { tenantId }, async (client) => {
    const { rows: drawRows } = await client.query<{ id: string; total_numbers: number }>(
      `SELECT id, total_numbers FROM draws
        WHERE id = $1 AND status = ANY($2::draw_status[])`,
      [drawId, STATUS_VISIVEL_NA_VITRINE],
    );
    const draw = drawRows[0];
    if (!draw) throw ApiError.notFound('Sorteio não encontrado.');

    const { rows } = await client.query<{ number: number; status: string }>(
      `SELECT number, status
         FROM draw_numbers
        WHERE draw_id = $1
          AND (status <> 'RESERVADO' OR expires_at > now())
          AND status IN ('RESERVADO', 'PENDENTE', 'PAGO')
        ORDER BY number`,
      [drawId],
    );

    return {
      drawId: draw.id,
      totalNumbers: draw.total_numbers,
      labelDigits: labelDigitsForGridSize(draw.total_numbers),
      taken: rows.map((r) => ({ number: r.number, status: r.status as 'RESERVADO' | 'PENDENTE' | 'PAGO' })),
    };
  });
}

// ---------------------------------------------------------------------------
// Reserva — o ponto critico
// ---------------------------------------------------------------------------

export class NumbersUnavailableError extends ApiError {
  readonly unavailable: readonly number[];
  constructor(unavailable: readonly number[]) {
    super(
      'CONFLICT',
      unavailable.length === 1
        ? 'Um dos números escolhidos acabou de ser reservado por outra pessoa.'
        : 'Alguns dos números escolhidos acabaram de ser reservados por outra pessoa.',
      { unavailableNumbers: [...unavailable] },
    );
    this.unavailable = unavailable;
  }
}

/**
 * Reserva ATOMICA: todos os numeros ou nenhum.
 *
 * A transacao faz duas tentativas de tomar posse, nesta ordem:
 *
 *   1. REAPROVEITAR linha de reserva VENCIDA. O `UPDATE ... WHERE expires_at <=
 *      now()` trava a linha; duas requisicoes simultaneas disputam esse lock e
 *      so uma o obtem. Reaproveitar em vez de apagar preserva o historico do
 *      numero — e evita conceder DELETE ao papel da aplicacao.
 *
 *   2. INSERIR linha para numero que nunca teve dono. Aqui quem decide e o
 *      indice unico `(draw_id, number)`: `ON CONFLICT DO NOTHING` faz a
 *      requisicao perdedora simplesmente nao receber a linha de volta.
 *
 * Se a soma dos dois passos nao cobrir tudo o que foi pedido, a transacao inteira
 * volta atras e ninguem fica com nada. E isso que torna a reserva "tudo ou nada"
 * de verdade, e nao por convencao.
 */
export async function createReservation(
  deps: AppDeps,
  input: { tenantId: string; drawId: string; numbers: readonly number[] },
): Promise<ReservationResponse> {
  const pedidos = [...new Set(input.numbers)].sort((a, b) => a - b);
  if (pedidos.length === 0) {
    throw ApiError.badRequest('Escolha ao menos um número.');
  }

  return withTenant(deps.pool, { tenantId: input.tenantId }, async (client) => {
    const { rows: drawRows } = await client.query<{
      id: string;
      total_numbers: number;
      unit_price_cents: number;
      status: string;
      customization: DrawRow['customization'] | null;
    }>(
      // `FOR SHARE`: impede que o sorteio seja pausado no meio desta reserva.
      // O preco EFETIVO e decidido aqui, no servidor, e gravado na reserva.
      `SELECT id, total_numbers, status, customization,
              ${EFFECTIVE_PRICE_SQL} AS unit_price_cents
         FROM draws WHERE id = $1 FOR SHARE`,
      [input.drawId],
    );
    const draw = drawRows[0];
    if (!draw) throw ApiError.notFound('Sorteio não encontrado.');
    if (draw.status !== STATUS_QUE_VENDE) {
      throw ApiError.conflict('Este sorteio não está aberto para vendas.');
    }

    // Faixa conferida no SERVIDOR. O cliente escolhe de uma grade desenhada por
    // ele; nada impede que envie 5000 numa grade de 100.
    const foraDaFaixa = pedidos.filter((n) => n < 0 || n >= draw.total_numbers);
    if (foraDaFaixa.length > 0) {
      throw ApiError.badRequest(
        `Número fora da grade deste sorteio: ${foraDaFaixa.join(', ')}.`,
      );
    }

    // Minimo/maximo de numeros por pedido: regra do organizador, conferida aqui.
    const limites = personalizacaoResolvida({ customization: draw.customization ?? {} } as DrawRow);
    if (pedidos.length < limites.minPerOrder) {
      throw ApiError.badRequest(`Escolha ao menos ${limites.minPerOrder} número(s) neste sorteio.`);
    }
    if (limites.maxPerOrder !== null && pedidos.length > limites.maxPerOrder) {
      throw ApiError.badRequest(`Cada pedido aceita no máximo ${limites.maxPerOrder} número(s) neste sorteio.`);
    }

    const expiresAt = new Date(Date.now() + RESERVATION_TTL_MINUTES * 60_000);

    const { rows: reservaRows } = await client.query<{ id: string }>(
      `INSERT INTO reservations (tenant_id, draw_id, expires_at, unit_price_cents)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.tenantId, input.drawId, expiresAt.toISOString(), draw.unit_price_cents],
    );
    const reservationId = reservaRows[0]!.id;

    // Passo 1: retomar reservas vencidas.
    const { rows: retomados } = await client.query<{ number: number }>(
      `UPDATE draw_numbers
          SET status = 'RESERVADO',
              reservation_id = $3,
              expires_at = $4,
              order_id = NULL
        WHERE draw_id = $1
          AND number = ANY($2::int[])
          AND status = 'RESERVADO'
          AND expires_at <= now()
        RETURNING number`,
      [input.drawId, pedidos, reservationId, expiresAt.toISOString()],
    );
    const jaTomados = new Set(retomados.map((r) => r.number));

    // Passo 2: ocupar os que nunca tiveram dono.
    const restantes = pedidos.filter((n) => !jaTomados.has(n));
    let inseridos: { number: number }[] = [];
    if (restantes.length > 0) {
      const resultado = await client.query<{ number: number }>(
        `INSERT INTO draw_numbers
           (tenant_id, draw_id, number, status, reservation_id, expires_at)
         SELECT $1, $2, n, 'RESERVADO', $4, $5
           FROM unnest($3::int[]) AS n
         ON CONFLICT (draw_id, number) DO NOTHING
         RETURNING number`,
        [input.tenantId, input.drawId, restantes, reservationId, expiresAt.toISOString()],
      );
      inseridos = resultado.rows;
    }

    const conquistados = new Set([...jaTomados, ...inseridos.map((r) => r.number)]);
    if (conquistados.size !== pedidos.length) {
      // Lancar desfaz a transacao inteira: os numeros que ESTA requisicao
      // chegou a tomar voltam a ficar livres. Sem isso, uma reserva parcial
      // deixaria numeros presos a um pedido que nunca vai existir.
      throw new NumbersUnavailableError(pedidos.filter((n) => !conquistados.has(n)));
    }

    return {
      reservationId,
      drawId: input.drawId,
      numbers: pedidos,
      expiresAt: expiresAt.toISOString(),
      unitPriceCents: draw.unit_price_cents,
      totalCents: draw.unit_price_cents * pedidos.length,
    };
  });
}

// ---------------------------------------------------------------------------
// Pedido
// ---------------------------------------------------------------------------

export async function montarPedido(client: PoolClient, orderId: string): Promise<OrderResponse> {
  const { rows } = await client.query<{
    id: string;
    status: string;
    draw_id: string;
    draw_title: string;
    quantity: number;
    unit_price_cents: number;
    total_cents: number;
    buyer_name: string;
    created_at: string;
    paid_at: string | null;
    expires_at: string | null;
    total_numbers: number;
    numbers: number[] | null;
  }>(
    `SELECT o.id, o.status::text AS status, o.draw_id, d.title AS draw_title,
            d.total_numbers,
            o.quantity, o.unit_price_cents, o.total_cents,
            b.name AS buyer_name, o.created_at, o.paid_at,
            r.expires_at,
            (SELECT array_agg(i.number ORDER BY i.number)
               FROM order_items i WHERE i.order_id = o.id) AS numbers
       FROM orders o
       JOIN draws d ON d.id = o.draw_id
       JOIN buyers b ON b.id = o.buyer_id
       LEFT JOIN reservations r ON r.id = o.reservation_id
      WHERE o.id = $1`,
    [orderId],
  );
  const row = rows[0];
  if (!row) throw ApiError.notFound('Pedido não encontrado.');

  // Cobranca PIX mais recente, se ja foi gerada.
  const { rows: pagamentos } = await client.query<{
    status: OrderResponse['payment'] extends infer P ? (P extends { status: infer S } ? S : never) : never;
    pix_copy_paste: string | null;
    pix_qr_base64: string | null;
    expires_at: string;
    needs_manual_refund: boolean;
  }>(
    `SELECT status::text AS status, pix_copy_paste, pix_qr_base64, expires_at, needs_manual_refund
       FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [orderId],
  );
  const pagamento = pagamentos[0];

  return {
    orderId: row.id,
    status: row.status as OrderResponse['status'],
    drawId: row.draw_id,
    drawTitle: row.draw_title,
    numbers: row.numbers ?? [],
    labelDigits: labelDigitsForGridSize(row.total_numbers),
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    totalCents: row.total_cents,
    buyerName: row.buyer_name,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    // Depois de pago o prazo perde sentido: nao ha mais o que expirar.
    expiresAt: row.status === 'PAGO' ? null : row.expires_at,
    payment: pagamento
      ? {
          status: pagamento.status,
          copyPaste: pagamento.pix_copy_paste,
          qrCodeBase64: pagamento.pix_qr_base64,
          expiresAt: pagamento.expires_at,
          needsManualRefund: pagamento.needs_manual_refund,
        }
      : null,
  };
}

/**
 * Converte reserva em pedido.
 *
 * A reserva e revalidada DENTRO da transacao, com `FOR UPDATE`. Checar o prazo
 * no cliente — ou antes de abrir a transacao — deixaria passar o caso em que ela
 * vence entre a conferencia e a escrita.
 */
export async function createOrder(
  deps: AppDeps,
  input: {
    tenantId: string;
    reservationId: string;
    buyer: { name: string; phone: string; email?: string | undefined };
    /** Conta autenticada, quando houver. Nulo = compra sem conta. */
    userId?: string | null;
    /** Consentiu em receber mensagens? Decisao SEPARADA do aceite do regulamento. */
    messagingConsent?: boolean;
  },
): Promise<OrderResponse> {
  return withTenant(
    deps.pool,
    { tenantId: input.tenantId, userId: input.userId ?? null },
    async (client) => {
    const { rows: reservaRows } = await client.query<{
      id: string;
      draw_id: string;
      status: string;
      expires_at: string;
      unit_price_cents: number | null;
    }>(
      `SELECT id, draw_id, status::text AS status, expires_at, unit_price_cents
         FROM reservations WHERE id = $1 FOR UPDATE`,
      [input.reservationId],
    );
    const reserva = reservaRows[0];
    if (!reserva) throw ApiError.notFound('Reserva não encontrada.');

    if (reserva.status === 'CONVERTIDA') {
      throw ApiError.conflict('Esta reserva já virou um pedido.');
    }
    if (reserva.status !== 'ATIVA' || new Date(reserva.expires_at) <= new Date()) {
      throw ApiError.conflict('O prazo desta reserva terminou. Escolha os números novamente.');
    }

    const { rows: numeroRows } = await client.query<{ number: number }>(
      `SELECT number FROM draw_numbers
        WHERE reservation_id = $1 AND status = 'RESERVADO'
        ORDER BY number
        FOR UPDATE`,
      [input.reservationId],
    );
    if (numeroRows.length === 0) {
      throw ApiError.conflict('Os números desta reserva não estão mais disponíveis.');
    }
    const numeros = numeroRows.map((r) => r.number);

    // O preco vem da RESERVA: e o que a pessoa viu ao segurar os numeros, e uma
    // promocao que vence nos 30 minutos seguintes nao muda o total dela. Reserva
    // anterior a 0012 nao guarda preco; cai no efetivo do momento.
    let unitPriceCents = reserva.unit_price_cents;
    if (unitPriceCents === null) {
      const { rows: drawRows } = await client.query<{ unit_price_cents: number }>(
        `SELECT ${EFFECTIVE_PRICE_SQL} AS unit_price_cents FROM draws WHERE id = $1`,
        [reserva.draw_id],
      );
      unitPriceCents = drawRows[0]!.unit_price_cents;
    }

    const { rows: buyerRows } = await client.query<{ id: string }>(
      `INSERT INTO buyers (tenant_id, name, phone, email)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.tenantId, input.buyer.name.trim(), input.buyer.phone.trim(), input.buyer.email ?? null],
    );
    const buyerId = buyerRows[0]!.id;

    /**
     * `user_id` vem da SESSAO, nunca do corpo da requisicao.
     *
     * O comprador continua mandando nome, telefone e e-mail — e eles viram o
     * retrato em `buyers`, que e o historico do pedido e nao muda quando o
     * perfil mudar. Mas nada disso decide DE QUEM e o pedido: se decidisse,
     * bastaria digitar o e-mail de outra pessoa no checkout para o pedido
     * aparecer na conta dela.
     *
     * Sem sessao, fica nulo, e a compra segue sendo guest — um caminho de
     * primeira classe, nao um degrau para o cadastro.
     */
    const { rows: orderRows } = await client.query<{ id: string }>(
      `INSERT INTO orders
         (tenant_id, draw_id, buyer_id, reservation_id, unit_price_cents,
          quantity, total_cents, accepted_terms_at, user_id, messaging_consent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, CASE WHEN $9::boolean THEN now() END)
       RETURNING id`,
      [
        input.tenantId,
        reserva.draw_id,
        buyerId,
        input.reservationId,
        unitPriceCents,
        numeros.length,
        unitPriceCents * numeros.length,
        input.userId ?? null,
        input.messagingConsent === true,
      ],
    );
    const orderId = orderRows[0]!.id;

    // O preco praticado fica gravado no item: editar o sorteio amanha nao
    // reescreve o que foi vendido hoje.
    await client.query(
      `INSERT INTO order_items (tenant_id, order_id, number, unit_price_cents)
       SELECT $1, $2, n, $4 FROM unnest($3::int[]) AS n`,
      [input.tenantId, orderId, numeros, unitPriceCents],
    );

    await client.query(
      `UPDATE draw_numbers SET status = 'PENDENTE', order_id = $2
        WHERE reservation_id = $1 AND status = 'RESERVADO'`,
      [input.reservationId, orderId],
    );
    await client.query(`UPDATE reservations SET status = 'CONVERTIDA' WHERE id = $1`, [
      input.reservationId,
    ]);

    return montarPedido(client, orderId);
  });
}

export async function getOrder(
  deps: AppDeps,
  tenantId: string,
  orderId: string,
): Promise<OrderResponse> {
  return withTenant(deps.pool, { tenantId }, async (client) => montarPedido(client, orderId));
}

// ---------------------------------------------------------------------------
// Organizador
// ---------------------------------------------------------------------------

async function montarOrganizerDraw(client: PoolClient, row: DrawRow): Promise<OrganizerDraw> {
  const contagem = await contarPorEstado(client, row.id);
  const { rows: receita } = await client.query<{ total: string }>(
    // RN18: arrecadacao conta SOMENTE o que foi pago.
    `SELECT coalesce(sum(total_cents), 0)::text AS total
       FROM orders WHERE draw_id = $1 AND status = 'PAGO'`,
    [row.id],
  );

  const { rows: snapshots } = await client.query<{ sha256: string; paid_count: number; created_at: string }>(
    'SELECT sha256, paid_count, created_at FROM draw_snapshots WHERE draw_id = $1',
    [row.id],
  );
  const snapshot = snapshots[0];

  return {
    ...toSummary(row, contagem.paid),
    prizeDescription: row.prize_description,
    category: row.category,
    regulation: row.regulation,
    customization: personalizacaoResolvida(row),
    prizes: await carregarPremios(client, row.id),
    closeMode: row.close_mode,
    closeAt: row.close_at,
    salesStartAt: row.sales_start_at,
    resultSource: row.result_source,
    noWinnerPolicy: row.no_winner_policy,
    takenCount: contagem.taken,
    reservedCount: contagem.reserved,
    pendingCount: contagem.pending,
    revenueCents: Number(receita[0]!.total),
    createdAt: row.created_at,
    thresholds: row.thresholds,
    configuredPromotionalPriceCents: row.promotional_price_cents,
    configuredPromoUntil: row.promo_until,
    reviewNote: row.review_note,
    snapshot: snapshot
      ? { sha256: snapshot.sha256, paidCount: snapshot.paid_count, createdAt: snapshot.created_at }
      : null,
  };
}

export async function listOrganizerDraws(
  deps: AppDeps,
  tenantId: string,
  userId: string,
  page: { cursor: Keyset | null; limit: number },
): Promise<{ draws: OrganizerDraw[]; nextCursor: string | null }> {
  return withTenant(deps.pool, { tenantId, userId }, async (client) => {
    const { rows } = await client.query<DrawRow & { cursor_t: string }>(
      `SELECT ${DRAW_COLUMNS}, created_at::text AS cursor_t
         FROM draws
        WHERE ($1::timestamptz IS NULL OR (created_at, id) < ($1::timestamptz, $2::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [page.cursor?.t ?? null, page.cursor?.id ?? null, page.limit + 1],
    );
    const { pagina, nextCursor } = paginate(rows, page.limit, (r) => ({ t: r.cursor_t, id: r.id }));
    return { draws: await Promise.all(pagina.map((row) => montarOrganizerDraw(client, row))), nextCursor };
  });
}

export async function getOrganizerDraw(
  deps: AppDeps,
  tenantId: string,
  userId: string,
  drawId: string,
): Promise<OrganizerDraw> {
  return withTenant(deps.pool, { tenantId, userId }, async (client) => {
    const { rows } = await client.query<DrawRow>(
      `SELECT ${DRAW_COLUMNS} FROM draws WHERE id = $1`,
      [drawId],
    );
    const row = rows[0];
    if (!row) throw ApiError.notFound('Sorteio não encontrado.');
    return montarOrganizerDraw(client, row);
  });
}

/** Slug legivel a partir do titulo, com sufixo curto para evitar colisao. */
function slugify(titulo: string): string {
  const base = titulo
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const sufixo = Math.random().toString(36).slice(2, 7);
  return base.length >= 3 ? `${base}-${sufixo}` : `sorteio-${sufixo}`;
}

/** Colunas de `draws` que o organizador edita, na ordem dos parametros SQL. */
const CAMPOS_EDITAVEIS: readonly {
  chave: keyof UpdateDrawRequest;
  coluna: string;
  cast?: string;
}[] = [
  { chave: 'title', coluna: 'title' },
  { chave: 'subtitle', coluna: 'subtitle' },
  { chave: 'category', coluna: 'category' },
  { chave: 'regulation', coluna: 'regulation' },
  { chave: 'customization', coluna: 'customization', cast: 'jsonb' },
  { chave: 'description', coluna: 'description' },
  { chave: 'ticketPriceCents', coluna: 'ticket_price_cents' },
  { chave: 'promotionalPriceCents', coluna: 'promotional_price_cents' },
  { chave: 'promoUntil', coluna: 'promo_until', cast: 'timestamptz' },
  { chave: 'totalNumbers', coluna: 'total_numbers' },
  { chave: 'drawDate', coluna: 'draw_date', cast: 'timestamptz' },
  { chave: 'salesStartAt', coluna: 'sales_start_at', cast: 'timestamptz' },
  { chave: 'closeMode', coluna: 'close_mode', cast: 'draw_close_mode' },
  { chave: 'closeAt', coluna: 'close_at', cast: 'timestamptz' },
  { chave: 'thresholds', coluna: 'thresholds', cast: 'int[]' },
  { chave: 'noWinnerPolicy', coluna: 'no_winner_policy' },
];

/**
 * Grava os premios de um sorteio em RASCUNHO, substituindo os anteriores.
 *
 * A posicao vem da ORDEM da lista (1 = premio principal). O premio principal
 * tambem e espelhado nas colunas antigas de `draws` (`prize_name`, ...) enquanto
 * elas existirem — a versao anterior da API e a listagem leem dali.
 */
async function gravarPremios(
  client: PoolClient,
  tenantId: string,
  drawId: string,
  prizes: NonNullable<CreateDrawRequest['prizes']>,
): Promise<void> {
  await client.query('DELETE FROM prizes WHERE draw_id = $1', [drawId]);
  await client.query(
    `INSERT INTO prizes (tenant_id, draw_id, position, name, description, image_url, estimated_value_cents)
     SELECT $1, $2, p.pos, p.name, p.description, p.image_url, p.estimated
       FROM unnest($3::int[], $4::text[], $5::text[], $6::text[], $7::int[])
            AS p(pos, name, description, image_url, estimated)`,
    [
      tenantId,
      drawId,
      prizes.map((_, i) => i + 1),
      prizes.map((p) => p.name.trim()),
      prizes.map((p) => p.description ?? null),
      prizes.map((p) => p.imageUrl ?? null),
      prizes.map((p) => p.estimatedValueCents ?? null),
    ],
  );
  const principal = prizes[0]!;
  await client.query(
    `UPDATE draws SET prize_name = $2, prize_description = $3, prize_image_url = $4
      WHERE id = $1`,
    [drawId, principal.name.trim(), principal.description ?? null, principal.imageUrl ?? null],
  );
}

export async function createDraw(
  deps: AppDeps,
  input: {
    tenantId: string;
    userId: string;
    data: CreateDrawRequest;
    origin?: ActionOrigin | undefined;
  },
): Promise<OrganizerDraw> {
  return withTenant(deps.pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
    const { data } = input;
    try {
      const principal = data.prizes[0]!;
      const { rows } = await client.query<DrawRow>(
        `INSERT INTO draws
           (tenant_id, slug, title, description, prize_name, prize_description,
            prize_image_url, ticket_price_cents, promotional_price_cents, promo_until,
            total_numbers, draw_date, sales_start_at, close_mode, close_at, thresholds,
            no_winner_policy, subtitle, category, regulation, customization)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11,
                 $12::timestamptz, $13::timestamptz,
                 COALESCE($14::draw_close_mode, 'AO_ESGOTAR'), $15::timestamptz,
                 COALESCE($16::int[], '{25,10}'),
                 COALESCE($17, 'PROXIMO_VENDIDO_ACIMA'),
                 $18, $19, $20, $21::jsonb)
         RETURNING ${DRAW_COLUMNS}`,
        [
          input.tenantId,
          slugify(data.title),
          data.title.trim(),
          data.description ?? null,
          principal.name.trim(),
          principal.description ?? null,
          principal.imageUrl ?? null,
          data.ticketPriceCents,
          data.promotionalPriceCents ?? null,
          data.promoUntil ?? null,
          data.totalNumbers,
          data.drawDate ?? null,
          data.salesStartAt ?? null,
          data.closeMode ?? null,
          data.closeAt ?? null,
          data.thresholds ?? null,
          data.noWinnerPolicy ?? null,
          data.subtitle ?? null,
          data.category ?? null,
          semBrancos(data.regulation),
          JSON.stringify(data.customization ?? {}),
        ],
      );
      const criado = rows[0]!;
      await gravarPremios(client, input.tenantId, criado.id, data.prizes);

      await recordAuditEvent(client, {
        tenantId: input.tenantId,
        actorUserId: input.userId,
        action: 'draw.created',
        targetType: 'draw',
        targetId: criado.id,
        after: {
          status: criado.status,
          totalNumbers: criado.total_numbers,
          ticketPriceCents: criado.ticket_price_cents,
          prizeCount: data.prizes.length,
        },
        ip: input.origin?.ip ?? null,
        userAgent: input.origin?.userAgent ?? null,
      });
      return montarOrganizerDraw(client, criado);
    } catch (error) {
      // A constraint e a autoridade; a corrida de slug e conflito, nao falha.
      if (isUniqueViolation(error, 'draws_tenant_slug_key')) {
        throw ApiError.conflict('Já existe um sorteio com esse endereço. Tente outro título.');
      }
      throw error;
    }
  });
}

/**
 * Edita um sorteio em RASCUNHO.
 *
 * So o rascunho e editavel: depois do envio para revisao o que a plataforma
 * aprovou e o que foi enviado, e alterar por baixo dos panos anularia a revisao.
 * (Depois da primeira reserva, o banco ainda barra grade e preco base — RN14 —
 * como ultima defesa.)
 *
 * As regras entre campos sao conferidas sobre o estado JA MESCLADO: mandar so o
 * prazo da promocao so faz sentido diante do preco promocional que ja existe.
 */
export async function updateDraw(
  deps: AppDeps,
  input: {
    tenantId: string;
    userId: string;
    drawId: string;
    data: UpdateDrawRequest;
    origin?: ActionOrigin | undefined;
  },
): Promise<OrganizerDraw> {
  return withTenant(deps.pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
    const { rows } = await client.query<DrawRow>(
      `SELECT ${DRAW_COLUMNS} FROM draws WHERE id = $1 FOR UPDATE`,
      [input.drawId],
    );
    const atual = rows[0];
    if (!atual) throw ApiError.notFound('Sorteio não encontrado.');
    if (atual.status !== 'RASCUNHO') {
      throw ApiError.conflict(
        `Só é possível editar um sorteio em rascunho (este está em "${atual.status}").`,
      );
    }

    const { data } = input;
    const tem = (chave: keyof UpdateDrawRequest) => Object.prototype.hasOwnProperty.call(data, chave);

    const problemas = validateDrawRules({
      ticketPriceCents: tem('ticketPriceCents') ? data.ticketPriceCents : atual.ticket_price_cents,
      promotionalPriceCents: tem('promotionalPriceCents')
        ? data.promotionalPriceCents
        : atual.promotional_price_cents,
      promoUntil: tem('promoUntil') ? data.promoUntil : atual.promo_until,
      drawDate: tem('drawDate') ? data.drawDate : atual.draw_date,
      salesStartAt: tem('salesStartAt') ? data.salesStartAt : atual.sales_start_at,
      closeAt: tem('closeAt') ? data.closeAt : atual.close_at,
    });
    if (data.thresholds?.some((x, i) => i > 0 && x >= data.thresholds![i - 1]!)) {
      problemas.push('Os limiares precisam estar em ordem decrescente.');
    }
    if (problemas.length > 0) throw ApiError.badRequest(problemas.join(' '), { problems: problemas });

    const sets: string[] = [];
    const valores: unknown[] = [input.drawId];
    for (const campo of CAMPOS_EDITAVEIS) {
      if (!tem(campo.chave)) continue;
      const valor = data[campo.chave];
      if (campo.chave === 'regulation') {
        valores.push(semBrancos(valor as string | null | undefined));
      } else if (campo.chave === 'customization') {
        // `null` volta tudo ao padrao; o objeto SUBSTITUI o anterior (nao ha mescla em silencio).
        valores.push(JSON.stringify(valor ?? {}));
      } else {
        valores.push(campo.chave === 'title' && typeof valor === 'string' ? valor.trim() : (valor ?? null));
      }
      sets.push(`${campo.coluna} = $${valores.length}${campo.cast ? `::${campo.cast}` : ''}`);
    }
    if (sets.length > 0) {
      await client.query(`UPDATE draws SET ${sets.join(', ')} WHERE id = $1`, valores);
    }
    if (data.prizes) await gravarPremios(client, input.tenantId, input.drawId, data.prizes);

    await recordAuditEvent(client, {
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'draw.updated',
      targetType: 'draw',
      targetId: input.drawId,
      after: { changed: Object.keys(data) },
      ip: input.origin?.ip ?? null,
      userAgent: input.origin?.userAgent ?? null,
    });

    const { rows: depois } = await client.query<DrawRow>(
      `SELECT ${DRAW_COLUMNS} FROM draws WHERE id = $1`,
      [input.drawId],
    );
    return montarOrganizerDraw(client, depois[0]!);
  });
}

export interface TransitionInput {
  drawId: string;
  to: DrawStatus;
  actor: { userId: string; kind: 'USER' | 'PLATFORM' };
  reason?: string | null | undefined;
  origin?: ActionOrigin | undefined;
  /**
   * APURAÇÃO -> RESULTADO PUBLICADO so acontece publicando um resultado (com a
   * prova). Nao ha botao de status para isso: o servico de resultado liga esta
   * marca, e nenhuma rota de status a liga.
   */
  allowResultPublication?: boolean | undefined;
}

/**
 * A UNICA porta de mudanca de estado do sorteio. RN02, RN11.
 *
 * Roda dentro da transacao do chamador. Trava a linha (`FOR UPDATE`), confere o
 * estado ATUAL, aplica a regra de QUEM pode, muda o estado e — na mesma
 * transacao — grava a auditoria e publica os eventos na outbox. Se qualquer
 * passo falhar, nada disso existe.
 *
 * As tabelas de transicao vem do `shared`. Esta funcao nao guarda lista propria:
 * duas fontes de verdade foi exatamente o que deixou RASCUNHO ir direto a ATIVA.
 */
export async function transitionDrawStatus(
  client: PoolClient,
  input: TransitionInput,
): Promise<DrawRow> {
  const { rows } = await client.query<DrawRow & { tenant_id: string }>(
    `SELECT ${DRAW_COLUMNS} FROM draws WHERE id = $1 FOR UPDATE`,
    [input.drawId],
  );
  const atual = rows[0];
  if (!atual) throw ApiError.notFound('Sorteio não encontrado.');

  const de = atual.status;
  const para = input.to;

  // RN22: bloqueado para todos ate existir reembolso.
  if (DRAW_STATUSES_BLOCKED_UNTIL_REFUND.includes(para)) {
    throw ApiError.conflict(
      'O cancelamento de sorteio está bloqueado até existir reembolso dos pagamentos (RN22).',
    );
  }

  if (!isDrawStatus(de)) throw ApiError.conflict(`Estado desconhecido no sorteio: "${de}".`);

  // A maquina completa do DOC-01: o que ela nao permite ninguem faz.
  if (!DRAW_STATUS_TRANSITIONS[de].includes(para)) {
    throw ApiError.conflict(`Um sorteio em "${de}" não pode ir para "${para}".`);
  }

  // Quem aperta o botao.
  const permitidoAoAtor =
    input.actor.kind === 'PLATFORM'
      ? de === 'REVISÃO COMPLIANCE' &&
        (PLATFORM_REVIEW_DECISIONS as readonly string[]).includes(para)
      : (ORGANIZER_DRAW_TRANSITIONS[de] ?? []).includes(para) ||
        (input.allowResultPublication === true &&
          de === 'APURAÇÃO' &&
          para === 'RESULTADO PUBLICADO');
  if (!permitidoAoAtor) {
    throw input.actor.kind === 'USER' && de === 'REVISÃO COMPLIANCE'
      ? ApiError.forbidden('Somente a equipe da plataforma decide sobre um sorteio em revisão.')
      : ApiError.conflict(`Um sorteio em "${de}" não pode ir para "${para}" por esta via.`);
  }

  if (de === 'REVISÃO COMPLIANCE' && para === 'RASCUNHO' && !input.reason?.trim()) {
    throw ApiError.badRequest('Informe o motivo da reprovação.');
  }

  // DOC-01 §15: so arquiva com a entrega registrada. O banco tambem recusa (gatilho);
  // aqui o motivo chega ao organizador como orientacao, nao como erro generico.
  if (para === 'ARQUIVADA') {
    const { rows: entrega } = await client.query('SELECT 1 FROM draw_deliveries WHERE draw_id = $1', [
      input.drawId,
    ]);
    if (entrega.length === 0) {
      throw ApiError.conflict('Registre a entrega do prêmio antes de arquivar o sorteio.');
    }
  }

  // Checklist do envio (DOC-01 §4, ultimo passo): so vai para revisao o sorteio
  // COMPLETO. O rascunho e salvo a cada passo do assistente, entao o banco nao
  // pode exigir tudo de uma vez — a exigencia mora aqui.
  if (de === 'RASCUNHO' && para === 'REVISÃO COMPLIANCE') {
    const premios = await carregarPremios(client, input.drawId);
    const problemas = drawReadinessProblems({
      title: atual.title,
      regulation: atual.regulation,
      prizes: premios,
      ticketPriceCents: atual.ticket_price_cents,
      promotionalPriceCents: atual.promotional_price_cents,
      promoUntil: atual.promo_until,
      drawDate: atual.draw_date,
      salesStartAt: atual.sales_start_at,
      closeMode: atual.close_mode,
      closeAt: atual.close_at,
    });
    if (problemas.length > 0) {
      throw ApiError.badRequest(`O sorteio ainda não pode ir para revisão. ${problemas.join(' ')}`, {
        problems: problemas,
      });
    }
  }

  // `AND status = $3`: o FOR UPDATE ja garante, e a condicao deixa a regra
  // visivel no proprio UPDATE — uma mudanca concorrente nunca passa em silencio.
  // O motivo da reprovacao fica no sorteio para o organizador ler; some quando o
  // sorteio e reenviado ou aprovado. A trilha de auditoria guarda o historico.
  const tocaRevisao = de === 'REVISÃO COMPLIANCE' || para === 'REVISÃO COMPLIANCE';
  // O envio para revisao passa pelo gatilho comercial do banco (limite do plano), na MESMA
  // transacao deste UPDATE; a recusa vira erro do contrato.
  const { rows: atualizados } = await withEntitlementErrors(() =>
    client.query<DrawRow>(
    `UPDATE draws
        SET status = $2::draw_status,
            review_note = CASE WHEN $4::boolean THEN $5 ELSE review_note END,
            reviewed_at = CASE WHEN $4::boolean AND $6::boolean THEN now() ELSE reviewed_at END
      WHERE id = $1 AND status = $3::draw_status
      RETURNING ${DRAW_COLUMNS}`,
    [
      input.drawId,
      para,
      de,
      tocaRevisao,
      de === 'REVISÃO COMPLIANCE' && para === 'RASCUNHO' ? input.reason?.trim() || null : null,
      de === 'REVISÃO COMPLIANCE',
    ],
    ),
  );
  const novo = atualizados[0];
  if (!novo) {
    throw ApiError.conflict('O sorteio mudou de estado. Atualize a página e tente de novo.');
  }

  const motivo = input.reason?.trim() || null;
  await recordAuditEvent(client, {
    tenantId: atual.tenant_id,
    actorUserId: input.actor.userId,
    actorType: input.actor.kind,
    action: 'draw.status_changed',
    targetType: 'draw',
    targetId: input.drawId,
    before: { status: de },
    after: { status: para, reason: motivo },
    ip: input.origin?.ip ?? null,
    userAgent: input.origin?.userAgent ?? null,
  });

  for (const eventType of drawTransitionEvents(de, para)) {
    await enqueueOutboxEvent(client, {
      tenantId: atual.tenant_id,
      eventType,
      payload: {
        tenantId: atual.tenant_id,
        drawId: input.drawId,
        from: de,
        to: para,
        actorUserId: input.actor.userId,
        actorType: input.actor.kind,
        reason: motivo,
      },
    });
  }

  return novo;
}

/** Organizador: envia para revisao, pausa, retoma ou encerra as vendas. */
export async function updateDrawStatus(
  deps: AppDeps,
  input: {
    tenantId: string;
    userId: string;
    drawId: string;
    status: string;
    origin?: ActionOrigin | undefined;
  },
): Promise<OrganizerDraw> {
  if (!isDrawStatus(input.status)) throw ApiError.badRequest('Estado inválido.');
  const to = input.status;

  return withTenant(deps.pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
    const novo = await transitionDrawStatus(client, {
      drawId: input.drawId,
      to,
      actor: { userId: input.userId, kind: 'USER' },
      origin: input.origin,
    });
    return montarOrganizerDraw(client, novo);
  });
}

/**
 * Super Admin: decide sobre um sorteio em REVISAO COMPLIANCE. RN02.
 *
 * Duas transacoes, de proposito. A primeira, de plataforma, so descobre a
 * comunidade do sorteio (a RLS de SELECT libera). A segunda abre o contexto
 * dessa comunidade COM acesso de plataforma, e ai a linha e travada e o estado
 * conferido de novo — a leitura da primeira nao vale como verificacao.
 */
export async function reviewDraw(
  deps: AppDeps,
  input: {
    userId: string;
    drawId: string;
    to: DrawStatus;
    reason?: string | undefined;
    origin?: ActionOrigin | undefined;
  },
): Promise<OrganizerDraw> {
  const tenantId = await withPlatform(deps.pool, { userId: input.userId }, async (client) => {
    const { rows } = await client.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM draws WHERE id = $1',
      [input.drawId],
    );
    return rows[0]?.tenant_id ?? null;
  });
  if (!tenantId) throw ApiError.notFound('Sorteio não encontrado.');

  return withContext(
    deps.pool,
    { userId: input.userId, tenantId, platformAccess: true },
    async (client) => {
      const novo = await transitionDrawStatus(client, {
        drawId: input.drawId,
        to: input.to,
        actor: { userId: input.userId, kind: 'PLATFORM' },
        reason: input.reason,
        origin: input.origin,
      });
      return montarOrganizerDraw(client, novo);
    },
  );
}

/** Fila do Super Admin: sorteios aguardando revisao, de todas as comunidades. Mais antigo primeiro. */
export async function listReviewQueue(
  deps: AppDeps,
  userId: string,
  page: { cursor: Keyset | null; limit: number },
): Promise<ReviewQueueResponse> {
  return withPlatform(deps.pool, { userId }, async (client) => {
    const { rows } = await client.query<
      DrawRow & {
        tenant_slug: string;
        tenant_name: string;
        cursor_t: string;
        tenant_id: string;
        updated_at: string;
      }
    >(
      `SELECT d.*, t.slug AS tenant_slug, t.name AS tenant_name,
              d.updated_at::text AS cursor_t
         FROM draws d
         JOIN tenants t ON t.id = d.tenant_id
        WHERE d.status = 'REVISÃO COMPLIANCE'
          AND ($1::timestamptz IS NULL OR (d.updated_at, d.id) > ($1::timestamptz, $2::uuid))
        ORDER BY d.updated_at ASC, d.id ASC
        LIMIT $3`,
      [page.cursor?.t ?? null, page.cursor?.id ?? null, page.limit + 1],
    );
    const { pagina, nextCursor } = paginate(rows, page.limit, (r) => ({ t: r.cursor_t, id: r.id }));
    const draws = [];
    for (const r of pagina) {
      draws.push({
        id: r.id,
        title: r.title,
        prizeName: r.prize_name,
        unitPriceCents: r.ticket_price_cents,
        totalNumbers: r.total_numbers,
        drawDate: r.draw_date,
        createdAt: r.created_at,
        tenantId: r.tenant_id,
        tenantSlug: r.tenant_slug,
        tenantName: r.tenant_name,
        subtitle: r.subtitle,
        category: r.category,
        description: r.description,
        regulation: r.regulation,
        prizes: await carregarPremios(client, r.id),
        salesStartAt: r.sales_start_at,
        closeMode: r.close_mode,
        closeAt: r.close_at,
        noWinnerPolicy: r.no_winner_policy,
        thresholds: r.thresholds,
        customization: personalizacaoResolvida(r),
        submittedAt: r.updated_at,
      });
    }
    return { nextCursor, draws };
  });
}
