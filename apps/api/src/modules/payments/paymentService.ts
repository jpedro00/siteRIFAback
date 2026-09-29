import { withoutContext, withTenant, type PoolClient } from '@clubedarifa/db';
import { RESERVATION_TTL_MINUTES, type OrderResponse } from '@clubedarifa/shared';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';
import {
  PspRejectedError,
  PspUnavailableError,
  type PspGateway,
  type PspPayment,
} from '../../psp/types.js';
import { recordAuditEvent } from '../audit/auditService.js';
import { montarPedido } from '../draws/drawService.js';
import { enqueueOutboxEvent } from '../outbox/outboxService.js';

/**
 * M05 · pagamento PIX.
 *
 * TRES REGRAS ORGANIZAM ESTE ARQUIVO.
 *
 * 1. RN06 — SO O PSP PAGA. Um pedido vira PAGO quando o PSP CONFIRMA a cobranca,
 *    e a confirmacao e uma CONSULTA a API do provedor. O corpo de um webhook, o
 *    comprovante enviado pelo participante e qualquer coisa que chegue por fora
 *    nao mudam o estado do pedido.
 *
 * 2. RN07 — IDEMPOTENCIA. A chave da cobranca e o pedido; a transicao para PAGO
 *    e feita com a linha travada e olha o estado ATUAL. Webhook repetido, retry
 *    do PSP e duas abas abertas convergem para UMA venda.
 *
 * 3. UMA PORTA. `settleOrderPaid` e o unico lugar que escreve PAGO num pedido ou
 *    num numero. A confirmacao de desenvolvimento passa por ela tambem.
 */

export type SettleOutcome = 'PAID' | 'ALREADY_PAID' | 'REFUND_REQUIRED';

interface OrderLockRow {
  id: string;
  tenant_id: string;
  draw_id: string;
  status: string;
  quantity: number;
  total_cents: number;
}

/**
 * Conclui a venda de um pedido. Roda dentro da transacao do chamador.
 *
 * Os numeros do pedido ja sao dele (PENDENTE) no caminho normal. Se o PIX foi
 * pago DEPOIS de a varredura devolver os numeros a grade, tenta reavelos:
 *   - todos ainda livres -> a venda se conclui (Suposicao S4);
 *   - algum ja tem outro dono -> nada e alterado, o pagamento fica marcado para
 *     estorno MANUAL e o painel e avisado. Vender o mesmo numero duas vezes
 *     nunca e a saida.
 */
export async function settleOrderPaid(
  client: PoolClient,
  input: { orderId: string; paymentId: string | null; actorLabel: string },
): Promise<SettleOutcome> {
  const { rows } = await client.query<OrderLockRow>(
    `SELECT id, tenant_id, draw_id, status::text AS status, quantity, total_cents
       FROM orders WHERE id = $1 FOR UPDATE`,
    [input.orderId],
  );
  const pedido = rows[0];
  if (!pedido) throw ApiError.notFound('Pedido não encontrado.');
  if (pedido.status === 'PAGO') return 'ALREADY_PAID';

  const { rows: itens } = await client.query<{ number: number }>(
    'SELECT number FROM order_items WHERE order_id = $1 ORDER BY number',
    [input.orderId],
  );
  const numeros = itens.map((i) => i.number);

  // Tudo-ou-nada: um SAVEPOINT desfaz as reivindicacoes se faltar qualquer numero.
  await client.query('SAVEPOINT settle_order');

  const { rows: proprios } = await client.query<{ number: number }>(
    `UPDATE draw_numbers SET status = 'PAGO', expires_at = NULL
      WHERE order_id = $1 AND status = 'PENDENTE'
      RETURNING number`,
    [input.orderId],
  );
  const conquistados = new Set(proprios.map((r) => r.number));

  const faltantes = numeros.filter((n) => !conquistados.has(n));
  if (faltantes.length > 0) {
    // Devolvidos a grade por uma reserva vencida: retomaveis.
    const { rows: retomados } = await client.query<{ number: number }>(
      `UPDATE draw_numbers
          SET status = 'PAGO', order_id = $1, reservation_id = NULL, expires_at = NULL
        WHERE draw_id = $2 AND number = ANY($3::int[])
          AND status = 'RESERVADO' AND expires_at <= now()
        RETURNING number`,
      [input.orderId, pedido.draw_id, faltantes],
    );
    for (const r of retomados) conquistados.add(r.number);

    const aindaFaltam = faltantes.filter((n) => !conquistados.has(n));
    if (aindaFaltam.length > 0) {
      // Sem linha nenhuma = livre de verdade: ocupa.
      const { rows: novos } = await client.query<{ number: number }>(
        `INSERT INTO draw_numbers (tenant_id, draw_id, number, status, order_id)
         SELECT $1, $2, n, 'PAGO', $3 FROM unnest($4::int[]) AS n
         ON CONFLICT (draw_id, number) DO NOTHING
         RETURNING number`,
        [pedido.tenant_id, pedido.draw_id, input.orderId, aindaFaltam],
      );
      for (const r of novos) conquistados.add(r.number);
    }
  }

  if (conquistados.size !== numeros.length) {
    await client.query('ROLLBACK TO SAVEPOINT settle_order');
    const perdidos = numeros.filter((n) => !conquistados.has(n));

    if (input.paymentId === null) {
      // Confirmacao sem pagamento (so em desenvolvimento): nao ha o que estornar.
      throw ApiError.conflict('Os números deste pedido não estão mais disponíveis.');
    }

    const motivo = `Pagamento aprovado depois de os números ${perdidos.join(', ')} terem outro dono.`;
    await client.query(
      `UPDATE payments SET needs_manual_refund = true, refund_reason = $2 WHERE id = $1`,
      [input.paymentId, motivo],
    );
    await recordAuditEvent(client, {
      tenantId: pedido.tenant_id,
      actorUserId: null,
      actorType: 'SYSTEM',
      action: 'payment.refund_required',
      targetType: 'order',
      targetId: input.orderId,
      after: { paymentId: input.paymentId, numbers: perdidos },
    });
    await enqueueOutboxEvent(client, {
      tenantId: pedido.tenant_id,
      eventType: 'payment.refund_required',
      payload: {
        tenantId: pedido.tenant_id,
        orderId: input.orderId,
        drawId: pedido.draw_id,
        paymentId: input.paymentId,
        amountCents: pedido.total_cents,
        reason: motivo,
      },
    });
    return 'REFUND_REQUIRED';
  }
  await client.query('RELEASE SAVEPOINT settle_order');

  await client.query(`UPDATE orders SET status = 'PAGO', paid_at = now() WHERE id = $1`, [
    input.orderId,
  ]);

  await recordAuditEvent(client, {
    tenantId: pedido.tenant_id,
    actorUserId: null,
    actorType: 'SYSTEM',
    action: 'order.paid',
    targetType: 'order',
    targetId: input.orderId,
    before: { status: pedido.status },
    after: { status: 'PAGO', via: input.actorLabel, paymentId: input.paymentId },
  });
  await enqueueOutboxEvent(client, {
    tenantId: pedido.tenant_id,
    eventType: 'order.paid',
    payload: {
      tenantId: pedido.tenant_id,
      orderId: input.orderId,
      drawId: pedido.draw_id,
      paymentId: input.paymentId,
      quantity: pedido.quantity,
      totalCents: pedido.total_cents,
    },
  });
  return 'PAID';
}

/**
 * Confirmacao de pagamento SEM provedor — so em development/test. A recusa nos
 * demais ambientes e a primeira linha do handler; aqui so ha o efeito.
 */
export async function devConfirmPayment(
  deps: AppDeps,
  tenantId: string,
  orderId: string,
): Promise<OrderResponse> {
  return withTenant(deps.pool, { tenantId }, async (client) => {
    const { rows } = await client.query<{ status: string }>(
      'SELECT status::text AS status FROM orders WHERE id = $1',
      [orderId],
    );
    const pedido = rows[0];
    if (!pedido) throw ApiError.notFound('Pedido não encontrado.');
    if (pedido.status === 'CANCELADO') throw ApiError.conflict('Este pedido foi cancelado.');

    await settleOrderPaid(client, { orderId, paymentId: null, actorLabel: 'DEV' });
    return montarPedido(client, orderId);
  });
}

// ---------------------------------------------------------------------------
// Gerar o PIX
// ---------------------------------------------------------------------------

function exigirPsp(deps: AppDeps): PspGateway {
  if (!deps.psp) throw new ApiError('PAYMENT_PROVIDER_UNAVAILABLE');
  return deps.psp;
}

/**
 * Gera a cobranca PIX do pedido — ou devolve a que ja existe.
 *
 * O PSP e chamado FORA de transacao: segurar linha de pedido e conexao do pool
 * enquanto se espera a rede de um terceiro seria trocar um problema de
 * latencia por um de travamento. A chave de idempotencia (o pedido) faz o
 * retry ser seguro: duas chamadas concorrentes resultam em UMA cobranca.
 *
 * O prazo do PIX e o MENOR entre o fim da reserva e o teto de 30 minutos: o PIX
 * nunca vive mais do que os numeros seguram.
 */
export async function ensurePixPayment(
  deps: AppDeps,
  input: { tenantId: string; tenantSlug: string; orderId: string },
): Promise<OrderResponse> {
  const psp = exigirPsp(deps);

  const preparo = await withTenant(deps.pool, { tenantId: input.tenantId }, async (client) => {
    const { rows } = await client.query<{
      id: string;
      status: string;
      total_cents: number;
      draw_title: string;
      buyer_name: string;
      buyer_email: string | null;
      reservation_expires_at: string | null;
      existing_payment: string | null;
    }>(
      `SELECT o.id, o.status::text AS status, o.total_cents, d.title AS draw_title,
              b.name AS buyer_name, b.email AS buyer_email,
              r.expires_at AS reservation_expires_at,
              (SELECT p.id FROM payments p WHERE p.order_id = o.id AND p.status = 'PENDENTE'
                ORDER BY p.created_at DESC LIMIT 1) AS existing_payment
         FROM orders o
         JOIN draws d ON d.id = o.draw_id
         JOIN buyers b ON b.id = o.buyer_id
         LEFT JOIN reservations r ON r.id = o.reservation_id
        WHERE o.id = $1`,
      [input.orderId],
    );
    const pedido = rows[0];
    if (!pedido) throw ApiError.notFound('Pedido não encontrado.');
    if (pedido.status !== 'PENDENTE') {
      // PAGO devolve o comprovante; CANCELADO nao gera cobranca.
      if (pedido.status === 'PAGO') return { pronto: await montarPedido(client, input.orderId) };
      throw ApiError.conflict('Este pedido não aceita mais pagamento.');
    }
    if (pedido.existing_payment) return { pronto: await montarPedido(client, input.orderId) };

    const limite = Date.now() + RESERVATION_TTL_MINUTES * 60_000;
    const fimReserva = pedido.reservation_expires_at
      ? new Date(pedido.reservation_expires_at).getTime()
      : limite;
    const expiraEm = Math.min(fimReserva, limite);
    if (expiraEm <= Date.now() + 30_000) {
      throw ApiError.conflict('O prazo desta reserva terminou. Escolha os números novamente.');
    }
    return { pedido, expiraEm: new Date(expiraEm) };
  });

  if ('pronto' in preparo) return preparo.pronto;
  const { pedido, expiraEm } = preparo;

  const base = deps.config.PUBLIC_API_BASE_URL;
  let cobranca: PspPayment;
  try {
    cobranca = await psp.createPixCharge({
      idempotencyKey: input.orderId,
      amountCents: pedido.total_cents,
      description: `Pedido de números — ${pedido.draw_title}`.slice(0, 200),
      externalReference: input.orderId,
      payerEmail: pedido.buyer_email,
      payerName: pedido.buyer_name.split(' ')[0] ?? pedido.buyer_name,
      expiresAt: expiraEm,
      notificationUrl: base ? `${base}/api/webhooks/mercadopago/${input.tenantSlug}` : null,
    });
  } catch (error) {
    if (error instanceof PspUnavailableError) {
      console.warn(`[pix] provedor indisponivel: pedido=${input.orderId}`);
      throw new ApiError('PAYMENT_PROVIDER_UNAVAILABLE');
    }
    if (error instanceof PspRejectedError) {
      console.error(`[pix] provedor recusou: pedido=${input.orderId} ${error.message}`);
      throw new ApiError('PAYMENT_PROVIDER_UNAVAILABLE');
    }
    throw error;
  }

  return withTenant(deps.pool, { tenantId: input.tenantId }, async (client) => {
    // `ON CONFLICT (idempotency_key) DO NOTHING`: se outra chamada concorrente
    // ja gravou a cobranca deste pedido, a nossa nao cria uma segunda linha.
    await client.query(
      `INSERT INTO payments
         (tenant_id, order_id, provider, provider_payment_id, status, idempotency_key,
          amount_cents, pix_copy_paste, pix_qr_base64, expires_at, raw)
       VALUES ($1, $2, $3, $4, 'PENDENTE', $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        input.tenantId,
        input.orderId,
        psp.provider,
        cobranca.providerPaymentId,
        input.orderId,
        pedido.total_cents,
        cobranca.copyPaste,
        cobranca.qrCodeBase64,
        expiraEm.toISOString(),
        JSON.stringify(cobranca.raw ?? null),
      ],
    );
    return montarPedido(client, input.orderId);
  });
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

export type ReconcileOutcome =
  | 'paid'
  | 'refund_required'
  | 'already_processed'
  | 'pending'
  | 'closed'
  | 'refunded'
  | 'mismatch'
  | 'unknown_payment'
  | 'ignored';

/**
 * Aplica o que o PSP diz sobre um pagamento. `remoto` veio de uma CONSULTA a API
 * do provedor — nunca do corpo do webhook (RN06). Idempotente.
 */
export async function reconcilePayment(
  client: PoolClient,
  provider: string,
  remoto: PspPayment,
): Promise<ReconcileOutcome> {
  const { rows } = await client.query<{
    id: string;
    tenant_id: string;
    order_id: string;
    status: string;
    amount_cents: number;
  }>(
    `SELECT id, tenant_id, order_id, status::text AS status, amount_cents
       FROM payments WHERE provider = $1 AND provider_payment_id = $2 FOR UPDATE`,
    [provider, remoto.providerPaymentId],
  );
  const pagamento = rows[0];
  if (!pagamento) return 'unknown_payment';

  // O que o PSP diz precisa CONFERIR com o que cobramos. Valor ou pedido
  // diferente nunca paga: e o sinal de aviso forjado ou de bug, e o custo de
  // ignorar e baixo perto do de pagar errado.
  if (
    remoto.externalReference !== pagamento.order_id ||
    remoto.amountCents !== pagamento.amount_cents
  ) {
    await recordAuditEvent(client, {
      tenantId: pagamento.tenant_id,
      actorUserId: null,
      actorType: 'SYSTEM',
      action: 'payment.mismatch',
      targetType: 'payment',
      targetId: pagamento.id,
      after: {
        expectedAmountCents: pagamento.amount_cents,
        receivedAmountCents: remoto.amountCents,
        referenceMatches: remoto.externalReference === pagamento.order_id,
      },
    });
    return 'mismatch';
  }

  if (pagamento.status === 'APROVADO') return 'already_processed';

  const raw = JSON.stringify(remoto.raw ?? null);

  switch (remoto.status) {
    case 'APROVADO': {
      await client.query(
        `UPDATE payments
            SET status = 'APROVADO', paid_at = COALESCE($2::timestamptz, now()), raw = $3::jsonb
          WHERE id = $1`,
        [pagamento.id, remoto.paidAt, raw],
      );
      const resultado = await settleOrderPaid(client, {
        orderId: pagamento.order_id,
        paymentId: pagamento.id,
        actorLabel: 'PSP',
      });
      return resultado === 'REFUND_REQUIRED' ? 'refund_required' : 'paid';
    }
    case 'EXPIRADO':
    case 'CANCELADO': {
      await client.query(`UPDATE payments SET status = $2::payment_status, raw = $3::jsonb WHERE id = $1`, [
        pagamento.id,
        remoto.status,
        raw,
      ]);
      return 'closed';
    }
    case 'ESTORNADO': {
      await client.query(`UPDATE payments SET status = 'ESTORNADO', raw = $2::jsonb WHERE id = $1`, [
        pagamento.id,
        raw,
      ]);
      await recordAuditEvent(client, {
        tenantId: pagamento.tenant_id,
        actorUserId: null,
        actorType: 'SYSTEM',
        action: 'payment.refunded',
        targetType: 'payment',
        targetId: pagamento.id,
      });
      return 'refunded';
    }
    default:
      return 'pending';
  }
}

/**
 * Processa um aviso do Mercado Pago.
 *
 *  1. valida a ASSINATURA (401 se nao confere, sem nenhum efeito);
 *  2. CONSULTA o pagamento na API do PSP;
 *  3. aplica o resultado, idempotente.
 *
 * Aviso valido que nao pede acao responde 200 — o PSP so reenvia o que recebe
 * como erro. Provedor fora do ar responde 503, para o PSP tentar de novo.
 */
export async function handlePspWebhook(
  deps: AppDeps,
  input: {
    tenantSlug: string;
    headers: Readonly<Record<string, string | undefined>>;
    query: Readonly<Record<string, string | undefined>>;
    body: unknown;
  },
): Promise<{ outcome: ReconcileOutcome }> {
  const psp = deps.psp;
  if (!psp) throw ApiError.notFound('Recurso indisponível.');

  const verificacao = psp.verifyWebhook({
    headers: input.headers,
    query: input.query,
    body: input.body,
  });
  if (!verificacao.valid) {
    console.warn(`[webhook] assinatura recusada: ${verificacao.reason}`);
    throw ApiError.unauthenticated('Assinatura inválida.');
  }
  if (!verificacao.isPaymentEvent || !verificacao.paymentId) return { outcome: 'ignored' };

  const tenantId = await withoutContext(deps.pool, async (client) => {
    const { rows } = await client.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM app.resolve_tenant_by_slug($1)',
      [input.tenantSlug.toLowerCase()],
    );
    return rows[0]?.tenant_id ?? null;
  });
  if (!tenantId) return { outcome: 'ignored' };

  let remoto: PspPayment;
  try {
    remoto = await psp.getPayment(verificacao.paymentId);
  } catch (error) {
    if (error instanceof PspUnavailableError) throw new ApiError('PAYMENT_PROVIDER_UNAVAILABLE');
    if (error instanceof PspRejectedError) return { outcome: 'ignored' };
    throw error;
  }

  const outcome = await withTenant(deps.pool, { tenantId }, (client) =>
    reconcilePayment(client, psp.provider, remoto),
  );
  return { outcome };
}
