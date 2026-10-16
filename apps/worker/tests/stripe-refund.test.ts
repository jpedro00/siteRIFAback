import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, type DbPool } from '@clubedarifa/db';
import { createConnectRuntime, type ConnectRuntime } from '@clubedarifa/payment-accounts';
import { FakeStripe } from '@clubedarifa/payment-accounts/testing';
import { handleMessage } from '../src/dispatch.js';
import { aplicarPagamentoDoPsp, expirarPix } from '../src/jobs/definitions.js';
import type { JobContext } from '../src/jobs/types.js';
import type { QueueMessage } from '../src/queue.js';
import { hasDb, openBench, seedDraw, seedOutboxEvent, seedPendingOrder, seedTenant, silentLog, skipReason, unique, type Bench } from './helpers/seed.js';

/**
 * Estorno AUTOMATICO de pagamento STRIPE que nao pode ser honrado (`payment.refund_required`).
 *
 * O cenario nasce pelo caminho real: PIX vencido e liberado pelo worker, numero tomado por outra
 * reserva, e so depois a Stripe diz que foi pago -> `app.apply_psp_payment` marca
 * `needs_manual_refund` e grava o evento. O consumidor estorna pela conta ORIGINAL do pagamento,
 * devolvendo a taxa da plataforma, e confirma pela CONSULTA a Stripe (RN06).
 * Mercado Pago continua manual: nenhum pedido sai para a Stripe. Chave falsa apenas.
 */
const APP_URL = process.env['TEST_APP_DATABASE_URL'] ?? '';
const FAKE_KEY = 'sk_test_fake_for_unit_tests';

describe.skipIf(!hasDb || APP_URL === '')(`Estorno automatico Stripe ${hasDb ? '' : skipReason}`, () => {
  let bench: Bench;
  let appPool: DbPool;
  let stripe: FakeStripe;
  let apiConnect: ConnectRuntime;
  let workerConnect: ConnectRuntime;
  let ctx: JobContext;
  let nextNumber = 1;

  beforeAll(async () => {
    bench = await openBench('test-stripe-refund');
    appPool = createPool({ connectionString: APP_URL, applicationName: 'test-stripe-refund-app', max: 4 });
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
    await bench.owner.query(`INSERT INTO memberships (tenant_id, user_id, role, accepted_at) VALUES ($1, $2, 'OWNER', now())`, [
      tenantId,
      rows[0]!.id,
    ]);
    const { url } = await apiConnect.beginOnboarding({ tenantId, userId: rows[0]!.id });
    const acct = url.split('/')[4]!;
    stripe.ready(acct);
    await apiConnect.syncAccount(acct);
    return { tenantId };
  }

  /**
   * Pagamento STRIPE pago DEPOIS de o pedido ter sido cancelado e o numero ter outro dono: o banco
   * marca `needs_manual_refund` e grava `payment.refund_required`. Devolve o evento da outbox.
   */
  async function pagoQueNaoPodeSerHonrado() {
    const c = await comunidade();
    const draw = await seedDraw(bench.owner, c.tenantId);
    const numero = nextNumber++;
    const pedido = await seedPendingOrder(bench.owner, c.tenantId, draw, [numero], { payment: false });
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
    const pi = cobranca.providerPaymentId;
    const { rows } = await bench.owner.query<{ id: string }>(
      `INSERT INTO payments (tenant_id, order_id, provider, provider_payment_id, status, idempotency_key, amount_cents,
                             expires_at, payment_account_id, platform_fee_bps, platform_fee_cents)
       VALUES ($1, $2, 'STRIPE', $3, 'PENDENTE', $4, 1000, now() - interval '10 minutes', $5, 500, 50) RETURNING id`,
      [c.tenantId, pedido.orderId, pi, pedido.orderId, paymentAccountId],
    );
    const paymentId = rows[0]!.id;

    // O worker confere na Stripe (nao pago) e libera; outra pessoa reserva o numero.
    await expirarPix.run(ctx);
    await bench.owner.query(`UPDATE draw_numbers SET expires_at = now() + interval '10 minutes' WHERE draw_id = $1 AND number = $2`, [
      draw,
      numero,
    ]);
    // So agora o comprador paga.
    stripe.setIntentStatus(pi, 'succeeded');
    const r = await aplicarPagamentoDoPsp(bench.worker, 'STRIPE', await gateway.getPayment(pi), paymentAccountId);
    expect(r).toBe('refund_required');

    const { rows: ev } = await bench.owner.query<{ id: string; payload: Record<string, unknown> }>(
      `SELECT id, payload FROM outbox WHERE event_type = 'payment.refund_required' AND payload->>'paymentId' = $1`,
      [paymentId],
    );
    expect(ev).toHaveLength(1);
    const message: QueueMessage = {
      outboxEventId: ev[0]!.id,
      tenantId: c.tenantId,
      eventType: 'payment.refund_required',
      payload: ev[0]!.payload,
    };
    return { ...c, paymentId, pi, paymentAccountId, orderId: pedido.orderId, message };
  }

  const pagamento = async (id: string) =>
    (
      await bench.owner.query<{ status: string; needs_manual_refund: boolean }>(
        'SELECT status::text AS status, needs_manual_refund FROM payments WHERE id = $1',
        [id],
      )
    ).rows[0]!;
  const estornosDe = (pi: string) => stripe.refundCalls.filter((c) => c.params['payment_intent'] === pi);
  const entregar = (m: QueueMessage, connect: ConnectRuntime | null = workerConnect) => handleMessage(bench.worker, m, { connect });

  it('estorna pela conta original, devolvendo a taxa, com chave estavel; a consulta confirma ESTORNADO', async () => {
    const p = await pagoQueNaoPodeSerHonrado();
    expect(await pagamento(p.paymentId)).toEqual({ status: 'APROVADO', needs_manual_refund: true });

    await entregar(p.message);

    const estornos = estornosDe(p.pi);
    expect(estornos).toHaveLength(1);
    expect(estornos[0]!.params).toEqual({ payment_intent: p.pi, refund_application_fee: true, reverse_transfer: true });
    expect(estornos[0]!.opts).toEqual({ idempotencyKey: `${p.paymentId}:refund` });
    // O sinal fica (historico); o painel conta so `needs_manual_refund AND status <> 'ESTORNADO'`.
    expect(await pagamento(p.paymentId)).toEqual({ status: 'ESTORNADO', needs_manual_refund: true });

    // Reentrega (a fila tenta de novo): ja estornado, nada sai para a Stripe.
    await entregar(p.message);
    expect(estornosDe(p.pi)).toHaveLength(1);
  });

  it('Stripe fora no estorno: falha (a fila tenta de novo), o sinal fica, e o retry usa a MESMA chave', async () => {
    const p = await pagoQueNaoPodeSerHonrado();
    stripe.failNextRefund = Object.assign(new Error('rede'), { type: 'StripeConnectionError' });

    await expect(entregar(p.message)).rejects.toThrow();
    expect(await pagamento(p.paymentId)).toEqual({ status: 'APROVADO', needs_manual_refund: true });

    await entregar(p.message);
    const chaves = estornosDe(p.pi).map((c) => c.opts?.['idempotencyKey']);
    expect(chaves).toEqual([`${p.paymentId}:refund`, `${p.paymentId}:refund`]);
    expect((await pagamento(p.paymentId)).status).toBe('ESTORNADO');
  });

  it('credencial recusada (401) no estorno: tambem e transitorio — falha para a fila tentar de novo', async () => {
    const p = await pagoQueNaoPodeSerHonrado();
    stripe.failNextRefund = Object.assign(new Error('auth'), { type: 'StripeAuthenticationError', statusCode: 401 });
    await expect(entregar(p.message)).rejects.toThrow();
    expect(await pagamento(p.paymentId)).toEqual({ status: 'APROVADO', needs_manual_refund: true });
  });

  it('conta da Stripe REVOGADA: nada sai para a Stripe, falha (retry) e o sinal fica para o operador', async () => {
    const p = await pagoQueNaoPodeSerHonrado();
    await bench.owner.query(`UPDATE tenant_payment_accounts SET status = 'REVOKED' WHERE id = $1`, [p.paymentAccountId]);

    await expect(entregar(p.message)).rejects.toThrow();
    expect(estornosDe(p.pi)).toHaveLength(0);
    expect(await pagamento(p.paymentId)).toEqual({ status: 'APROVADO', needs_manual_refund: true });
  });

  it('recusa definitiva da Stripe (4xx): nao lanca (sem loop), o sinal fica para o operador', async () => {
    const p = await pagoQueNaoPodeSerHonrado();
    stripe.failNextRefund = Object.assign(new Error('charge too old'), { type: 'StripeInvalidRequestError', statusCode: 400 });

    await expect(entregar(p.message)).resolves.toBeUndefined();
    expect(estornosDe(p.pi)).toHaveLength(1);
    expect(await pagamento(p.paymentId)).toEqual({ status: 'APROVADO', needs_manual_refund: true });
  });

  it('ja estornado pelo painel da Stripe (recusa "already refunded"): a consulta confirma ESTORNADO', async () => {
    const p = await pagoQueNaoPodeSerHonrado();
    stripe.markRefunded(p.pi);

    await expect(entregar(p.message)).resolves.toBeUndefined();
    expect((await pagamento(p.paymentId)).status).toBe('ESTORNADO');
  });

  it('estorno aceito mas a consulta ainda nao o mostra: falha (retry); o retry, mesma chave, confirma', async () => {
    const p = await pagoQueNaoPodeSerHonrado();
    stripe.refundLags = true;
    try {
      await expect(entregar(p.message)).rejects.toThrow();
    } finally {
      stripe.refundLags = false;
    }
    expect(await pagamento(p.paymentId)).toEqual({ status: 'APROVADO', needs_manual_refund: true });

    // A Stripe passa a refletir o estorno; a fila reentrega.
    stripe.markRefunded(p.pi);
    await entregar(p.message);
    const chaves = estornosDe(p.pi).map((c) => c.opts?.['idempotencyKey']);
    expect(chaves).toEqual([`${p.paymentId}:refund`, `${p.paymentId}:refund`]);
    expect((await pagamento(p.paymentId)).status).toBe('ESTORNADO');
  });

  it('payload MALFORMADO de pagamento Mercado Pago (legado): nao lanca e nada sai para a Stripe', async () => {
    const tenantId = await seedTenant(bench.owner);
    const draw = await seedDraw(bench.owner, tenantId);
    const pedido = await seedPendingOrder(bench.owner, tenantId, draw, [nextNumber++], { provider: 'MERCADO_PAGO' });
    // Sem drawId/amountCents/reason: nao passa no schema estrito.
    const payload = { tenantId, orderId: pedido.orderId, paymentId: pedido.paymentId };
    const outboxEventId = await seedOutboxEvent(bench.owner, tenantId, 'payment.refund_required', payload);
    const antes = { estornos: stripe.refundCalls.length, consultas: stripe.retrieved.length };
    await expect(entregar({ outboxEventId, tenantId, eventType: 'payment.refund_required', payload })).resolves.toBeUndefined();
    // Nem um lixo completo derruba o consumidor.
    await expect(entregar({ outboxEventId, tenantId, eventType: 'payment.refund_required', payload: { x: 1 } })).resolves.toBeUndefined();
    expect(stripe.refundCalls.length).toBe(antes.estornos);
    expect(stripe.retrieved.length).toBe(antes.consultas);
  });

  it('Connect desligado no worker: nada sai para a Stripe e o sinal fica', async () => {
    const p = await pagoQueNaoPodeSerHonrado();
    await expect(entregar(p.message, null)).resolves.toBeUndefined();
    expect(estornosDe(p.pi)).toHaveLength(0);
    expect(await pagamento(p.paymentId)).toEqual({ status: 'APROVADO', needs_manual_refund: true });
  });

  it('pagamento que NAO e STRIPE (Mercado Pago): nunca vai para a Stripe; continua manual, sem nada novo na outbox', async () => {
    const tenantId = await seedTenant(bench.owner);
    const draw = await seedDraw(bench.owner, tenantId);
    const pedido = await seedPendingOrder(bench.owner, tenantId, draw, [nextNumber++], { provider: 'MERCADO_PAGO' });
    await bench.owner.query(
      `UPDATE payments SET status = 'APROVADO', paid_at = now(), needs_manual_refund = true, refund_reason = 'teste' WHERE id = $1`,
      [pedido.paymentId],
    );
    const payload = {
      tenantId,
      orderId: pedido.orderId,
      drawId: draw,
      paymentId: pedido.paymentId,
      amountCents: 1000,
      reason: 'teste',
    };
    const outboxEventId = await seedOutboxEvent(bench.owner, tenantId, 'payment.refund_required', payload);
    const antes = { estornos: stripe.refundCalls.length, consultas: stripe.retrieved.length };
    const outbox = async () =>
      (await bench.owner.query<{ n: number }>('SELECT count(*)::int AS n FROM outbox WHERE tenant_id = $1', [tenantId])).rows[0]!.n;
    const outboxAntes = await outbox();

    await entregar({ outboxEventId, tenantId, eventType: 'payment.refund_required', payload });

    expect(stripe.refundCalls.length).toBe(antes.estornos);
    expect(stripe.retrieved.length).toBe(antes.consultas);
    expect(await pagamento(pedido.paymentId!)).toEqual({ status: 'APROVADO', needs_manual_refund: true });
    expect(await outbox()).toBe(outboxAntes);
  });

  it('evento de outra comunidade (tenantId do payload nao e o do pagamento): nada e estornado', async () => {
    const p = await pagoQueNaoPodeSerHonrado();
    const outra = await seedTenant(bench.owner);
    const payload = { ...p.message.payload, tenantId: outra };
    await entregar({ ...p.message, tenantId: outra, payload });
    expect(estornosDe(p.pi)).toHaveLength(0);
    expect((await pagamento(p.paymentId)).status).toBe('APROVADO');
  });
});
