import { withTenant, type PoolClient } from '@campaigns/db';
import {
  RESERVATION_TTL_MINUTES,
  labelDigitsForGridSize,
  type CreateDrawRequest,
  type DrawNumbersResponse,
  type OrderResponse,
  type OrganizerDraw,
  type PublicDrawDetail,
  type PublicDrawSummary,
  type ReservationResponse,
} from '@campaigns/shared';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';
import { isUniqueViolation } from '../../lib/pgError.js';

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
  description: string | null;
  prize_name: string;
  prize_description: string | null;
  prize_image_url: string | null;
  unit_price_cents: number;
  total_numbers: number;
  status: string;
  draw_date: string | null;
  created_at: string;
}

/** Estados em que a vitrine mostra o sorteio. RASCUNHO nao aparece ao publico. */
const STATUS_VISIVEL_NA_VITRINE = ['ATIVA', 'PAUSADA', 'VENDAS ENCERRADAS'];

/** Somente ATIVA aceita reserva nova. */
const STATUS_QUE_VENDE = 'ATIVA';

function toSummary(row: DrawRow, paidCount: number): PublicDrawSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    prizeName: row.prize_name,
    prizeImageUrl: row.prize_image_url,
    unitPriceCents: row.unit_price_cents,
    totalNumbers: row.total_numbers,
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
): Promise<PublicDrawSummary[]> {
  return withTenant(deps.pool, { tenantId }, async (client) => {
    const { rows } = await client.query<DrawRow & { paid_count: string }>(
      `SELECT d.*,
              (SELECT count(*) FROM draw_numbers n
                WHERE n.draw_id = d.id AND n.status = 'PAGO')::text AS paid_count
         FROM draws d
        WHERE d.status = ANY($1::draw_status[])
        ORDER BY
          -- Sorteio que esta vendendo vem primeiro: e o que a pessoa veio ver.
          CASE WHEN d.status = 'ATIVA' THEN 0 ELSE 1 END,
          d.created_at DESC`,
      [STATUS_VISIVEL_NA_VITRINE],
    );
    return rows.map((row) => toSummary(row, Number(row.paid_count)));
  });
}

export async function getPublicDraw(
  deps: AppDeps,
  tenantId: string,
  slug: string,
): Promise<PublicDrawDetail> {
  return withTenant(deps.pool, { tenantId }, async (client) => {
    const { rows } = await client.query<DrawRow>(
      `SELECT * FROM draws WHERE slug = $1 AND status = ANY($2::draw_status[])`,
      [slug, STATUS_VISIVEL_NA_VITRINE],
    );
    const row = rows[0];
    if (!row) throw ApiError.notFound('Sorteio não encontrado.');

    const contagem = await contarPorEstado(client, row.id);
    return {
      ...toSummary(row, contagem.paid),
      prizeDescription: row.prize_description,
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
    }>(
      // `FOR SHARE`: impede que o sorteio seja pausado no meio desta reserva.
      `SELECT id, total_numbers, unit_price_cents, status
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

    const expiresAt = new Date(Date.now() + RESERVATION_TTL_MINUTES * 60_000);

    const { rows: reservaRows } = await client.query<{ id: string }>(
      `INSERT INTO reservations (tenant_id, draw_id, expires_at)
       VALUES ($1, $2, $3) RETURNING id`,
      [input.tenantId, input.drawId, expiresAt.toISOString()],
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

async function montarPedido(client: PoolClient, orderId: string): Promise<OrderResponse> {
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
    }>(
      `SELECT id, draw_id, status::text AS status, expires_at
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

    const { rows: drawRows } = await client.query<{ unit_price_cents: number }>(
      'SELECT unit_price_cents FROM draws WHERE id = $1',
      [reserva.draw_id],
    );
    const unitPriceCents = drawRows[0]!.unit_price_cents;

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
          quantity, total_cents, accepted_terms_at, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)
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

/**
 * Confirmacao de pagamento SEM provedor — desenvolvimento apenas.
 *
 * A recusa em producao acontece na ROTA, antes daqui. Este servico assume que a
 * decisao ja foi tomada e cuida apenas de fazer a mudanca inteira numa unica
 * transacao: pedido e numeros mudam juntos ou nao mudam. Um pedido PAGO com
 * numeros PENDENTE seria dinheiro recebido sem numero entregue.
 */
export async function devConfirmPayment(
  deps: AppDeps,
  tenantId: string,
  orderId: string,
): Promise<OrderResponse> {
  return withTenant(deps.pool, { tenantId }, async (client) => {
    const { rows } = await client.query<{ status: string }>(
      `SELECT status::text AS status FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    const pedido = rows[0];
    if (!pedido) throw ApiError.notFound('Pedido não encontrado.');

    // Idempotente: confirmar duas vezes devolve o mesmo comprovante em vez de
    // erro. Um botao clicado duas vezes nao e um caso excepcional.
    if (pedido.status === 'PAGO') return montarPedido(client, orderId);
    if (pedido.status === 'CANCELADO') {
      throw ApiError.conflict('Este pedido foi cancelado.');
    }

    await client.query(
      `UPDATE orders SET status = 'PAGO', paid_at = now() WHERE id = $1`,
      [orderId],
    );
    await client.query(
      `UPDATE draw_numbers SET status = 'PAGO', expires_at = NULL
        WHERE order_id = $1 AND status = 'PENDENTE'`,
      [orderId],
    );

    return montarPedido(client, orderId);
  });
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

  return {
    ...toSummary(row, contagem.paid),
    prizeDescription: row.prize_description,
    takenCount: contagem.taken,
    reservedCount: contagem.reserved,
    pendingCount: contagem.pending,
    revenueCents: Number(receita[0]!.total),
    createdAt: row.created_at,
  };
}

export async function listOrganizerDraws(
  deps: AppDeps,
  tenantId: string,
  userId: string,
): Promise<OrganizerDraw[]> {
  return withTenant(deps.pool, { tenantId, userId }, async (client) => {
    const { rows } = await client.query<DrawRow>(
      'SELECT * FROM draws ORDER BY created_at DESC LIMIT 200',
    );
    return Promise.all(rows.map((row) => montarOrganizerDraw(client, row)));
  });
}

export async function getOrganizerDraw(
  deps: AppDeps,
  tenantId: string,
  userId: string,
  drawId: string,
): Promise<OrganizerDraw> {
  return withTenant(deps.pool, { tenantId, userId }, async (client) => {
    const { rows } = await client.query<DrawRow>('SELECT * FROM draws WHERE id = $1', [drawId]);
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

export async function createDraw(
  deps: AppDeps,
  input: { tenantId: string; userId: string; data: CreateDrawRequest },
): Promise<OrganizerDraw> {
  return withTenant(deps.pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
    const { data } = input;
    try {
      const { rows } = await client.query<DrawRow>(
        `INSERT INTO draws
           (tenant_id, slug, title, description, prize_name, prize_description,
            prize_image_url, unit_price_cents, total_numbers, draw_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          input.tenantId,
          slugify(data.title),
          data.title.trim(),
          data.description ?? null,
          data.prizeName.trim(),
          data.prizeDescription ?? null,
          data.prizeImageUrl ?? null,
          data.unitPriceCents,
          data.totalNumbers,
          data.drawDate ?? null,
        ],
      );
      return montarOrganizerDraw(client, rows[0]!);
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
 * Transicoes desta fatia. A maquina completa e do DOC-01 §7 e pertence a uma
 * fase propria; o que existe aqui e o subconjunto que as vendas exigem.
 *
 * Declarar as transicoes permitidas, em vez de aceitar qualquer destino, impede
 * que um sorteio volte de VENDAS ENCERRADAS para ATIVA e reabra a venda de uma
 * grade ja fechada.
 */
const TRANSICOES_PERMITIDAS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  RASCUNHO: ['ATIVA'],
  ATIVA: ['PAUSADA', 'VENDAS ENCERRADAS'],
  PAUSADA: ['ATIVA', 'VENDAS ENCERRADAS'],
  'VENDAS ENCERRADAS': [],
});

export async function updateDrawStatus(
  deps: AppDeps,
  input: { tenantId: string; userId: string; drawId: string; status: string },
): Promise<OrganizerDraw> {
  return withTenant(deps.pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
    const { rows } = await client.query<DrawRow>(
      'SELECT * FROM draws WHERE id = $1 FOR UPDATE',
      [input.drawId],
    );
    const atual = rows[0];
    if (!atual) throw ApiError.notFound('Sorteio não encontrado.');

    const permitidas = TRANSICOES_PERMITIDAS[atual.status] ?? [];
    if (!permitidas.includes(input.status)) {
      throw ApiError.conflict(
        `Um sorteio em "${atual.status}" não pode ir para "${input.status}".`,
      );
    }

    const { rows: atualizados } = await client.query<DrawRow>(
      'UPDATE draws SET status = $2::draw_status WHERE id = $1 RETURNING *',
      [input.drawId, input.status],
    );
    return montarOrganizerDraw(client, atualizados[0]!);
  });
}
