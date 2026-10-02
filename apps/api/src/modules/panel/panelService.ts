import { withTenant, type PoolClient } from '@clubedarifa/db';
import { maskName } from '@clubedarifa/logging';
import {
  DRAW_STATUSES,
  formatNumberLabel,
  type DashboardResponse,
  type DrawOrder,
  type DrawOrdersResponse,
  type ExportOrdersResponse,
} from '@clubedarifa/shared';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';
import { paginate, type Keyset } from '../../lib/cursor.js';
import { recordAuditEvent } from '../audit/auditService.js';
import type { ActionOrigin } from '../draws/drawService.js';

/**
 * Painel do organizador: indicadores e pedidos de um sorteio.
 *
 * Duas separacoes de direito atravessam este arquivo (DOC-01 secao 3):
 *  - VALORES (arrecadado, receita por dia, estornos) so com `payment:read:full`;
 *  - CONTATO do comprador (nome inteiro, telefone, e-mail) so com `buyer:read:full`.
 * Quem so tem `payment:read:status` ve o estado do pedido e um nome mascarado.
 */

const FUSO = 'America/Sao_Paulo';

export async function getDashboard(
  deps: AppDeps,
  input: { tenantId: string; userId: string; canSeeMoney: boolean },
): Promise<DashboardResponse> {
  return withTenant(deps.pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
    const { rows: porEstado } = await client.query<{ status: string; n: number }>(
      'SELECT status::text AS status, count(*)::int AS n FROM draws GROUP BY status',
    );
    // Todos os estados aparecem, com zero: a tela nao precisa adivinhar o que falta.
    const drawsByStatus = Object.fromEntries(DRAW_STATUSES.map((s) => [s, 0])) as Record<
      (typeof DRAW_STATUSES)[number],
      number
    >;
    for (const r of porEstado) drawsByStatus[r.status as (typeof DRAW_STATUSES)[number]] = r.n;

    // RN18: vendido = PAGO. Reserva e pendencia nunca entram.
    const { rows: vendidos } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM draw_numbers WHERE status = 'PAGO'",
    );
    const { rows: receita } = await client.query<{ total: string }>(
      "SELECT COALESCE(sum(total_cents), 0)::text AS total FROM orders WHERE status = 'PAGO'",
    );
    const { rows: reservas } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM draw_numbers WHERE status = 'RESERVADO' AND expires_at > now()",
    );
    const { rows: pix } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM orders o
        WHERE o.status = 'PENDENTE'
          AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'PENDENTE')`,
    );
    const { rows: estornos } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM payments WHERE needs_manual_refund AND status <> 'ESTORNADO'",
    );

    // 30 dias SEM buracos: generate_series + LEFT JOIN, no fuso do Brasil.
    const { rows: dias } = await client.query<{ date: string; paid_numbers: number; revenue: string }>(
      `WITH dias AS (
         SELECT d::date AS dia
           FROM generate_series(
                  (now() AT TIME ZONE '${FUSO}')::date - 29,
                  (now() AT TIME ZONE '${FUSO}')::date,
                  interval '1 day') AS d
       ), vendas AS (
         SELECT (paid_at AT TIME ZONE '${FUSO}')::date AS dia,
                sum(quantity)::int AS n, sum(total_cents) AS receita
           FROM orders
          WHERE status = 'PAGO' AND paid_at >= now() - interval '31 days'
          GROUP BY 1
       )
       SELECT to_char(dias.dia, 'YYYY-MM-DD') AS date,
              COALESCE(vendas.n, 0) AS paid_numbers,
              COALESCE(vendas.receita, 0)::text AS revenue
         FROM dias LEFT JOIN vendas ON vendas.dia = dias.dia
        ORDER BY dias.dia`,
    );

    return {
      generatedAt: new Date().toISOString(),
      drawsByStatus,
      soldNumbers: vendidos[0]!.n,
      revenueCents: input.canSeeMoney ? Number(receita[0]!.total) : null,
      activeReservations: reservas[0]!.n,
      pendingPix: pix[0]!.n,
      manualRefunds: input.canSeeMoney ? estornos[0]!.n : null,
      salesByDay: dias.map((d) => ({
        date: d.date,
        paidNumbers: d.paid_numbers,
        revenueCents: input.canSeeMoney ? Number(d.revenue) : null,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Pedidos de um sorteio
// ---------------------------------------------------------------------------

interface OrderRow {
  id: string;
  status: DrawOrder['status'];
  created_at: string;
  cursor_t: string;
  paid_at: string | null;
  quantity: number;
  total_cents: number;
  numbers: number[] | null;
  buyer_name: string;
  buyer_phone: string;
  buyer_email: string | null;
  pay_status: DrawOrder['paymentStatus'];
  needs_manual_refund: boolean | null;
}

async function pedidosDoSorteio(
  client: PoolClient,
  input: { drawId: string; cursor: Keyset | null; limit: number },
): Promise<OrderRow[]> {
  const { rows } = await client.query<OrderRow>(
    `SELECT o.id, o.status::text AS status, o.created_at, o.created_at::text AS cursor_t, o.paid_at,
            o.quantity, o.total_cents,
            (SELECT array_agg(i.number ORDER BY i.number) FROM order_items i WHERE i.order_id = o.id) AS numbers,
            b.name AS buyer_name, b.phone AS buyer_phone, b.email AS buyer_email,
            p.status::text AS pay_status, p.needs_manual_refund
       FROM orders o
       JOIN buyers b ON b.id = o.buyer_id
       LEFT JOIN LATERAL (
         SELECT status, needs_manual_refund FROM payments
          WHERE order_id = o.id ORDER BY created_at DESC LIMIT 1
       ) p ON true
      WHERE o.draw_id = $1
        AND ($2::timestamptz IS NULL OR (o.created_at, o.id) < ($2::timestamptz, $3::uuid))
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $4`,
    [input.drawId, input.cursor?.t ?? null, input.cursor?.id ?? null, input.limit],
  );
  return rows;
}

function toDrawOrder(r: OrderRow, contactVisible: boolean): DrawOrder {
  return {
    orderId: r.id,
    status: r.status,
    createdAt: r.created_at,
    paidAt: r.paid_at,
    quantity: r.quantity,
    totalCents: r.total_cents,
    numbers: r.numbers ?? [],
    // Sem `buyer:read:full`: nome mascarado e nenhum contato.
    buyerName: contactVisible ? r.buyer_name : maskName(r.buyer_name),
    buyerPhone: contactVisible ? r.buyer_phone : null,
    buyerEmail: contactVisible ? r.buyer_email : null,
    paymentStatus: r.pay_status,
    needsManualRefund: r.needs_manual_refund === true,
  };
}

async function garantirSorteio(client: PoolClient, drawId: string) {
  const { rows } = await client.query<{ id: string; slug: string; label_digits: 2 | 3 }>(
    'SELECT id, slug, label_digits FROM draws WHERE id = $1',
    [drawId],
  );
  if (!rows[0]) throw ApiError.notFound('Sorteio não encontrado.');
  return rows[0];
}

export async function listDrawOrders(
  deps: AppDeps,
  input: {
    tenantId: string;
    userId: string;
    drawId: string;
    cursor: Keyset | null;
    limit: number;
    contactVisible: boolean;
  },
): Promise<DrawOrdersResponse> {
  return withTenant(deps.pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
    await garantirSorteio(client, input.drawId);
    const linhas = await pedidosDoSorteio(client, {
      drawId: input.drawId,
      cursor: input.cursor,
      limit: input.limit + 1,
    });
    const { pagina, nextCursor } = paginate(linhas, input.limit, (r) => ({ t: r.cursor_t, id: r.id }));
    return {
      orders: pagina.map((r) => toDrawOrder(r, input.contactVisible)),
      nextCursor,
      contactVisible: input.contactVisible,
    };
  });
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const LIMITE_EXPORTACAO = 50_000;

/** Marca de ordem de bytes UTF-8: o Excel abre o CSV com os acentos certos. */
const BOM = String.fromCharCode(0xfeff);

/**
 * Escapa uma celula de CSV.
 *
 * DOIS cuidados, e o segundo e o que costuma faltar:
 *  1. aspas, virgula e quebra de linha: envolve em aspas e dobra as aspas;
 *  2. INJECAO DE FORMULA: uma celula que comeca com `=`, `+`, `-`, `@`, tab ou CR e
 *     interpretada como formula pelo Excel e pelo Planilhas. O nome do comprador
 *     vem de um formulario PUBLICO — `=HYPERLINK(...)` como nome viraria ataque a
 *     quem abre o arquivo. Prefixar com apostrofo neutraliza sem alterar o texto
 *     visivel.
 */
export function csvCell(valor: unknown): string {
  let texto = valor === null || valor === undefined ? '' : String(valor);
  if (/^[=+\-@\t\r]/.test(texto)) texto = `'${texto}`;
  return /[",\n\r;]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

export async function exportDrawOrders(
  deps: AppDeps,
  input: { tenantId: string; userId: string; drawId: string; origin?: ActionOrigin | undefined },
): Promise<ExportOrdersResponse> {
  return withTenant(deps.pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
    const draw = await garantirSorteio(client, input.drawId);

    const cabecalho = [
      'pedido', 'status', 'criado_em', 'pago_em', 'quantidade', 'total_reais', 'numeros',
      'nome', 'telefone', 'email', 'status_pagamento', 'estorno_manual',
    ];
    const linhas: string[] = [cabecalho.join(',')];

    let cursor: Keyset | null = null;
    let total = 0;
    for (;;) {
      const pagina = await pedidosDoSorteio(client, { drawId: draw.id, cursor, limit: 500 });
      for (const r of pagina) {
        linhas.push(
          [
            r.id,
            r.status,
            r.created_at,
            r.paid_at,
            r.quantity,
            (r.total_cents / 100).toFixed(2),
            (r.numbers ?? []).map((n) => formatNumberLabel(n, draw.label_digits)).join(' '),
            r.buyer_name,
            r.buyer_phone,
            r.buyer_email,
            r.pay_status,
            r.needs_manual_refund ? 'sim' : 'nao',
          ]
            .map(csvCell)
            .join(','),
        );
      }
      total += pagina.length;
      if (pagina.length < 500) break;
      if (total >= LIMITE_EXPORTACAO) {
        throw ApiError.conflict(`A exportação passa de ${LIMITE_EXPORTACAO} pedidos. Filtre por período.`);
      }
      const ultima = pagina[pagina.length - 1]!;
      cursor = { t: ultima.cursor_t, id: ultima.id };
    }

    // Exportar dado pessoal e um ato auditavel (RN11).
    await recordAuditEvent(client, {
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'draw.orders_exported',
      targetType: 'draw',
      targetId: draw.id,
      after: { rows: total },
      ip: input.origin?.ip ?? null,
      userAgent: input.origin?.userAgent ?? null,
    });

    const dia = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return { filename: `pedidos-${draw.slug}-${dia}.csv`, content: `${BOM}${linhas.join('\r\n')}\r\n` };
  });
}
