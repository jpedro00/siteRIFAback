import type { PoolClient } from 'pg';
import { withContext, withTenant, type DbPool } from '@clubedarifa/db';
import { STRIPE_EVENT_LEASE_SECONDS } from '@clubedarifa/shared';
import type { BillingGateway, EventEnvelope } from './types.js';

/**
 * Processamento dos eventos do webhook da Stripe.
 *
 * O QUE ESTE ARQUIVO GARANTE
 *  1. O EVENTO NAO DECIDE NADA. Ele so diz "olhe este objeto". O estado vem de uma
 *     CONSULTA a Stripe, feita SOB O LOCK do objeto, na mesma transacao que grava. Assim
 *     um processamento atrasado nunca sobrescreve um mais novo — a ordem nao depende do
 *     `created` do evento (dois eventos dividem o mesmo segundo), e sim de serializar por
 *     objeto e do relogio unico do banco (`begin_stripe_object_sync`).
 *  2. A COMUNIDADE VEM DO NOSSO BANCO: pelo cliente Stripe que NOS criamos
 *     (`tenant_billing`) ou pela sessao de Checkout que NOS gravamos. Nunca por metadado
 *     do payload.
 *  3. SO QUEM TEM O LEASE CONCLUI. `claim_stripe_event` entrega um token; sem ele
 *     `finish_stripe_event` nao faz nada. Processo que travou e perdeu o lease nao
 *     sobrescreve quem o assumiu.
 *  4. `invoice.paid` NAO LIBERA NADA sozinho: a fatura e registrada e a ASSINATURA e
 *     ressincronizada — o acesso segue o estado da assinatura.
 *  5. Falha vira retry com recuo (FAILED); anomalia de seguranca (cliente/assinatura de
 *     outra comunidade) vira DEAD na hora, sem retry.
 */

export type ProcessOutcome = 'PROCESSED' | 'IGNORED' | 'FAILED' | 'DEAD' | 'SKIPPED';

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface ProcessorDeps {
  readonly pool: DbPool;
  readonly gateway: BillingGateway;
  readonly log?: Logger;
  /** Lease do evento em processamento, em segundos. */
  readonly leaseSeconds?: number;
}

interface Verdict {
  readonly status: 'PROCESSED' | 'IGNORED' | 'FAILED' | 'DEAD';
  readonly tenantId?: string | null;
  readonly error?: string;
}

interface ClaimedEvent {
  readonly lease_token: string;
  readonly event_type: string;
  readonly object_type: string | null;
  readonly object_id: string | null;
  readonly customer_id: string | null;
  readonly stripe_created_at: Date;
  readonly attempts: number;
  readonly payload: Record<string, unknown> | null;
}

const NULL_CONTEXT = { userId: null, tenantId: null, platformAccess: false } as const;

/** Tira qualquer coisa que pareca chave da Stripe de uma mensagem de erro. */
export function redact(message: string): string {
  return message.replace(/\b(sk|rk|pk|whsec)_[A-Za-z0-9_]+/g, '[redigido]').slice(0, 300);
}

// ---------------------------------------------------------------------------
// Recepcao (usada pelo endpoint do webhook)
// ---------------------------------------------------------------------------

/** Grava o evento com DURABILIDADE. Idempotente por `event_id`. */
export async function recordStripeEvent(
  pool: DbPool,
  envelope: EventEnvelope,
): Promise<'NEW' | 'DUPLICATE_DONE' | 'DUPLICATE_PENDING'> {
  return withContext(pool, NULL_CONTEXT, async (client) => {
    const { rows } = await client.query<{ r: 'NEW' | 'DUPLICATE_DONE' | 'DUPLICATE_PENDING' }>(
      'SELECT app.record_stripe_event($1, $2, $3, $4, $5, $6, $7, $8::jsonb) AS r',
      [
        envelope.id,
        envelope.type,
        envelope.created,
        envelope.livemode,
        envelope.objectType,
        envelope.objectId,
        envelope.customerId,
        JSON.stringify(envelope.summary),
      ],
    );
    return rows[0]!.r;
  });
}

// ---------------------------------------------------------------------------
// Processamento
// ---------------------------------------------------------------------------

/**
 * Pega o evento (lease) e o processa. Devolve `SKIPPED` se nao estava pronto: ja
 * concluido, em andamento com lease vigente ou aguardando o recuo do retry.
 */
export async function processStripeEvent(deps: ProcessorDeps, eventId: string): Promise<ProcessOutcome> {
  const claimed = await withContext(deps.pool, NULL_CONTEXT, async (client) => {
    const { rows } = await client.query<ClaimedEvent>(
      'SELECT * FROM app.claim_stripe_event($1, $2)',
      [eventId, deps.leaseSeconds ?? STRIPE_EVENT_LEASE_SECONDS],
    );
    return rows[0] ?? null;
  });
  if (!claimed) return 'SKIPPED';

  let verdict: Verdict;
  try {
    verdict = await handle(deps, claimed);
  } catch (error) {
    // Rede, Stripe fora, plano ainda nao sincronizado, deadlock... tenta de novo.
    verdict = { status: 'FAILED', error: redact(error instanceof Error ? error.message : String(error)) };
    deps.log?.warn('stripe.event_failed', { eventId, type: claimed.event_type, error: verdict.error });
  }

  const finish = async (client: PoolClient): Promise<boolean> => {
    const { rows } = await client.query<{ ok: boolean }>(
      'SELECT app.finish_stripe_event($1, $2, $3::stripe_event_status, $4, $5) AS ok',
      [eventId, claimed.lease_token, verdict.status, verdict.tenantId ?? null, verdict.error ?? null],
    );
    return rows[0]!.ok;
  };
  const concluded = verdict.tenantId
    ? await withTenant(deps.pool, { tenantId: verdict.tenantId }, finish)
    : await withContext(deps.pool, NULL_CONTEXT, finish);

  if (!concluded) {
    // Perdemos o lease: outro processo assumiu o evento. O resultado dele vale.
    deps.log?.warn('stripe.event_lease_lost', { eventId });
    return 'SKIPPED';
  }
  return verdict.status;
}

/** Worker: processa os eventos que estao na hora (novos, falhos liberados, lease vencido). */
export async function processDueStripeEvents(
  deps: ProcessorDeps,
  limit = 50,
): Promise<Record<ProcessOutcome, number>> {
  const due = await withContext(deps.pool, NULL_CONTEXT, async (client) => {
    const { rows } = await client.query<{ event_id: string }>('SELECT event_id FROM app.list_stripe_events_due($1)', [
      limit,
    ]);
    return rows.map((r) => r.event_id);
  });
  const totals: Record<ProcessOutcome, number> = { PROCESSED: 0, IGNORED: 0, FAILED: 0, DEAD: 0, SKIPPED: 0 };
  for (const id of due) totals[await processStripeEvent(deps, id)] += 1;
  return totals;
}

// ---------------------------------------------------------------------------
// Roteamento
// ---------------------------------------------------------------------------

async function tenantByCustomer(deps: ProcessorDeps, customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  return withContext(deps.pool, NULL_CONTEXT, async (client) => {
    const { rows } = await client.query<{ t: string | null }>(
      'SELECT app.resolve_tenant_by_stripe_customer($1) AS t',
      [customerId],
    );
    return rows[0]!.t;
  });
}

async function tenantByCheckout(deps: ProcessorDeps, sessionId: string | null): Promise<string | null> {
  if (!sessionId) return null;
  return withContext(deps.pool, NULL_CONTEXT, async (client) => {
    const { rows } = await client.query<{ t: string | null }>(
      'SELECT app.resolve_tenant_by_checkout_session($1) AS t',
      [sessionId],
    );
    return rows[0]!.t;
  });
}

async function handle(deps: ProcessorDeps, ev: ClaimedEvent): Promise<Verdict> {
  switch (ev.event_type) {
    case 'checkout.session.completed': {
      const fromSession = await tenantByCheckout(deps, ev.object_id);
      if (!fromSession) {
        return { status: 'IGNORED', error: 'Checkout que nao foi criado por esta plataforma.' };
      }
      const fromCustomer = await tenantByCustomer(deps, ev.customer_id);
      if (fromCustomer !== fromSession) {
        return { status: 'DEAD', tenantId: fromSession, error: 'Cliente do Checkout nao pertence a comunidade da sessao.' };
      }
      await withTenant(deps.pool, { tenantId: fromSession }, (client) =>
        client.query('SELECT app.set_checkout_session_status($1, $2, $3)', [fromSession, ev.object_id, 'COMPLETED']),
      );
      const subscriptionId = typeof ev.payload?.['subscriptionId'] === 'string' ? (ev.payload['subscriptionId'] as string) : null;
      // O Checkout concluido NAO libera nada: so aponta para a assinatura, que e ressincronizada.
      if (!subscriptionId) return { status: 'PROCESSED', tenantId: fromSession };
      return syncSubscription(deps, fromSession, subscriptionId, ev.customer_id!, null);
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const tenantId = await tenantByCustomer(deps, ev.customer_id);
      if (!tenantId || !ev.object_id) return unknownCustomer();
      return syncSubscription(deps, tenantId, ev.object_id, ev.customer_id!, null);
    }

    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const tenantId = await tenantByCustomer(deps, ev.customer_id);
      if (!tenantId || !ev.object_id) return unknownCustomer();
      const invoice = await syncInvoice(deps, tenantId, ev.object_id, ev.customer_id!);
      if (invoice.verdict.status !== 'PROCESSED') return invoice.verdict;
      if (!invoice.subscriptionId) return { status: 'PROCESSED', tenantId };
      // O ancora da tolerancia de um atraso e o momento da FALHA da cobranca.
      const anchor = ev.event_type === 'invoice.payment_failed' ? ev.stripe_created_at : null;
      return syncSubscription(deps, tenantId, invoice.subscriptionId, ev.customer_id!, anchor);
    }

    default:
      return { status: 'IGNORED', error: `Evento ${ev.event_type} nao e tratado.` };
  }
}

function unknownCustomer(): Verdict {
  return { status: 'IGNORED', error: 'Cliente Stripe sem comunidade nesta plataforma.' };
}

// ---------------------------------------------------------------------------
// Sincronizacao de objetos
// ---------------------------------------------------------------------------

function fromApplyResult(result: string, tenantId: string): Verdict | null {
  switch (result) {
    case 'applied':
    case 'stale': // ja ha um estado MAIS NOVO gravado: este processamento nao tem o que acrescentar
      return null;
    case 'unknown_plan':
      return { status: 'FAILED', tenantId, error: 'Plano ainda nao sincronizado (Price desconhecido).' };
    default:
      // forbidden | customer_mismatch: anomalia, sem retry.
      return { status: 'DEAD', tenantId, error: `Recusado pelo banco: ${result}.` };
  }
}

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';

async function syncSubscription(
  deps: ProcessorDeps,
  tenantId: string,
  subscriptionId: string,
  customerId: string,
  pastDueAt: Date | null,
): Promise<Verdict> {
  try {
    return await withTenant(deps.pool, { tenantId }, async (client): Promise<Verdict> => {
      // 1. Lock do objeto + relogio do banco. 2. Consulta a Stripe SOB o lock. 3. Grava.
      const { rows: t } = await client.query<{ t: Date }>('SELECT app.begin_stripe_object_sync($1, $2) AS t', [
        'sub',
        subscriptionId,
      ]);
      const snap = await deps.gateway.retrieveSubscription(subscriptionId);
      if (snap.customerId !== customerId) {
        return { status: 'DEAD', tenantId, error: 'A assinatura pertence a outro cliente Stripe.' };
      }
      if (!snap.priceId) {
        return { status: 'FAILED', tenantId, error: 'Assinatura sem item/Price.' };
      }
      const { rows } = await client.query<{ r: string }>(
        `SELECT app.apply_stripe_subscription($1,$2,$3,$4,$5::subscription_status,$6,$7,$8,$9,$10,$11,$12,$13) AS r`,
        [
          tenantId,
          snap.id,
          snap.customerId,
          snap.priceId,
          snap.status,
          snap.currentPeriodStart,
          snap.currentPeriodEnd,
          snap.cancelAtPeriodEnd,
          snap.cancelAt,
          snap.canceledAt,
          snap.trialEnd,
          pastDueAt,
          t[0]!.t,
        ],
      );
      return fromApplyResult(rows[0]!.r, tenantId) ?? { status: 'PROCESSED', tenantId };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Uma segunda assinatura VIVA para a mesma comunidade: caso para a operacao.
      return {
        status: 'DEAD',
        tenantId,
        error: 'Segunda assinatura viva para a mesma comunidade (verificar cobranca duplicada na Stripe).',
      };
    }
    throw error;
  }
}

async function syncInvoice(
  deps: ProcessorDeps,
  tenantId: string,
  invoiceId: string,
  customerId: string,
): Promise<{ verdict: Verdict; subscriptionId: string | null }> {
  let subscriptionId: string | null = null;
  const verdict = await withTenant(deps.pool, { tenantId }, async (client): Promise<Verdict> => {
    const { rows: t } = await client.query<{ t: Date }>('SELECT app.begin_stripe_object_sync($1, $2) AS t', [
      'inv',
      invoiceId,
    ]);
    const inv = await deps.gateway.retrieveInvoice(invoiceId);
    if (inv.customerId !== customerId) {
      return { status: 'DEAD', tenantId, error: 'A fatura pertence a outro cliente Stripe.' };
    }
    subscriptionId = inv.subscriptionId;
    const { rows } = await client.query<{ r: string }>(
      `SELECT app.apply_stripe_invoice($1,$2,$3,$4,$5::invoice_status,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) AS r`,
      [
        tenantId,
        inv.id,
        inv.customerId,
        inv.subscriptionId,
        inv.status,
        inv.currency,
        inv.amountDueCents,
        inv.amountPaidCents,
        inv.amountRemainingCents,
        inv.attemptCount,
        inv.periodStart,
        inv.periodEnd,
        inv.paidAt,
        inv.hostedInvoiceUrl,
        inv.createdAt,
        t[0]!.t,
      ],
    );
    return fromApplyResult(rows[0]!.r, tenantId) ?? { status: 'PROCESSED', tenantId };
  });
  return { verdict, subscriptionId };
}
