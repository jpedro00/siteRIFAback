import { randomUUID } from 'node:crypto';
import {
  InvalidWebhookSignatureError,
  recordStripeEvent,
  type BillingGatewayError,
} from '@clubedarifa/billing';
import { withTenant } from '@clubedarifa/db';
import {
  CHECKOUT_SESSION_TTL_MINUTES,
  type BillingInvoice,
  type BillingState,
  type EntitlementsResponse,
  type MySubscriptionResponse,
  type Plan,
  type PlanListResponse,
  type RedirectResponse,
  type Subscription,
} from '@clubedarifa/shared';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';
import { decodeCursor, encodeCursor, parseLimit } from '../../lib/cursor.js';
import { recordAuditEvent } from '../audit/auditService.js';
import { readEntitlements } from './entitlementService.js';

/**
 * Assinatura da PLATAFORMA (Stripe Billing) — FLUXO A. Nada aqui toca `orders`,
 * `payments` nem o PSP dos sorteios.
 *
 * Duas regras que atravessam o arquivo:
 *  - o navegador manda so o `planId`; o Price da Stripe vem do plano gravado no banco;
 *  - voltar da Stripe nao libera nada: quem muda o estado e o webhook, e quem concede
 *    acesso e a assinatura sincronizada.
 */

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

const LIVE_STATUSES = "('trialing', 'active', 'past_due', 'unpaid', 'paused')";

export function requireBilling(deps: AppDeps) {
  if (!deps.billing) {
    throw new ApiError('BILLING_UNAVAILABLE');
  }
  return deps.billing;
}

/** Erro da Stripe vira 503 para a interface; o detalhe fica no log do servidor. */
export function asBillingError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const gatewayError = error as Partial<BillingGatewayError> | undefined;
  if (gatewayError?.name === 'BillingGatewayError') {
    throw new ApiError('BILLING_UNAVAILABLE', undefined, { transient: gatewayError.transient === true });
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

export interface PlanRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  billing_interval: 'month' | 'year';
  price_cents: number;
  currency: string;
  max_active_draws: number | null;
  max_team_members: number | null;
  features: string[];
  status: 'DRAFT' | 'AVAILABLE' | 'ARCHIVED';
}

export const PLAN_COLUMNS = `p.id, p.code, p.name, p.description, p.billing_interval, p.price_cents, p.currency,
                      p.max_active_draws, p.max_team_members, p.features, p.status`;

export function toPlan(r: PlanRow): Plan {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    interval: r.billing_interval,
    priceCents: r.price_cents,
    currency: r.currency,
    maxActiveDraws: r.max_active_draws,
    maxTeamMembers: r.max_team_members,
    features: r.features,
    status: r.status,
  };
}

/** Planos A VENDA. Nada de rascunho nem arquivado, mesmo que a RLS o deixasse passar. */
export async function listPlans(deps: AppDeps, input: { tenantId: string; userId: string }): Promise<PlanListResponse> {
  return withTenant(deps.pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
    const { rows } = await client.query<PlanRow>(
      `SELECT ${PLAN_COLUMNS} FROM plans p WHERE p.status = 'AVAILABLE' ORDER BY p.price_cents, p.code`,
    );
    return { plans: rows.map(toPlan) };
  });
}

export async function getMyBilling(
  deps: AppDeps,
  input: { tenantId: string; userId: string; cursor?: unknown; limit?: unknown },
): Promise<MySubscriptionResponse> {
  const limit = parseLimit(input.limit, 20, 50);
  const cursor = decodeCursor(input.cursor);

  return withTenant(deps.pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
    const { rows: st } = await client.query<{ s: BillingState }>('SELECT app.tenant_billing_state($1) AS s', [input.tenantId]);

    const { rows: subs } = await client.query<
      PlanRow & {
        sub_id: string;
        sub_status: Subscription['status'];
        current_period_start: Date | null;
        current_period_end: Date | null;
        cancel_at_period_end: boolean;
        canceled_at: Date | null;
        trial_end: Date | null;
        past_due_since: Date | null;
      }
    >(
      `SELECT ${PLAN_COLUMNS},
              s.id AS sub_id, s.status AS sub_status, s.current_period_start, s.current_period_end,
              s.cancel_at_period_end, s.canceled_at, s.trial_end, s.past_due_since
         FROM tenant_subscriptions s
         JOIN plans p ON p.id = s.plan_id
        WHERE s.tenant_id = $1
        ORDER BY (s.status IN ${LIVE_STATUSES}) DESC, s.updated_at DESC
        LIMIT 1`,
      [input.tenantId],
    );
    const s = subs[0];
    const subscription: Subscription | null = s
      ? {
          id: s.sub_id,
          plan: toPlan(s),
          status: s.sub_status,
          currentPeriodStart: iso(s.current_period_start),
          currentPeriodEnd: iso(s.current_period_end),
          cancelAtPeriodEnd: s.cancel_at_period_end,
          canceledAt: iso(s.canceled_at),
          trialEnd: iso(s.trial_end),
          pastDueSince: iso(s.past_due_since),
        }
      : null;

    const values: unknown[] = [input.tenantId];
    let keyset = '';
    if (cursor) {
      values.push(cursor.t, cursor.id);
      keyset = `AND (created_at, id) < ($2::timestamptz, $3::uuid)`;
    }
    values.push(limit + 1);
    const { rows: inv } = await client.query<{
      id: string;
      status: BillingInvoice['status'];
      currency: string;
      amount_due_cents: string;
      amount_paid_cents: string;
      amount_remaining_cents: string;
      attempt_count: number;
      period_start: Date | null;
      period_end: Date | null;
      paid_at: Date | null;
      hosted_invoice_url: string | null;
      created_at: Date;
      cursor_t: string;
    }>(
      `SELECT id, status, currency, amount_due_cents, amount_paid_cents, amount_remaining_cents,
              attempt_count, period_start, period_end, paid_at, hosted_invoice_url, created_at,
              created_at::text AS cursor_t
         FROM billing_invoices
        WHERE tenant_id = $1 ${keyset}
        ORDER BY created_at DESC, id DESC
        LIMIT $${values.length}`,
      values,
    );
    const page = inv.slice(0, limit);
    const last = page[page.length - 1];

    return {
      state: st[0]!.s,
      subscription,
      invoices: page.map((r) => ({
        id: r.id,
        status: r.status,
        currency: r.currency,
        amountDueCents: Number(r.amount_due_cents),
        amountPaidCents: Number(r.amount_paid_cents),
        amountRemainingCents: Number(r.amount_remaining_cents),
        attemptCount: r.attempt_count,
        periodStart: iso(r.period_start),
        periodEnd: iso(r.period_end),
        paidAt: iso(r.paid_at),
        hostedInvoiceUrl: r.hosted_invoice_url,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      nextCursor: inv.length > limit && last ? encodeCursor({ t: last.cursor_t, id: last.id }) : null,
    };
  });
}

export async function getEntitlements(
  deps: AppDeps,
  input: { tenantId: string; userId: string },
): Promise<EntitlementsResponse> {
  // A regra e a leitura moram no EntitlementService; aqui so se abre o contexto da comunidade.
  return withTenant(deps.pool, { tenantId: input.tenantId, userId: input.userId }, (client) =>
    readEntitlements(client, input.tenantId),
  );
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/** Antes de reaproveitar um Checkout aberto, ele precisa ainda ter esta folga (ms). */
const REUSE_MIN_REMAINING_MS = 2 * 60_000;

/**
 * Cria (ou devolve) o Checkout do plano escolhido.
 *
 * Tudo acontece numa transacao sob um LOCK POR COMUNIDADE: requisicoes repetidas ou
 * concorrentes se enfileiram e a segunda encontra a sessao aberta pela primeira — um
 * unico Checkout, nunca dois. O indice parcial do banco e a segunda trava.
 */
export async function createCheckout(
  deps: AppDeps,
  input: { tenantId: string; userId: string; planId: string; origin?: { ip: string | null; userAgent: string | null } },
): Promise<RedirectResponse> {
  const billing = requireBilling(deps);
  const returnUrl = deps.config.BILLING_RETURN_URL!;

  try {
    return await withTenant(deps.pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('billing-checkout:' || $1::text, 0))`, [
        input.tenantId,
      ]);

      // O plano e o PRECO saem do banco. Indisponivel e inexistente respondem igual.
      const { rows: plans } = await client.query<{ id: string; stripe_price_id: string | null }>(
        `SELECT p.id, p.stripe_price_id FROM plans p WHERE p.id = $1 AND p.status = 'AVAILABLE'`,
        [input.planId],
      );
      const plan = plans[0];
      if (!plan || !plan.stripe_price_id) throw ApiError.notFound('Plano não encontrado ou indisponível.');

      // Ja tem assinatura viva: quem muda de plano ou cancela e o portal, nao um novo Checkout.
      const { rows: live } = await client.query(
        `SELECT 1 FROM tenant_subscriptions WHERE tenant_id = $1 AND status IN ${LIVE_STATUSES} LIMIT 1`,
        [input.tenantId],
      );
      if (live.length > 0) {
        throw new ApiError(
          'CONFLICT',
          'Sua comunidade já tem uma assinatura. Para trocar de plano ou cancelar, use o gerenciamento da assinatura.',
          { reason: 'ALREADY_SUBSCRIBED' },
        );
      }

      const customerId = await ensureCustomer(deps, client, input.tenantId);

      // Ja existe um Checkout ABERTO?
      const { rows: open } = await client.query<{ stripe_session_id: string; url: string; plan_id: string; expires_at: Date }>(
        `SELECT stripe_session_id, url, plan_id, expires_at
           FROM billing_checkout_sessions
          WHERE tenant_id = $1 AND status = 'OPEN' AND expires_at > now()`,
        [input.tenantId],
      );
      const existing = open[0];
      if (existing) {
        const restante = new Date(existing.expires_at).getTime() - Date.now();
        if (existing.plan_id === input.planId && restante > REUSE_MIN_REMAINING_MS) {
          return { url: existing.url };
        }
        // Outro plano (ou quase vencido): fecha o anterior antes de abrir o novo.
        await billing.gateway.expireCheckoutSession(existing.stripe_session_id).catch(() => undefined);
        await client.query('SELECT app.set_checkout_session_status($1, $2, $3)', [
          input.tenantId,
          existing.stripe_session_id,
          'EXPIRED',
        ]);
      }

      const expiresAt = new Date(Date.now() + CHECKOUT_SESSION_TTL_MINUTES * 60_000);
      const session = await billing.gateway.createCheckoutSession({
        customerId,
        priceId: plan.stripe_price_id,
        tenantId: input.tenantId,
        planId: input.planId,
        successUrl: `${returnUrl}/assinatura?checkout=success`,
        cancelUrl: `${returnUrl}/assinatura?checkout=cancelled`,
        expiresAt,
        idempotencyKey: `checkout:${input.tenantId}:${input.planId}:${randomUUID()}`,
      });
      await client.query('SELECT app.record_checkout_session($1, $2, $3, $4, $5, $6)', [
        input.tenantId,
        input.planId,
        input.userId,
        session.id,
        session.url,
        session.expiresAt,
      ]);
      return { url: session.url };
    });
  } catch (error) {
    return asBillingError(error);
  }
}

/** Um cliente Stripe por comunidade, sem duplicar: lock + chave de idempotencia na Stripe. */
async function ensureCustomer(deps: AppDeps, client: import('pg').PoolClient, tenantId: string): Promise<string> {
  const billing = requireBilling(deps);
  const { rows } = await client.query<{ stripe_customer_id: string }>(
    'SELECT stripe_customer_id FROM tenant_billing WHERE tenant_id = $1',
    [tenantId],
  );
  if (rows[0]) return rows[0].stripe_customer_id;

  const { rows: t } = await client.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [tenantId]);
  const customer = await billing.gateway.createCustomer({
    tenantId,
    tenantName: t[0]?.name ?? tenantId,
    // A mesma chave devolve o MESMO cliente se uma tentativa anterior criou na Stripe e
    // caiu antes de gravar aqui: nao nasce cliente duplicado.
    idempotencyKey: `customer:${tenantId}`,
  });
  const { rows: linked } = await client.query<{ r: string }>('SELECT app.link_stripe_customer($1, $2) AS r', [
    tenantId,
    customer.id,
  ]);
  if (linked[0]!.r !== 'linked' && linked[0]!.r !== 'already_linked') {
    throw new ApiError('CONFLICT', 'Não foi possível vincular a cobrança a esta comunidade.', { reason: linked[0]!.r });
  }
  return customer.id;
}

// ---------------------------------------------------------------------------
// Customer Portal
// ---------------------------------------------------------------------------

export async function createPortal(
  deps: AppDeps,
  input: { tenantId: string; userId: string; origin?: { ip: string | null; userAgent: string | null } },
): Promise<RedirectResponse> {
  const billing = requireBilling(deps);

  try {
    return await withTenant(deps.pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
      // O cliente vem do vinculo desta COMUNIDADE (RLS + tenant_id): nunca de parametro.
      const { rows } = await client.query<{ stripe_customer_id: string }>(
        'SELECT stripe_customer_id FROM tenant_billing WHERE tenant_id = $1',
        [input.tenantId],
      );
      if (!rows[0]) {
        throw new ApiError('CONFLICT', 'Esta comunidade ainda não tem assinatura para gerenciar.', {
          reason: 'NO_CUSTOMER',
        });
      }
      const session = await billing.gateway.createPortalSession({
        customerId: rows[0].stripe_customer_id,
        returnUrl: `${deps.config.BILLING_RETURN_URL!}/assinatura`,
      });
      await recordAuditEvent(client, {
        tenantId: input.tenantId,
        actorUserId: input.userId,
        action: 'billing.portal_opened',
        targetType: 'tenant',
        targetId: input.tenantId,
        ip: input.origin?.ip ?? null,
        userAgent: input.origin?.userAgent ?? null,
      });
      return { url: session.url };
    });
  } catch (error) {
    return asBillingError(error);
  }
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

/**
 * Recebe um evento da Stripe. Devolve normalmente so DEPOIS de o evento estar gravado
 * com durabilidade: se a gravacao falhar, a excecao sobe e o endpoint responde 5xx — a
 * Stripe reenvia. Nunca "confirmamos" um evento que nao guardamos.
 */
export async function receiveStripeWebhook(
  deps: AppDeps,
  input: { rawBody: Buffer | undefined; signature: string | undefined },
): Promise<{ eventId: string; schedule: boolean }> {
  if (!deps.billing) throw ApiError.notFound();
  if (!input.rawBody || input.rawBody.length === 0) throw ApiError.badRequest('Corpo do webhook ausente.');

  let envelope;
  try {
    envelope = deps.billing.gateway.verifyWebhook({ rawBody: input.rawBody, signature: input.signature });
  } catch (error) {
    if (error instanceof InvalidWebhookSignatureError) {
      throw ApiError.badRequest('Assinatura do webhook inválida.');
    }
    throw error;
  }

  const result = await recordStripeEvent(deps.pool, envelope);
  return { eventId: envelope.id, schedule: result !== 'DUPLICATE_DONE' };
}
