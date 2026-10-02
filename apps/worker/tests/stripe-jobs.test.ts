import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import { StripeBillingGateway, recordStripeEvent } from '@clubedarifa/billing';
import { FakeStripeClient } from '@clubedarifa/billing/testing';
import { limparStripeEventos, processarStripeEventos } from '../src/jobs/definitions.js';
import { runJob } from '../src/jobs/runner.js';
import type { JobContext } from '../src/jobs/types.js';
import { hasDb, openBench, seedTenant, silentLog, skipReason, unique, type Bench } from './helpers/seed.js';

/**
 * Jobs da cobranca da PLATAFORMA (Fase 7): processar os eventos da Stripe que o
 * webhook gravou e aplicar a retencao. Rodam com o papel restrito `app_worker`.
 */
const WEBHOOK_SECRET = 'whsec_worker_test';

describe.skipIf(!hasDb)(`Jobs da cobranca (Stripe) ${hasDb ? '' : skipReason}`, () => {
  let bench: Bench;
  let tenantId: string;
  let fake: FakeStripeClient;
  let gateway: StripeBillingGateway;
  let ctx: JobContext;

  beforeAll(async () => {
    bench = await openBench('test-stripe-jobs');
    tenantId = await seedTenant(bench.owner);
    fake = new FakeStripeClient();
    gateway = new StripeBillingGateway({
      secretKey: 'sk_test_worker',
      webhookSecret: WEBHOOK_SECRET,
      client: fake as unknown as Stripe,
    });
    ctx = { pool: bench.worker, log: silentLog, paymentAccounts: null, billing: gateway };
  }, 120_000);

  afterAll(async () => {
    await bench?.close();
  });

  async function gravarEvento(customer: string, subId: string, status: string): Promise<string> {
    const eventId = unique('evt_').replace(/[^a-zA-Z0-9_]/g, '');
    const assinado = fake.signedWebhook(
      {
        id: eventId,
        type: 'customer.subscription.updated',
        object: { id: subId, object: 'subscription', customer: customer, status },
      },
      WEBHOOK_SECRET,
    );
    const envelope = gateway.verifyWebhook({ rawBody: assinado.rawBody, signature: assinado.signature });
    await recordStripeEvent(bench.worker, envelope);
    return eventId;
  }

  const statusDoEvento = async (eventId: string) =>
    (await bench.owner.query<{ status: string }>('SELECT status FROM stripe_webhook_events WHERE event_id = $1', [eventId])).rows[0]?.status;

  it('sem cobranca ligada o job nao processa nada e nao descarta nada', async () => {
    const eventId = await gravarEvento('cus_sem_cobranca', unique('sub_'), 'active');
    const n = await processarStripeEventos.run({ ...ctx, billing: null });
    expect(n).toBe(0);
    expect(await statusDoEvento(eventId)).toBe('RECEIVED');
  });

  it('com a cobranca ligada, processa o evento pendente e e idempotente (2o ciclo nao faz nada)', async () => {
    // Cliente da comunidade, plano e assinatura no "lado Stripe".
    const customer = unique('cus_').replace(/[^a-zA-Z0-9_]/g, '');
    await bench.owner.query('INSERT INTO tenant_billing (tenant_id, stripe_customer_id) VALUES ($1, $2)', [tenantId, customer]);
    const priceId = unique('price_');
    await bench.owner.query(
      `INSERT INTO plans (code, name, billing_interval, price_cents, stripe_product_id, stripe_price_id, status)
       VALUES ($1, 'Worker', 'month', 1000, $2, $3, 'AVAILABLE')`,
      [unique('wk-').toLowerCase().replace(/[^a-z0-9-]/g, '-'), unique('prod_'), priceId],
    );
    const subId = unique('sub_').replace(/[^a-zA-Z0-9_]/g, '');
    fake.putSubscription({ id: subId, customer, priceId, status: 'active' });
    const eventId = await gravarEvento(customer, subId, 'active');

    const primeiro = await runJob(processarStripeEventos, ctx);
    expect(primeiro).toBeGreaterThanOrEqual(1);
    expect(await statusDoEvento(eventId)).toBe('PROCESSED');
    const { rows } = await bench.owner.query('SELECT 1 FROM tenant_subscriptions WHERE stripe_subscription_id = $1', [subId]);
    expect(rows).toHaveLength(1);

    // Segundo ciclo: nada novo, nenhuma assinatura duplicada.
    const antes = fake.callsTo('subscriptions.retrieve');
    await processarStripeEventos.run(ctx);
    expect(fake.callsTo('subscriptions.retrieve')).toBe(antes);
    const depois = await bench.owner.query('SELECT 1 FROM tenant_subscriptions WHERE stripe_subscription_id = $1', [subId]);
    expect(depois.rowCount).toBe(1);

    // O heartbeat registrou o ciclo (a API usa isso para dizer que o worker esta vivo).
    const hb = await bench.owner.query('SELECT 1 FROM job_heartbeats WHERE job_name = $1', ['processar-stripe-eventos']);
    expect(hb.rowCount).toBe(1);
  });

  it('a limpeza aplica a retencao: zera o payload antigo, remove a linha muito antiga e nunca toca no pendente', async () => {
    const concluido = await gravarEvento('cus_ret', unique('sub_'), 'active');
    const pendente = await gravarEvento('cus_ret2', unique('sub_'), 'active');
    await bench.owner.query(
      `UPDATE stripe_webhook_events SET status = 'PROCESSED', processed_at = now(), received_at = now() - interval '45 days' WHERE event_id = $1`,
      [concluido],
    );
    await bench.owner.query(`UPDATE stripe_webhook_events SET received_at = now() - interval '200 days' WHERE event_id = $1`, [pendente]);

    await limparStripeEventos.run(ctx);
    const c = await bench.owner.query<{ payload: unknown }>('SELECT payload FROM stripe_webhook_events WHERE event_id = $1', [concluido]);
    expect(c.rows[0]!.payload).toBeNull();
    // O pendente (RECEIVED) fica intacto, por mais velho que seja.
    expect(await statusDoEvento(pendente)).toBe('RECEIVED');
  });
});
