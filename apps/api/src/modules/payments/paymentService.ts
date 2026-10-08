import { withoutContext, withTenant, type PoolClient } from '@clubedarifa/db';
import { RESERVATION_TTL_MINUTES, type OrderResponse } from '@clubedarifa/shared';
import type { AppDeps } from '../../deps.js';
import { creatorDisabledMethods } from '../../lib/paymentPrefs.js';
import { ApiError } from '../../lib/apiError.js';
import { log } from '../../lib/log.js';
import {
  PaymentAccountUnavailableError,
  PaymentsNotConfiguredError,
  PspRejectedError,
  PspUnavailableError,
  type PspPayment,
  type PspResolution,
} from '@clubedarifa/psp';
import { montarPedido } from '../draws/drawService.js';

/**
 * M05 · pagamento PIX.
 *
 * A TRANSICAO PARA PAGO NAO E DAQUI: e a funcao `app.settle_order_paid`, no banco,
 * chamada pela API e pelo worker. Este arquivo gera o PIX, consulta o PSP e chama
 * a funcao com o que o PSP respondeu.
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

    await chamarFuncao(client, 'SELECT app.settle_order_paid($1, NULL, $2) AS r', [orderId, 'DEV']);
    return montarPedido(client, orderId);
  });
}

/**
 * Chama uma funcao de estado do banco e traduz o erro em erro de API.
 * P0002 = nao encontrado; P0001 = regra de negocio recusou (mensagem do banco).
 */
async function chamarFuncao(
  client: PoolClient,
  sql: string,
  params: unknown[],
): Promise<string> {
  try {
    const { rows } = await client.query<{ r: string }>(sql, params);
    return rows[0]!.r;
  } catch (error) {
    const codigo = (error as { code?: string }).code;
    if (codigo === 'P0002') throw ApiError.notFound('Pedido não encontrado.');
    if (codigo === 'P0001') {
      throw ApiError.conflict(
        error instanceof Error ? error.message : 'A operação conflita com o estado atual.',
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Gerar o PIX
// ---------------------------------------------------------------------------

function exigirPagamentos(deps: AppDeps) {
  if (!deps.paymentAccounts) throw new ApiError('PAYMENT_PROVIDER_UNAVAILABLE');
  return deps.paymentAccounts;
}

/**
 * O PSP DA COMUNIDADE para criar uma cobranca nova. Sem conta conectada: PAYMENTS_NOT_CONFIGURED.
 * Conta ou autorizacao inutilizavel: PAYMENT_ACCOUNT_UNAVAILABLE. Nunca ha outra credencial.
 */
async function resolverPspDaComunidade(deps: AppDeps, tenantId: string): Promise<PspResolution> {
  try {
    return await exigirPagamentos(deps).resolver.forTenant(tenantId);
  } catch (error) {
    if (error instanceof PaymentsNotConfiguredError) throw new ApiError('PAYMENTS_NOT_CONFIGURED');
    if (error instanceof PaymentAccountUnavailableError) {
      throw new ApiError('PAYMENT_ACCOUNT_UNAVAILABLE', undefined, { reason: error.reason });
    }
    throw error;
  }
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
  exigirPagamentos(deps);

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

    // O criador pode ter pausado o PIX: sem cobranca nova (pagamento ja criado segue valendo).
    if ((await creatorDisabledMethods(client, input.tenantId)).includes('PIX')) throw new ApiError('PAYMENT_METHOD_DISABLED');

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

  // A conta que vai receber e escolhida AGORA, pela comunidade do pedido.
  const { gateway: psp, paymentAccountId } = await resolverPspDaComunidade(deps, input.tenantId);

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
      log.warn('PIX: provedor indisponivel', { tenant_id: input.tenantId, order_id: input.orderId });
      throw new ApiError('PAYMENT_PROVIDER_UNAVAILABLE');
    }
    if (error instanceof PaymentAccountUnavailableError) {
      throw new ApiError('PAYMENT_ACCOUNT_UNAVAILABLE', undefined, { reason: error.reason });
    }
    if (error instanceof PspRejectedError) {
      log.error('PIX: provedor recusou o pedido', {
        tenant_id: input.tenantId,
        order_id: input.orderId,
        error: error.message,
      });
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
          amount_cents, pix_copy_paste, pix_qr_base64, expires_at, raw, payment_account_id)
       VALUES ($1, $2, $3, $4, 'PENDENTE', $5, $6, $7, $8, $9, $10::jsonb, $11)
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
        paymentAccountId,
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
 * Aplica o que o PSP disse sobre um pagamento. `remoto` veio de uma CONSULTA a API
 * do provedor — nunca do corpo do webhook (RN06). A regra inteira (conferir valor
 * e pedido, idempotencia, concluir a venda, estorno manual) vive na funcao
 * `app.apply_psp_payment`, a MESMA que o worker usa: uma transicao, uma
 * implementacao.
 */
export async function reconcilePayment(
  client: PoolClient,
  provider: string,
  remoto: PspPayment,
  paymentAccountId: string | null,
): Promise<ReconcileOutcome> {
  const resultado = await chamarFuncao(
    client,
    'SELECT app.apply_psp_payment($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb, $8::uuid) AS r',
    [
      provider,
      remoto.providerPaymentId,
      remoto.status,
      remoto.amountCents,
      remoto.externalReference,
      remoto.paidAt,
      JSON.stringify(remoto.raw ?? null),
      paymentAccountId,
    ],
  );
  return resultado as ReconcileOutcome;
}

/**
 * Processa um aviso do Mercado Pago.
 *
 *  1. valida a ASSINATURA (401 se nao confere, sem nenhum efeito) — o segredo e o da APLICACAO;
 *  2. acha o pagamento no NOSSO registro e descobre a comunidade e a CONTA dele. O `:tenant` da
 *     URL e so uma pista de roteamento: se nao for a comunidade dona do pagamento, o aviso e
 *     ignorado — um aviso enderecado a B nunca altera um pagamento da A;
 *  3. CONSULTA o pagamento no provedor COM AS CREDENCIAIS DA CONTA ORIGINAL do pagamento (RN06:
 *     webhook dispara a consulta, nunca paga);
 *  4. aplica o resultado, conferindo comunidade, conta, valor e referencia; idempotente.
 *
 * Aviso valido que nao pede acao responde 200 — o PSP so reenvia o que recebe como erro.
 * Provedor fora do ar responde 503, para o PSP tentar de novo.
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
  const resolver = deps.paymentAccounts?.resolver;
  if (!resolver) throw ApiError.notFound('Recurso indisponível.');

  const verificacao = resolver.verifyWebhook({
    headers: input.headers,
    query: input.query,
    body: input.body,
  });
  if (!verificacao.valid) {
    log.warn('webhook recusado: assinatura invalida', { reason: verificacao.reason });
    throw ApiError.unauthenticated('Assinatura inválida.');
  }
  if (!verificacao.isPaymentEvent || !verificacao.paymentId) return { outcome: 'ignored' };

  // Roteamento pelo NOSSO registro, nao pela URL.
  const { rota, dicaTenant } = await withoutContext(deps.pool, async (client) => {
    const { rows } = await client.query<{
      tenant_id: string;
      payment_account_id: string | null;
      provider_account_id: string | null;
    }>('SELECT * FROM app.find_payment_route($1, $2)', [resolver.provider, verificacao.paymentId]);
    const { rows: t } = await client.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM app.resolve_tenant_by_slug($1)',
      [input.tenantSlug.toLowerCase()],
    );
    return { rota: rows[0] ?? null, dicaTenant: t[0]?.tenant_id ?? null };
  });
  if (!rota) return { outcome: 'ignored' };
  if (dicaTenant !== rota.tenant_id) {
    log.warn('webhook: a comunidade da URL nao e a dona do pagamento; ignorado', {
      url_tenant_id: dicaTenant,
      payment_tenant_id: rota.tenant_id,
    });
    return { outcome: 'ignored' };
  }
  // O Mercado Pago informa o vendedor (`user_id`) no aviso: se vier e nao for o da conta do
  // pagamento, nao e deste pagamento.
  const vendedor = (input.body as { user_id?: string | number } | null)?.user_id;
  if (vendedor !== undefined && rota.provider_account_id && String(vendedor) !== rota.provider_account_id) {
    log.warn('webhook: o vendedor do aviso nao e o da conta do pagamento; ignorado', {
      payment_tenant_id: rota.tenant_id,
    });
    return { outcome: 'ignored' };
  }

  let resolucao: PspResolution;
  try {
    resolucao = await resolver.forPayment({ tenantId: rota.tenant_id, paymentAccountId: rota.payment_account_id });
  } catch (error) {
    if (error instanceof PaymentAccountUnavailableError || error instanceof PaymentsNotConfiguredError) {
      // A conta caiu: nao ha como consultar. O pagamento ja foi sinalizado para acao manual.
      log.warn('webhook: conta de recebimento indisponivel; nada aplicado', { tenant_id: rota.tenant_id });
      return { outcome: 'ignored' };
    }
    throw error;
  }

  let remoto: PspPayment;
  try {
    remoto = await resolucao.gateway.getPayment(verificacao.paymentId);
  } catch (error) {
    if (error instanceof PspUnavailableError) throw new ApiError('PAYMENT_PROVIDER_UNAVAILABLE');
    if (error instanceof PaymentAccountUnavailableError) return { outcome: 'ignored' };
    if (error instanceof PspRejectedError) return { outcome: 'ignored' };
    throw error;
  }

  const outcome = await withTenant(deps.pool, { tenantId: rota.tenant_id }, (client) =>
    reconcilePayment(client, resolver.provider, remoto, resolucao.paymentAccountId),
  );
  return { outcome };
}
