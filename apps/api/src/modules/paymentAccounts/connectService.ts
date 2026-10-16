import { withTenant, withoutContext } from '@clubedarifa/db';
import {
  InvalidConnectWebhookError,
  verifyConnectWebhook,
  type ConnectRuntime,
  type ConnectWebhookEvent,
} from '@clubedarifa/payment-accounts';
import {
  PaymentAccountUnavailableError,
  PaymentsNotConfiguredError,
  PspRejectedError,
  PspUnauthorizedError,
  PspUnavailableError,
  type PspFailedRefund,
  type PspPayment,
  type PspResolution,
} from '@clubedarifa/psp';
import type { PaymentAccountsResponse } from '@clubedarifa/shared';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';
import { log } from '../../lib/log.js';
import { reconcilePayment } from '../payments/paymentService.js';
import { connectWebhookSecrets } from './connectSetup.js';
import { listPaymentAccounts } from './paymentAccountService.js';

/**
 * Stripe Connect na API: cadastro da conta, releitura do estado e webhook.
 *
 * Desligado (`deps.connect === null`): as tres entradas respondem 404 — o recurso nao existe
 * nesta implantacao, como o webhook da cobranca com `BILLING_PROVIDER=none`.
 *
 * Nenhum id de conta Stripe entra pelo cliente: o cadastro usa a conta da propria comunidade (ou
 * cria uma), e a releitura acha o `acct_` pelo banco, no contexto da comunidade.
 */

function exigirConnect(deps: AppDeps): ConnectRuntime {
  if (!deps.connect) throw ApiError.notFound();
  return deps.connect;
}

/** Erros da Stripe -> resposta. A mensagem nunca carrega chave nem corpo da Stripe. */
function traduzir(error: unknown): never {
  if (error instanceof PaymentAccountUnavailableError) {
    throw new ApiError('PAYMENT_ACCOUNT_UNAVAILABLE', undefined, { reason: error.reason });
  }
  if (error instanceof PspUnavailableError || error instanceof PspUnauthorizedError) {
    throw new ApiError('PAYMENT_PROVIDER_UNAVAILABLE');
  }
  if (error instanceof PspRejectedError) {
    throw new ApiError('PAYMENT_ACCOUNT_UNAVAILABLE', 'A Stripe recusou o pedido.');
  }
  throw error;
}

export async function beginStripeOnboarding(
  deps: AppDeps,
  input: { tenantId: string; userId: string },
): Promise<{ url: string }> {
  const connect = exigirConnect(deps);
  try {
    return await connect.beginOnboarding({ tenantId: input.tenantId, userId: input.userId });
  } catch (error) {
    traduzir(error);
  }
}

/**
 * Rele na Stripe a conta Connect DA comunidade (o criador voltou do cadastro e nao quer esperar o
 * webhook). O `acct_` sai de `app.connect_tenant_account`, no contexto da comunidade: nunca do
 * pedido.
 */
export async function refreshStripeAccount(
  deps: AppDeps,
  input: { tenantId: string; userId: string },
): Promise<PaymentAccountsResponse> {
  const connect = exigirConnect(deps);
  const acct = await withTenant(deps.pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
    const { rows } = await client.query<{ acct: string | null }>(
      'SELECT app.connect_tenant_account($1, $2::payment_environment) AS acct',
      [input.tenantId, connect.environment],
    );
    return rows[0]?.acct ?? null;
  });
  if (!acct) throw ApiError.notFound('Esta comunidade não tem conta Stripe cadastrada.');
  try {
    await connect.syncAccount(acct);
  } catch (error) {
    traduzir(error);
  }
  return listPaymentAccounts(deps, input);
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

export type ConnectWebhookResult = 'processed' | 'duplicate' | 'ignored';

const PAYMENT_EVENTS = new Set([
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'charge.refunded',
]);
/**
 * Estorno que mudou de estado (o que importa: `failed`, o PIX de devolucao recusado pelo banco do
 * comprador depois de a Stripe aceitar o estorno). Os tres nomes existem no SDK e trazem um
 * `Refund`; o corpo so identifica o PaymentIntent — o estado e RELIDO na Stripe (RN06).
 */
const REFUND_EVENTS = new Set(['refund.failed', 'refund.updated', 'charge.refund.updated']);
const HANDLED = new Set(['account.updated', ...PAYMENT_EVENTS, ...REFUND_EVENTS]);
const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9_]{1,255}$/;

/** Falha que a Stripe deve REENVIAR: o evento fica gravado sem `processed_at`. */
class RetryLater extends Error {}

/**
 * Webhook Connect.
 *
 *  1. ASSINATURA sobre o corpo bruto (401 sem nenhum efeito se nao confere);
 *  2. evento de outro modo (live x teste) ou de tipo que nao tratamos: 200 `ignored`, nada gravado;
 *  3. GRAVA e REIVINDICA o `event.id` (idempotencia + lease de 60 s). Ja concluido: 200
 *     `duplicate`, nada mais. Outra entrega em andamento: 503 sem trabalho, para a Stripe
 *     reenviar depois (se a outra falhar, o reenvio ainda processa);
 *  4. processa — RELENDO na Stripe (RN06): o corpo do aviso nunca vira estado;
 *  5. so entao marca como concluido. Falha: a reivindicacao e devolvida e o evento continua
 *     pendente (transitoria = 503), para o reenvio da Stripe rodar de novo (o efeito em si e
 *     idempotente).
 */
export async function handleConnectWebhook(
  deps: AppDeps,
  input: { rawBody: Buffer | undefined; signature: string | undefined },
): Promise<ConnectWebhookResult> {
  const connect = exigirConnect(deps);
  if (!input.rawBody || input.rawBody.length === 0) throw ApiError.unauthenticated('Assinatura inválida.');

  let event: ConnectWebhookEvent;
  try {
    event = verifyConnectWebhook(input.rawBody, input.signature, connectWebhookSecrets(deps.config));
  } catch (error) {
    if (error instanceof InvalidConnectWebhookError) {
      log.warn('stripe_connect.webhook_rejected', { reason: 'assinatura' });
      throw ApiError.unauthenticated('Assinatura inválida.');
    }
    throw error;
  }

  if (event.livemode !== (connect.environment === 'PRODUCTION')) {
    log.warn('stripe_connect.webhook_wrong_mode', { event_id: event.id, livemode: event.livemode });
    return 'ignored';
  }
  if (!HANDLED.has(event.type)) return 'ignored';

  // Token da reivindicacao (lease de 60 s) desta entrega; null = concluido ou outra em andamento.
  const token = await withoutContext(deps.pool, async (client) => {
    const { rows } = await client.query<{ token: string | null }>('SELECT app.record_connect_webhook_event($1, $2, $3) AS token', [
      event.id,
      event.type,
      event.account,
    ]);
    return rows[0]!.token;
  });
  if (token === null) {
    // Ja concluido: 200 duplicate. Outra entrega em andamento: 503, para a Stripe reenviar depois
    // (um 200 aqui faria a Stripe parar; se a primeira falhasse, o evento se perderia).
    const concluido = await withoutContext(deps.pool, async (client) => {
      const { rows } = await client.query<{ done: boolean }>('SELECT app.connect_webhook_event_processed($1) AS done', [event.id]);
      return rows[0]?.done === true;
    });
    if (concluido) return 'duplicate';
    log.warn('stripe_connect.webhook_in_flight', { event_id: event.id, type: event.type });
    throw new ApiError('PAYMENT_PROVIDER_UNAVAILABLE');
  }

  let result: Exclude<ConnectWebhookResult, 'duplicate'>;
  try {
    result = event.type === 'account.updated' ? await onAccountUpdated(connect, event) : await onPaymentEvent(deps, connect, event);
  } catch (error) {
    // Falhou: devolve a SUA reivindicacao (pelo token) para o reenvio da Stripe poder processar ja.
    // Se o lease ja venceu e outra entrega o pegou, nada muda. Se nem isso der, vence em 60 s.
    await withoutContext(deps.pool, (client) => client.query('SELECT app.release_connect_webhook_event($1, $2::uuid)', [event.id, token])).catch(
      () => undefined,
    );
    if (error instanceof RetryLater) {
      log.warn('stripe_connect.webhook_retry', { event_id: event.id, type: event.type });
      throw new ApiError('PAYMENT_PROVIDER_UNAVAILABLE');
    }
    throw error;
  }

  await withoutContext(deps.pool, (client) => client.query('SELECT app.finish_connect_webhook_event($1)', [event.id]));
  log.info('stripe_connect.webhook_done', { event_id: event.id, type: event.type, result });
  return result;
}

async function onAccountUpdated(connect: ConnectRuntime, event: ConnectWebhookEvent): Promise<'processed' | 'ignored'> {
  // A conta e a do envelope (de onde a Stripe diz que o evento veio), nao a do corpo.
  if (!event.account) return 'ignored';
  try {
    // Estado RELIDO da Stripe; conta desconhecida aqui nao cria nada (0 linhas).
    await connect.syncAccount(event.account);
    return 'processed';
  } catch (error) {
    if (error instanceof PspUnavailableError || error instanceof PspUnauthorizedError) throw new RetryLater();
    if (error instanceof PspRejectedError) return 'ignored';
    throw error;
  }
}

function paymentIntentOf(event: ConnectWebhookEvent): string | null {
  const o = event.object;
  const raw = event.type === 'charge.refunded' || REFUND_EVENTS.has(event.type) ? o['payment_intent'] : o['id'];
  const id = typeof raw === 'string' ? raw : typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : null;
  return typeof id === 'string' && PAYMENT_INTENT_ID.test(id) ? id : null;
}

async function onPaymentEvent(
  deps: AppDeps,
  connect: ConnectRuntime,
  event: ConnectWebhookEvent,
): Promise<'processed' | 'ignored'> {
  const paymentIntentId = paymentIntentOf(event);
  if (!paymentIntentId) return 'ignored';

  // Roteamento pelo NOSSO registro: comunidade e conta do pagamento.
  const rota = await withoutContext(deps.pool, async (client) => {
    const { rows } = await client.query<{
      tenant_id: string;
      payment_account_id: string | null;
      provider_account_id: string | null;
    }>('SELECT * FROM app.find_payment_route($1, $2)', ['STRIPE', paymentIntentId]);
    return rows[0] ?? null;
  });
  if (!rota) return 'ignored';

  // Evento vindo de uma conta conectada: tem de ser a conta do pagamento.
  if (event.account !== null && event.account !== rota.provider_account_id) {
    log.warn('stripe_connect.webhook_account_mismatch', { event_id: event.id, tenant_id: rota.tenant_id });
    return 'ignored';
  }

  let resolucao: PspResolution;
  try {
    resolucao = await connect.resolver.forPayment({ tenantId: rota.tenant_id, paymentAccountId: rota.payment_account_id });
  } catch (error) {
    if (error instanceof PaymentAccountUnavailableError || error instanceof PaymentsNotConfiguredError) {
      log.warn('stripe_connect.webhook_account_unavailable', { tenant_id: rota.tenant_id });
      return 'ignored';
    }
    throw error;
  }

  if (REFUND_EVENTS.has(event.type)) return onRefundEvent(deps, rota.tenant_id, resolucao, paymentIntentId);

  // RN06: o aviso so dispara a CONSULTA. O gateway confere que o PaymentIntent tem como destino a
  // conta conectada do pagamento (senao, PspRejectedError).
  let remoto: PspPayment;
  try {
    remoto = await resolucao.gateway.getPayment(paymentIntentId);
  } catch (error) {
    if (error instanceof PspUnavailableError || error instanceof PspUnauthorizedError) throw new RetryLater();
    if (error instanceof PspRejectedError || error instanceof PaymentAccountUnavailableError) {
      log.warn('stripe_connect.webhook_payment_rejected', { tenant_id: rota.tenant_id });
      return 'ignored';
    }
    throw error;
  }

  const outcome = await withTenant(deps.pool, { tenantId: rota.tenant_id }, (client) =>
    reconcilePayment(client, 'STRIPE', remoto, resolucao.paymentAccountId),
  );
  log.info('stripe_connect.payment_reconciled', { tenant_id: rota.tenant_id, outcome });
  return 'processed';
}

/**
 * Estorno que FALHOU depois de aceito. O pagamento pode ja estar ESTORNADO (terminal para a
 * Stripe): o status NAO muda e nada e estornado de novo — so abre a divergencia `REFUND_FAILED`
 * para o operador. O corpo do aviso nao diz se falhou: os estornos do PaymentIntent sao RELIDOS na
 * Stripe (o gateway confere antes a conta de destino). Nenhum estorno `failed` la: `ignored`.
 */
async function onRefundEvent(
  deps: AppDeps,
  tenantId: string,
  resolucao: PspResolution,
  paymentIntentId: string,
): Promise<'processed' | 'ignored'> {
  const gateway = resolucao.gateway;
  if (!gateway.failedRefunds) return 'ignored';
  let falhos: readonly PspFailedRefund[];
  try {
    falhos = await gateway.failedRefunds(paymentIntentId);
  } catch (error) {
    if (error instanceof PspUnavailableError || error instanceof PspUnauthorizedError) throw new RetryLater();
    if (error instanceof PspRejectedError || error instanceof PaymentAccountUnavailableError) {
      log.warn('stripe_connect.webhook_payment_rejected', { tenant_id: tenantId });
      return 'ignored';
    }
    throw error;
  }
  const falho = falhos[0];
  if (!falho) return 'ignored';

  const outcome = await withTenant(deps.pool, { tenantId }, async (client) => {
    const { rows } = await client.query<{ r: string }>('SELECT app.record_psp_refund_failed($1, $2, $3::uuid, $4, $5, $6) AS r', [
      'STRIPE',
      paymentIntentId,
      resolucao.paymentAccountId,
      falho.refundId,
      falho.failureReason,
      falho.amountCents,
    ]);
    return rows[0]!.r;
  });
  if (outcome === 'unknown_payment' || outcome === 'mismatch') {
    log.warn('stripe_connect.refund_failed_not_recorded', { tenant_id: tenantId, outcome });
    return 'ignored';
  }
  log.warn('stripe_connect.refund_failed', { tenant_id: tenantId, outcome });
  return 'processed';
}
