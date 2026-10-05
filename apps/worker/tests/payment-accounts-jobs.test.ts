import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, type DbPool } from '@clubedarifa/db';
import { createPaymentAccountsRuntime, type PaymentAccountsRuntime } from '@clubedarifa/payment-accounts';
import { FakeMercadoPago } from '@clubedarifa/payment-accounts/testing';
import {
  conciliacao,
  expirarPix,
  finalizarDesconexoesPagamento,
  renovarCredenciaisPagamento,
} from '../src/jobs/definitions.js';
import type { JobContext } from '../src/jobs/types.js';
import { hasDb, openBench, seedDraw, seedPendingOrder, seedTenant, silentLog, skipReason, unique, type Bench } from './helpers/seed.js';

/**
 * Jobs dos recebimentos por comunidade (Fase 7 · Etapa 4), contra PostgreSQL real e com o papel
 * restrito `app_worker`, sobre o Mercado Pago EM MEMORIA. Nenhuma credencial ou cobranca real.
 */
const APP_URL = process.env['TEST_APP_DATABASE_URL'] ?? '';
const KEY = Buffer.alloc(32, 5).toString('base64');

describe.skipIf(!hasDb || APP_URL === '')(`Jobs dos recebimentos ${hasDb ? '' : skipReason}`, () => {
  let bench: Bench;
  let appPool: DbPool;
  let mp: FakeMercadoPago;
  let apiRuntime: PaymentAccountsRuntime;
  let workerRuntime: PaymentAccountsRuntime;
  let ctx: JobContext;
  let nextNumber = 1;
  // O banco de teste persiste entre execucoes: cada execucao usa vendedores PROPRIOS.
  const rodada = String(Date.now() % 100_000_000);
  const v = (n: number) => `${n}${rodada}`;

  const criar = (pool: DbPool) =>
    createPaymentAccountsRuntime(pool, {
      clientId: mp.clientId,
      clientSecret: mp.clientSecret,
      credentialsKey: KEY,
      redirectUri: mp.redirectUri,
      webhookSecret: mp.webhookSecret,
      environment: 'SANDBOX',
      fetchImpl: mp.fetch,
    });

  beforeAll(async () => {
    bench = await openBench('test-pa-jobs');
    appPool = createPool({ connectionString: APP_URL, applicationName: 'test-pa-jobs-app', max: 4 });
    mp = new FakeMercadoPago();
    apiRuntime = criar(appPool);
    workerRuntime = criar(bench.worker);
    ctx = { pool: bench.worker, log: silentLog, paymentAccounts: workerRuntime };
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
    return { tenantId, userId };
  }

  /** Conecta a conta do vendedor pelo fluxo REAL (inicio + retorno), sem passar pela camada HTTP. */
  async function conectar(c: { tenantId: string; userId: string }, vendedor: string) {
    if (!mp.sellers.has(vendedor)) mp.addSeller(vendedor);
    const { url } = await apiRuntime.beginConnection(c);
    const u = new URL(url);
    const code = mp.authorize(vendedor, u.searchParams.get('code_challenge')!);
    const r = await apiRuntime.completeConnection({ state: u.searchParams.get('state')!, code, sessionUserId: c.userId });
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
  }

  const contaRecebendo = async (tenantId: string) =>
    (
      await bench.owner.query<{ id: string; authorization_id: string }>(
        `SELECT id, authorization_id FROM tenant_payment_accounts WHERE tenant_id = $1 AND status = 'CONNECTED'`,
        [tenantId],
      )
    ).rows[0]!;

  /** Pedido com PIX vencido cobrado de verdade no (fake) Mercado Pago pela conta vigente. */
  async function pedidoComPix(c: { tenantId: string }) {
    const draw = await seedDraw(bench.owner, c.tenantId);
    const pedido = await seedPendingOrder(bench.owner, c.tenantId, draw, [nextNumber++], { payment: false });
    const { gateway, paymentAccountId } = await workerRuntime.resolver.forTenant(c.tenantId);
    const cobranca = await gateway.createPixCharge({
      idempotencyKey: pedido.orderId,
      amountCents: 1000,
      description: 'Teste',
      externalReference: pedido.orderId,
      payerEmail: 'maria@example.com',
      payerName: 'Maria',
      expiresAt: new Date(Date.now() + 30 * 60_000),
      notificationUrl: null,
    });
    const { rows } = await bench.owner.query<{ id: string }>(
      `INSERT INTO payments (tenant_id, order_id, provider, provider_payment_id, status, idempotency_key, amount_cents,
                             expires_at, payment_account_id)
       VALUES ($1, $2, 'MERCADO_PAGO', $3, 'PENDENTE', $4, 1000, now() - interval '10 minutes', $5) RETURNING id`,
      [c.tenantId, pedido.orderId, cobranca.providerPaymentId, pedido.orderId, paymentAccountId],
    );
    return { ...pedido, paymentId: rows[0]!.id, mpId: cobranca.providerPaymentId, accountId: paymentAccountId };
  }

  const statusPedido = async (orderId: string) =>
    (await bench.owner.query<{ status: string }>('SELECT status::text AS status FROM orders WHERE id = $1', [orderId])).rows[0]!.status;

  // -------------------------------------------------------------------------
  it('sem runtime de recebimentos, os jobs novos nao fazem nada', async () => {
    const semRuntime: JobContext = { ...ctx, paymentAccounts: null };
    expect(await renovarCredenciaisPagamento.run(semRuntime)).toBe(0);
    expect(await finalizarDesconexoesPagamento.run(semRuntime)).toBe(0);
  });

  describe('conciliacao e expirar-pix usam a conta ORIGINAL do pagamento', () => {
    it('apos a TROCA de conta, a conciliacao consulta a conta antiga e cura o pagamento aprovado sem webhook', async () => {
      const c = await comunidade();
      await conectar(c, v(5001));
      const antigo = await pedidoComPix(c);
      await conectar(c, v(5002)); // troca: a conta 5001 fica DISCONNECTING (ha PIX pendente)
      expect((await contaRecebendo(c.tenantId)).id).not.toBe(antigo.accountId);

      mp.approvePayment(antigo.mpId); // o cliente pagou; o webhook nunca chegou
      await conciliacao.run(ctx);

      expect(await statusPedido(antigo.orderId)).toBe('PAGO');
      // o pagamento continua preso a conta antiga
      const { rows } = await bench.owner.query<{ payment_account_id: string }>('SELECT payment_account_id FROM payments WHERE id = $1', [antigo.paymentId]);
      expect(rows[0]!.payment_account_id).toBe(antigo.accountId);
      // e a divergencia foi registrada
      const { rows: div } = await bench.owner.query(`SELECT 1 FROM payment_reconciliation_issues WHERE payment_id = $1`, [antigo.paymentId]);
      expect(div).toHaveLength(1);
    });

    it('expirar-pix: PIX vencido mas APROVADO na conta original e confirmado, nao liberado', async () => {
      const c = await comunidade();
      await conectar(c, v(5003));
      const p = await pedidoComPix(c);
      await conectar(c, v(5004));
      mp.approvePayment(p.mpId);
      await expirarPix.run(ctx);
      expect(await statusPedido(p.orderId)).toBe('PAGO');
    });

    it('expirar-pix: PIX vencido e NAO pago na conta original: libera', async () => {
      const c = await comunidade();
      await conectar(c, v(5005));
      const p = await pedidoComPix(c);
      await expirarPix.run(ctx);
      expect(await statusPedido(p.orderId)).toBe('CANCELADO');
    });

    it('autorizacao REVOGADA: nao finge que consulta — nada e liberado nem aplicado', async () => {
      const c = await comunidade();
      await conectar(c, v(5006));
      const p = await pedidoComPix(c);
      const conta = await contaRecebendo(c.tenantId);
      await bench.owner.query(`UPDATE payment_provider_authorizations SET expires_at = now() + interval '1 minute' WHERE id = $1`, [conta.authorization_id]);
      mp.revokeSeller(v(5006));
      mp.approvePayment(p.mpId);

      await expirarPix.run(ctx);
      await conciliacao.run(ctx);

      expect(await statusPedido(p.orderId)).toBe('PENDENTE');
      const { rows } = await bench.owner.query<{ status: string }>('SELECT status::text AS status FROM tenant_payment_accounts WHERE id = $1', [conta.id]);
      expect(rows[0]!.status).toBe('REVOKED');
    });

    it('Mercado Pago fora: nada e liberado, e o proximo ciclo conclui', async () => {
      const c = await comunidade();
      await conectar(c, v(5007));
      const p = await pedidoComPix(c);
      mp.approvePayment(p.mpId);
      mp.failNext(`/v1/payments/${p.mpId}`, 503, 1);
      await expirarPix.run(ctx);
      expect(await statusPedido(p.orderId)).toBe('PENDENTE');
      await expirarPix.run(ctx);
      expect(await statusPedido(p.orderId)).toBe('PAGO');
    });
  });

  describe('renovar-credenciais-pagamento', () => {
    it('renova a que vence dentro da margem, nao mexe nas outras e e idempotente', async () => {
      const c = await comunidade();
      await conectar(c, v(6001));
      const { authorization_id: id } = await contaRecebendo(c.tenantId);
      const versao = async () =>
        (await bench.owner.query<{ credential_version: number }>('SELECT credential_version FROM payment_provider_authorizations WHERE id = $1', [id])).rows[0]!
          .credential_version;
      const v0 = await versao();

      expect(await renovarCredenciaisPagamento.run(ctx)).toBe(0); // vence em ~180 dias
      expect(await versao()).toBe(v0);

      await bench.owner.query(`UPDATE payment_provider_authorizations SET expires_at = now() + interval '3 days' WHERE id = $1`, [id]);
      const chamadas = mp.callsTo('/oauth/token');
      expect(await renovarCredenciaisPagamento.run(ctx)).toBeGreaterThanOrEqual(1);
      expect(await versao()).toBe(v0 + 1);
      expect(mp.callsTo('/oauth/token') - chamadas).toBe(1);

      expect(await renovarCredenciaisPagamento.run(ctx)).toBe(0);
      expect(await versao()).toBe(v0 + 1);
    });

    it('API e worker ao mesmo tempo: uma unica renovacao no Mercado Pago', async () => {
      const c = await comunidade();
      await conectar(c, v(6002));
      const { authorization_id: id } = await contaRecebendo(c.tenantId);
      await bench.owner.query(`UPDATE payment_provider_authorizations SET expires_at = now() + interval '1 minute' WHERE id = $1`, [id]);
      const chamadas = mp.callsTo('/oauth/token');
      mp.refreshDelayMs = 150;
      try {
        await Promise.all([apiRuntime.resolver.forTenant(c.tenantId), renovarCredenciaisPagamento.run(ctx), workerRuntime.refreshDue(50)]);
      } finally {
        mp.refreshDelayMs = 0;
      }
      expect(mp.callsTo('/oauth/token') - chamadas).toBe(1);
      const { rows } = await bench.owner.query<{ credential_version: number }>('SELECT credential_version FROM payment_provider_authorizations WHERE id = $1', [id]);
      expect(rows[0]!.credential_version).toBe(2);
      // a credencial guardada e a que vale no Mercado Pago
      const { gateway } = await apiRuntime.resolver.forTenant(c.tenantId);
      expect(gateway.provider).toBe('MERCADO_PAGO');
    });

    it('refresh recusado (revogado): a autorizacao cai e o job reporta, sem apagar nada alem do segredo', async () => {
      const c = await comunidade();
      await conectar(c, v(6003));
      const { authorization_id: id } = await contaRecebendo(c.tenantId);
      await bench.owner.query(`UPDATE payment_provider_authorizations SET expires_at = now() + interval '2 days' WHERE id = $1`, [id]);
      mp.revokeSeller(v(6003));
      await renovarCredenciaisPagamento.run(ctx);
      const { rows } = await bench.owner.query<{ status: string; access_token_encrypted: Buffer | null }>(
        'SELECT status::text AS status, access_token_encrypted FROM payment_provider_authorizations WHERE id = $1',
        [id],
      );
      expect(rows[0]).toMatchObject({ status: 'REVOKED', access_token_encrypted: null });
    });
  });

  describe('finalizar-desconexoes-pagamento', () => {
    it('espera o PIX pendente; quando nao ha mais dependencia conclui e apaga o segredo', async () => {
      const c = await comunidade();
      await conectar(c, v(7001));
      const p = await pedidoComPix(c);
      const conta = await contaRecebendo(c.tenantId);
      await bench.owner.query(`UPDATE tenant_payment_accounts SET status = 'DISCONNECTING', disconnect_requested_at = now() WHERE id = $1`, [conta.id]);

      await finalizarDesconexoesPagamento.run(ctx);
      const st = async () =>
        (await bench.owner.query<{ status: string }>('SELECT status::text AS status FROM tenant_payment_accounts WHERE id = $1', [conta.id])).rows[0]!.status;
      expect(await st()).toBe('DISCONNECTING'); // ainda ha PIX pendente

      mp.approvePayment(p.mpId);
      await expirarPix.run(ctx); // resolve o pendente com a credencial guardada
      expect(await statusPedido(p.orderId)).toBe('PAGO');
      await bench.owner.query(`UPDATE payments SET created_at = now() - interval '10 days' WHERE id = $1`, [p.paymentId]);

      expect(await finalizarDesconexoesPagamento.run(ctx)).toBeGreaterThanOrEqual(1);
      expect(await st()).toBe('DISCONNECTED');
      const { rows } = await bench.owner.query<{ access_token_encrypted: Buffer | null; refresh_token_encrypted: Buffer | null }>(
        'SELECT access_token_encrypted, refresh_token_encrypted FROM payment_provider_authorizations WHERE id = $1',
        [conta.authorization_id],
      );
      expect(rows[0]).toEqual({ access_token_encrypted: null, refresh_token_encrypted: null });
    });
  });
});
