import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, type DbPool } from '@clubedarifa/db';
import { createConnectRuntime, type ConnectRuntime } from '@clubedarifa/payment-accounts';
import { FakeStripe } from '@clubedarifa/payment-accounts/testing';
import { conciliacao, expirarPix, finalizarDesconexoesPagamento, limparStripeEventos } from '../src/jobs/definitions.js';
import type { JobContext } from '../src/jobs/types.js';
import { hasDb, openBench, seedDraw, seedPendingOrder, seedTenant, silentLog, skipReason, unique, type Bench } from './helpers/seed.js';

/**
 * Jobs de PIX com pagamentos STRIPE (Connect), contra PostgreSQL real e com o papel restrito
 * `app_worker`, sobre uma Stripe FALSA em memoria. Mesmas regras do Mercado Pago (RN06): o PIX
 * vencido so e liberado depois de a Stripe CONFIRMAR que nao foi pago; pago na Stripe = aplica pelo
 * `app.apply_psp_payment`; consulta que falha = nada muda e o proximo ciclo tenta de novo.
 * Nenhuma chave real: so `sk_test_fake_for_unit_tests`.
 */
const APP_URL = process.env['TEST_APP_DATABASE_URL'] ?? '';
const FAKE_KEY = 'sk_test_fake_for_unit_tests';

describe.skipIf(!hasDb || APP_URL === '')(`Jobs com pagamentos Stripe Connect ${hasDb ? '' : skipReason}`, () => {
  let bench: Bench;
  let appPool: DbPool;
  let stripe: FakeStripe;
  /** O da API: so para o cadastro do cenario. */
  let apiConnect: ConnectRuntime;
  /** O do worker: sem URL de retorno (nao faz cadastro), com o pool `app_worker`. */
  let workerConnect: ConnectRuntime;
  let ctx: JobContext;
  let nextNumber = 1;

  beforeAll(async () => {
    bench = await openBench('test-connect-jobs');
    appPool = createPool({ connectionString: APP_URL, applicationName: 'test-connect-jobs-app', max: 4 });
    stripe = new FakeStripe();
    apiConnect = createConnectRuntime(appPool, {
      secretKey: FAKE_KEY,
      returnBaseUrl: 'https://organizer.test',
      environment: 'SANDBOX',
      client: stripe.asClient(),
    });
    workerConnect = createConnectRuntime(bench.worker, { secretKey: FAKE_KEY, environment: 'SANDBOX', client: stripe.asClient() });
    ctx = { pool: bench.worker, log: silentLog, paymentAccounts: null, connect: workerConnect };
  }, 120_000);

  afterAll(async () => {
    await bench?.close();
    await appPool?.end();
  });

  async function comunidade() {
    const tenantId = await seedTenant(bench.owner);
    const { rows } = await bench.owner.query<{ id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Dono') RETURNING id`,
      [`${unique('dono-')}@example.com`],
    );
    const userId = rows[0]!.id;
    await bench.owner.query(`INSERT INTO memberships (tenant_id, user_id, role, accepted_at) VALUES ($1, $2, 'OWNER', now())`, [tenantId, userId]);
    const { url } = await apiConnect.beginOnboarding({ tenantId, userId });
    const acct = url.split('/')[4]!;
    stripe.ready(acct);
    await apiConnect.syncAccount(acct);
    return { tenantId, userId, acct };
  }

  /** Pedido com PIX STRIPE vencido, cobrado de verdade na Stripe falsa pela conta da comunidade. */
  async function pedidoComPix(c: { tenantId: string }) {
    const draw = await seedDraw(bench.owner, c.tenantId);
    const pedido = await seedPendingOrder(bench.owner, c.tenantId, draw, [nextNumber++], { payment: false });
    const { gateway, paymentAccountId } = await workerConnect.resolver.forTenant(c.tenantId);
    const cobranca = await gateway.createPixCharge({
      idempotencyKey: pedido.orderId,
      amountCents: 1000,
      description: 'Teste',
      externalReference: pedido.orderId,
      payerEmail: 'maria@example.com',
      payerName: 'Maria',
      expiresAt: new Date(Date.now() + 30 * 60_000),
      notificationUrl: null,
      platformFeeCents: 50,
    });
    const { rows } = await bench.owner.query<{ id: string }>(
      `INSERT INTO payments (tenant_id, order_id, provider, provider_payment_id, status, idempotency_key, amount_cents,
                             expires_at, payment_account_id, platform_fee_bps, platform_fee_cents)
       VALUES ($1, $2, 'STRIPE', $3, 'PENDENTE', $4, 1000, now() - interval '10 minutes', $5, 500, 50) RETURNING id`,
      [c.tenantId, pedido.orderId, cobranca.providerPaymentId, pedido.orderId, paymentAccountId],
    );
    return { ...pedido, paymentId: rows[0]!.id, pi: cobranca.providerPaymentId, accountId: paymentAccountId };
  }

  const statusPedido = async (orderId: string) =>
    (await bench.owner.query<{ status: string }>('SELECT status::text AS status FROM orders WHERE id = $1', [orderId])).rows[0]!.status;
  const consultas = (pi: string) => stripe.retrieved.filter((id) => id === pi).length;

  // -------------------------------------------------------------------------
  describe('expirar-pix', () => {
    it('PIX STRIPE vencido e NAO pago na Stripe: consulta a Stripe e so entao libera', async () => {
      const c = await comunidade();
      const p = await pedidoComPix(c);
      await expirarPix.run(ctx);
      expect(consultas(p.pi)).toBe(1);
      expect(await statusPedido(p.orderId)).toBe('CANCELADO');
    });

    it('PIX STRIPE vencido mas PAGO na Stripe: aplica o pagamento, nao libera', async () => {
      const c = await comunidade();
      const p = await pedidoComPix(c);
      stripe.setIntentStatus(p.pi, 'succeeded');
      await expirarPix.run(ctx);
      expect(consultas(p.pi)).toBe(1);
      expect(await statusPedido(p.orderId)).toBe('PAGO');
      const { rows } = await bench.owner.query<{ status: string }>('SELECT status::text AS status FROM payments WHERE id = $1', [p.paymentId]);
      expect(rows[0]!.status).toBe('APROVADO');
    });

    it('Stripe fora: nada e liberado, e o proximo ciclo conclui', async () => {
      const c = await comunidade();
      const p = await pedidoComPix(c);
      stripe.setIntentStatus(p.pi, 'succeeded');
      stripe.failNextRetrieveOf.set(p.pi, Object.assign(new Error('rede'), { type: 'StripeConnectionError' }));
      await expirarPix.run(ctx);
      expect(consultas(p.pi)).toBe(1);
      expect(await statusPedido(p.orderId)).toBe('PENDENTE');
      await expirarPix.run(ctx);
      expect(consultas(p.pi)).toBe(2);
      expect(await statusPedido(p.orderId)).toBe('PAGO');
    });

    it('Connect desligado no worker: pagamento STRIPE nao e consultado nem liberado', async () => {
      const c = await comunidade();
      const p = await pedidoComPix(c);
      await expirarPix.run({ ...ctx, connect: null });
      expect(consultas(p.pi)).toBe(0);
      expect(await statusPedido(p.orderId)).toBe('PENDENTE');
    });

    it('conta da Stripe REVOGADA: nao finge que consulta — nada e liberado', async () => {
      const c = await comunidade();
      const p = await pedidoComPix(c);
      await bench.owner.query(`UPDATE tenant_payment_accounts SET status = 'REVOKED' WHERE id = $1`, [p.accountId]);
      await expirarPix.run(ctx);
      expect(consultas(p.pi)).toBe(0);
      expect(await statusPedido(p.orderId)).toBe('PENDENTE');
    });
  });

  // -------------------------------------------------------------------------
  describe('conciliacao', () => {
    it('pagamento STRIPE aprovado sem webhook: registra a divergencia e cura', async () => {
      const c = await comunidade();
      const p = await pedidoComPix(c);
      await bench.owner.query(`UPDATE payments SET expires_at = now() + interval '20 minutes' WHERE id = $1`, [p.paymentId]);
      stripe.setIntentStatus(p.pi, 'succeeded');

      await conciliacao.run(ctx);

      expect(await statusPedido(p.orderId)).toBe('PAGO');
      const { rows } = await bench.owner.query('SELECT 1 FROM payment_reconciliation_issues WHERE payment_id = $1', [p.paymentId]);
      expect(rows).toHaveLength(1);
    });

    it('Connect desligado no worker: pagamento STRIPE nao e consultado nem alterado', async () => {
      const c = await comunidade();
      const p = await pedidoComPix(c);
      await bench.owner.query(`UPDATE payments SET expires_at = now() + interval '20 minutes' WHERE id = $1`, [p.paymentId]);
      stripe.setIntentStatus(p.pi, 'succeeded');
      await conciliacao.run({ ...ctx, connect: null });
      expect(consultas(p.pi)).toBe(0);
      expect(await statusPedido(p.orderId)).toBe('PENDENTE');
    });
  });

  // -------------------------------------------------------------------------
  describe('finalizar-desconexoes-pagamento so com o Connect', () => {
    it('espera o PIX STRIPE pendente; resolvido, conclui a desconexao', async () => {
      const c = await comunidade();
      const p = await pedidoComPix(c);
      await bench.owner.query(`UPDATE tenant_payment_accounts SET status = 'DISCONNECTING', disconnect_requested_at = now() WHERE id = $1`, [
        p.accountId,
      ]);
      const st = async () =>
        (await bench.owner.query<{ status: string }>('SELECT status::text AS status FROM tenant_payment_accounts WHERE id = $1', [p.accountId]))
          .rows[0]!.status;

      await finalizarDesconexoesPagamento.run(ctx);
      expect(await st()).toBe('DISCONNECTING');

      stripe.setIntentStatus(p.pi, 'succeeded');
      await expirarPix.run(ctx); // a conta em DISCONNECTING ainda consulta (SETTLE)
      expect(await statusPedido(p.orderId)).toBe('PAGO');
      await bench.owner.query(`UPDATE payments SET created_at = now() - interval '10 days' WHERE id = $1`, [p.paymentId]);

      expect(await finalizarDesconexoesPagamento.run(ctx)).toBeGreaterThanOrEqual(1);
      expect(await st()).toBe('DISCONNECTED');
    });
  });

  // -------------------------------------------------------------------------
  describe('limpar-stripe-eventos tambem limpa os eventos do webhook Connect', () => {
    it('apaga so o processado alem da retencao; o nao processado fica, por mais antigo que seja', async () => {
      const id = () => unique('evt_').replace(/[^A-Za-z0-9_]/g, '');
      const velho = id();
      const recente = id();
      const pendente = id();
      await bench.owner.query(
        `INSERT INTO stripe_connect_webhook_events (event_id, type, received_at, processed_at) VALUES
           ($1, 'account.updated', now() - interval '40 days', now() - interval '31 days'),
           ($2, 'account.updated', now() - interval '40 days', now() - interval '29 days'),
           ($3, 'account.updated', now() - interval '400 days', NULL)`,
        [velho, recente, pendente],
      );

      expect(await limparStripeEventos.run(ctx)).toBeGreaterThanOrEqual(1);

      const { rows } = await bench.owner.query<{ event_id: string }>(
        'SELECT event_id FROM stripe_connect_webhook_events WHERE event_id = ANY($1::text[])',
        [[velho, recente, pendente]],
      );
      expect(rows.map((r) => r.event_id).sort()).toEqual([recente, pendente].sort());
    });

    it('so o worker purga: outro papel chamando a funcao nao apaga nada', async () => {
      const velho = unique('evt_').replace(/[^A-Za-z0-9_]/g, '');
      await bench.owner.query(
        `INSERT INTO stripe_connect_webhook_events (event_id, type, received_at, processed_at)
         VALUES ($1, 'account.updated', now() - interval '40 days', now() - interval '35 days')`,
        [velho],
      );
      // O papel da API nem tem EXECUTE; o dono (fora do `app_worker`) cai na guarda e nao apaga.
      await expect(appPool.query('SELECT app.purge_connect_webhook_events(30)')).rejects.toThrow(/permission denied/);
      const { rows } = await bench.owner.query<{ n: number }>('SELECT app.purge_connect_webhook_events(30) AS n');
      expect(rows[0]!.n).toBe(0);
      const { rows: ainda } = await bench.owner.query('SELECT 1 FROM stripe_connect_webhook_events WHERE event_id = $1', [velho]);
      expect(ainda).toHaveLength(1);
    });
  });
});
