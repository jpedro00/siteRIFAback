import { withPlatform, type PoolClient } from '@clubedarifa/db';
import type { BillingGateway } from '@clubedarifa/billing';
import {
  BILLING_STATES,
  type BillingState,
  type CreatePlanRequest,
  type PlatformPlan,
  type PlatformPlanListResponse,
  type PlatformSubscriptionListResponse,
  type UpdatePlanRequest,
} from '@clubedarifa/shared';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';
import { decodeCursor, paginate, parseLimit } from '../../lib/cursor.js';
import { isUniqueViolation } from '../../lib/pgError.js';
import { recordAuditEvent } from '../audit/auditService.js';
import { asBillingError, requireBilling, type PlanRow } from './billingService.js';

/**
 * Catalogo de planos e consulta de assinaturas para o Super Admin (PLATFORM_FINANCE).
 *
 * Regras que atravessam o arquivo:
 *  - o PRECO so entra por `createPlan`, pela mao do servidor: o Product e o Price nascem na
 *    Stripe e os IDs voltam para o banco. O navegador nunca informa um ID da Stripe;
 *  - preco sincronizado nao se edita (o banco recusa): preco novo = plano novo;
 *  - a consulta de assinaturas e SOMENTE LEITURA: o estado financeiro vem da Stripe.
 */

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

interface PlatformPlanRow extends PlanRow {
  stripe_product_id: string | null;
  stripe_price_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `p.id, p.code, p.name, p.description, p.billing_interval, p.price_cents, p.currency,
                 p.max_active_draws, p.max_team_members, p.features, p.status,
                 p.stripe_product_id, p.stripe_price_id, p.created_at, p.updated_at`;

function toPlatformPlan(r: PlatformPlanRow): PlatformPlan {
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
    stripeProductId: r.stripe_product_id,
    stripePriceId: r.stripe_price_id,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

type Origin = { ip: string | null; userAgent: string | null };

export async function listPlatformPlans(deps: AppDeps, input: { userId: string }): Promise<PlatformPlanListResponse> {
  return withPlatform(deps.pool, { userId: input.userId }, async (client) => {
    const { rows } = await client.query<PlatformPlanRow>(`SELECT ${COLUMNS} FROM plans p ORDER BY p.created_at DESC, p.id DESC`);
    return { plans: rows.map(toPlatformPlan) };
  });
}

async function readPlan(client: PoolClient, id: string): Promise<PlatformPlanRow | null> {
  const { rows } = await client.query<PlatformPlanRow>(`SELECT ${COLUMNS} FROM plans p WHERE p.id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * Leva o plano ate a Stripe: Product, depois Price. Cada passo usa chave de idempotencia
 * derivada do plano (repetir devolve o MESMO objeto) e so grava o ID se ainda estiver vazio —
 * entao uma falha no meio (Product criado, Price nao) deixa o plano RASCUNHO com o Product
 * gravado, e repetir o pedido retoma de onde parou, sem duplicar nada na Stripe.
 */
async function syncPlanWithStripe(
  deps: AppDeps,
  gateway: BillingGateway,
  userId: string,
  planId: string,
): Promise<PlatformPlanRow> {
  const inicial = await withPlatform(deps.pool, { userId }, (client) => readPlan(client, planId));
  if (!inicial) throw ApiError.notFound('Plano não encontrado.');
  if (inicial.stripe_price_id) return inicial;

  try {
    let productId = inicial.stripe_product_id;
    if (!productId) {
      const product = await gateway.createProduct({
        planId,
        code: inicial.code,
        name: inicial.name,
        description: inicial.description,
        idempotencyKey: `plan-product-${planId}`,
      });
      productId = product.id;
      await withPlatform(deps.pool, { userId }, (client) =>
        client.query('UPDATE plans SET stripe_product_id = $2 WHERE id = $1 AND stripe_product_id IS NULL', [planId, product.id]),
      );
    }

    const price = await gateway.createPrice({
      productId,
      planId,
      unitAmountCents: inicial.price_cents,
      currency: inicial.currency,
      interval: inicial.billing_interval,
      idempotencyKey: `plan-price-${planId}`,
    });
    await withPlatform(deps.pool, { userId }, (client) =>
      client.query('UPDATE plans SET stripe_price_id = $2 WHERE id = $1 AND stripe_price_id IS NULL', [planId, price.id]),
    );
  } catch (error) {
    return asBillingError(error);
  }

  return withPlatform(deps.pool, { userId }, async (client) => {
    const pronto = await readPlan(client, planId);
    if (!pronto) throw ApiError.notFound('Plano não encontrado.');
    return pronto;
  });
}

export async function createPlan(
  deps: AppDeps,
  input: { userId: string; body: CreatePlanRequest & { currency: string; features: string[] }; origin: Origin },
): Promise<{ plan: PlatformPlan; created: boolean }> {
  const { gateway } = requireBilling(deps);
  const b = input.body;

  // 1. A linha nasce RASCUNHO. O codigo e unico; quem chegar depois com o MESMO pedido e o
  //    plano ainda sem Price retoma a sincronizacao (idempotencia); qualquer outra colisao e 409.
  const { planId, created } = await withPlatform(deps.pool, { userId: input.userId }, async (client) => {
    await client.query('SAVEPOINT criar_plano');
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO plans (code, name, description, billing_interval, price_cents, currency,
                            max_active_draws, max_team_members, features, status)
         VALUES ($1, $2, $3, $4::plan_interval, $5, $6, $7, $8, $9::text[], 'DRAFT') RETURNING id`,
        [b.code, b.name, b.description ?? null, b.interval, b.priceCents, b.currency, b.maxActiveDraws, b.maxTeamMembers, b.features],
      );
      await recordAuditEvent(client, {
        tenantId: null,
        actorUserId: input.userId,
        actorType: 'PLATFORM',
        action: 'plan.created',
        targetType: 'plan',
        targetId: rows[0]!.id,
        after: { code: b.code, interval: b.interval, priceCents: b.priceCents, currency: b.currency },
        ip: input.origin.ip,
        userAgent: input.origin.userAgent,
      });
      return { planId: rows[0]!.id, created: true };
    } catch (error) {
      if (!isUniqueViolation(error, 'plans_code_key')) throw error;
      await client.query('ROLLBACK TO SAVEPOINT criar_plano');
      const existing = await client
        .query<PlatformPlanRow>(`SELECT ${COLUMNS} FROM plans p WHERE p.code = $1`, [b.code])
        .then((r) => r.rows[0]);
      const mesmoPedido =
        existing !== undefined &&
        existing.stripe_price_id === null &&
        existing.price_cents === b.priceCents &&
        existing.billing_interval === b.interval &&
        existing.currency === b.currency;
      if (!mesmoPedido) {
        throw new ApiError('CONFLICT', 'Já existe um plano com este código.', { reason: 'PLAN_CODE_TAKEN' });
      }
      return { planId: existing.id, created: false };
    }
  });

  // 2. Product e Price na Stripe (idempotente e retomavel).
  const row = await syncPlanWithStripe(deps, gateway, input.userId, planId);
  return { plan: toPlatformPlan(row), created };
}

export async function updatePlan(
  deps: AppDeps,
  input: { userId: string; planId: string; body: UpdatePlanRequest; origin: Origin },
): Promise<PlatformPlan> {
  const b = input.body;
  const sets: string[] = [];
  const values: unknown[] = [input.planId];
  const push = (column: string, value: unknown, cast = '') => {
    values.push(value);
    sets.push(`${column} = $${values.length}${cast}`);
  };
  if (b.name !== undefined) push('name', b.name);
  if (b.description !== undefined) push('description', b.description);
  if (b.maxActiveDraws !== undefined) push('max_active_draws', b.maxActiveDraws);
  if (b.maxTeamMembers !== undefined) push('max_team_members', b.maxTeamMembers);
  if (b.features !== undefined) push('features', b.features, '::text[]');
  if (b.status !== undefined) push('status', b.status, '::plan_status');
  if (sets.length === 0) throw ApiError.badRequest('Informe ao menos um campo para alterar.');

  return withPlatform(deps.pool, { userId: input.userId }, async (client) => {
    const before = await readPlan(client, input.planId);
    if (!before) throw ApiError.notFound('Plano não encontrado.');
    await client.query('SAVEPOINT atualizar_plano');
    try {
      await client.query(`UPDATE plans SET ${sets.join(', ')} WHERE id = $1`, values);
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT atualizar_plano');
      if ((error as { constraint?: string }).constraint === 'plans_available_needs_stripe') {
        throw new ApiError('CONFLICT', 'O plano ainda não existe na Stripe: conclua a sincronização antes de publicá-lo.', {
          reason: 'PLAN_NOT_SYNCED',
        });
      }
      throw error;
    }
    const after = (await readPlan(client, input.planId))!;
    await recordAuditEvent(client, {
      tenantId: null,
      actorUserId: input.userId,
      actorType: 'PLATFORM',
      action: b.status !== undefined && b.status !== before.status ? 'plan.status_changed' : 'plan.updated',
      targetType: 'plan',
      targetId: input.planId,
      before: { status: before.status, maxActiveDraws: before.max_active_draws, maxTeamMembers: before.max_team_members },
      after: { status: after.status, maxActiveDraws: after.max_active_draws, maxTeamMembers: after.max_team_members },
      ip: input.origin.ip,
      userAgent: input.origin.userAgent,
    });
    return toPlatformPlan(after);
  });
}

// ---------------------------------------------------------------------------
// Assinaturas (somente leitura)
// ---------------------------------------------------------------------------

interface SubscriptionRow {
  id: string;
  tenant_id: string;
  tenant_slug: string;
  tenant_name: string;
  plan_code: string;
  plan_name: string;
  status: PlatformSubscriptionListResponse['subscriptions'][number]['status'];
  state: BillingState;
  current_period_end: Date | null;
  past_due_since: Date | null;
  grace_ends_at: Date | null;
  cancel_at_period_end: boolean;
  cursor_t: string;
}

const escapeLike = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listPlatformSubscriptions(
  deps: AppDeps,
  input: { userId: string; state: unknown; q: unknown; cursor: unknown; limit: unknown },
): Promise<PlatformSubscriptionListResponse> {
  const limit = parseLimit(input.limit, 30, 100);
  const cursor = decodeCursor(input.cursor);

  let state: BillingState | null = null;
  if (input.state !== undefined && input.state !== '') {
    if (typeof input.state !== 'string' || !(BILLING_STATES as readonly string[]).includes(input.state)) {
      throw ApiError.badRequest('Estado inválido.');
    }
    state = input.state as BillingState;
  }
  let q: string | null = null;
  if (input.q !== undefined && input.q !== '') {
    if (typeof input.q !== 'string' || input.q.trim() === '' || input.q.length > 80) throw ApiError.badRequest('Busca inválida.');
    q = `%${escapeLike(input.q.trim())}%`;
  }

  const linhas = await withPlatform(deps.pool, { userId: input.userId }, async (client) => {
    // UMA linha por comunidade: a assinatura "atual" (as vivas primeiro, depois a mais recente).
    const { rows } = await client.query<SubscriptionRow>(
      `WITH atual AS (
         SELECT DISTINCT ON (s.tenant_id) s.*
           FROM tenant_subscriptions s
          ORDER BY s.tenant_id,
                   (s.status IN ('trialing', 'active', 'past_due', 'unpaid', 'paused')) DESC,
                   s.updated_at DESC
       )
       SELECT a.id, a.tenant_id, t.slug AS tenant_slug, t.name AS tenant_name, p.code AS plan_code, p.name AS plan_name,
              a.status::text AS status, app.platform_billing_state(a.tenant_id) AS state,
              a.current_period_end, a.past_due_since,
              CASE WHEN a.status = 'past_due' AND a.past_due_since IS NOT NULL
                   THEN a.past_due_since + make_interval(days => bs.past_due_grace_days) END AS grace_ends_at,
              a.cancel_at_period_end, a.updated_at::text AS cursor_t
         FROM atual a
         JOIN tenants t ON t.id = a.tenant_id
         JOIN plans p ON p.id = a.plan_id
         CROSS JOIN billing_settings bs
        WHERE ($1::text IS NULL OR app.platform_billing_state(a.tenant_id) = $1)
          AND ($2::text IS NULL OR t.name ILIKE $2 OR t.slug ILIKE $2)
          AND ($3::timestamptz IS NULL OR (a.updated_at, a.id) < ($3::timestamptz, $4::uuid))
        ORDER BY a.updated_at DESC, a.id DESC
        LIMIT $5`,
      [state, q, cursor?.t ?? null, cursor?.id ?? null, limit + 1],
    );
    return rows;
  });

  const { pagina, nextCursor } = paginate(linhas, limit, (r) => ({ t: r.cursor_t, id: r.id }));
  return {
    nextCursor,
    subscriptions: pagina.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      tenantSlug: r.tenant_slug,
      tenantName: r.tenant_name,
      planCode: r.plan_code,
      planName: r.plan_name,
      status: r.status,
      state: r.state,
      currentPeriodEnd: iso(r.current_period_end),
      pastDueSince: iso(r.past_due_since),
      graceEndsAt: iso(r.grace_ends_at),
      cancelAtPeriodEnd: r.cancel_at_period_end,
    })),
  };
}
