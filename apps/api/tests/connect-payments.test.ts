import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Stripe from 'stripe';
import { createPool, type DbPool } from '@clubedarifa/db';
import {
  createConnectRuntime,
  createPaymentAccountsRuntime,
  type ConnectRuntime,
  type PaymentAccountsRuntime,
} from '@clubedarifa/payment-accounts';
import { FakeMercadoPago } from '@clubedarifa/payment-accounts/testing';
import {
  TEST_APP_URL,
  cleanup,
  createHarness,
  currentCode,
  grantMembership,
  hasTestDatabase,
  loginAs,
  seedAccount,
  seedConfirmedTotp,
  seedTenantWithSlug,
  skipReason,
  unique,
  verifyMfa,
  type Harness,
  type SeededAccount,
} from './helpers/apiHarness.js';

/**
 * Stripe Connect · escolha do provedor na hora de cobrar e taxa CONGELADA no pagamento.
 *
 * A API roda com o runtime Connect REAL (resolvedor + gateway) sobre uma Stripe FALSA em memoria
 * que registra cada chamada, e — quando o teste pede as duas formas de recebimento — com o runtime
 * REAL do Mercado Pago sobre o `FakeMercadoPago`. Nenhuma chave real: so `sk_test_fake_for_unit_tests`.
 */
const FAKE_KEY = 'sk_test_fake_for_unit_tests';
const CREDENTIALS_KEY = Buffer.alloc(32, 7).toString('base64');

interface FakeAccount {
  charges_enabled: boolean;
  payouts_enabled: boolean;
  requirements: { currently_due: string[]; past_due: string[] };
}

/** Stripe falsa: so o que o runtime e o gateway usam. Honra `idempotencyKey` como a Stripe. */
class FakeStripe {
  readonly intents: { params: Record<string, unknown>; opts: Record<string, unknown> | undefined }[] = [];
  readonly accountsById = new Map<string, FakeAccount>();
  readonly #intentByKey = new Map<string, Record<string, unknown>>();
  #n = 0;

  readonly accounts = {
    create: async (_params: Record<string, unknown>, _opts?: Record<string, unknown>) => {
      const id = `acct_${unique('f').replace(/[^A-Za-z0-9]/g, '')}`;
      this.accountsById.set(id, {
        charges_enabled: false,
        payouts_enabled: false,
        requirements: { currently_due: ['external_account'], past_due: [] },
      });
      return { id, object: 'account' };
    },
    retrieve: async (id: string) => {
      const a = this.accountsById.get(id);
      if (!a) throw Object.assign(new Error('No such account'), { type: 'StripeInvalidRequestError', statusCode: 404 });
      return { id, object: 'account', ...a };
    },
  };

  readonly accountLinks = {
    create: async (params: Record<string, unknown>) => ({
      object: 'account_link',
      url: `https://connect.stripe.test/setup/${String(params['account'])}/${++this.#n}`,
    }),
  };

  readonly paymentIntents = {
    create: async (params: Record<string, unknown>, opts?: Record<string, unknown>) => {
      this.intents.push({ params, opts });
      const key = opts?.['idempotencyKey'];
      if (typeof key === 'string' && this.#intentByKey.has(key)) return this.#intentByKey.get(key)!;
      const intent = {
        id: `pi_${unique('t').replace(/[^A-Za-z0-9]/g, '')}`,
        object: 'payment_intent',
        status: 'requires_action',
        amount: params['amount'],
        metadata: params['metadata'],
        transfer_data: params['transfer_data'],
        next_action: {
          pix_display_qr_code: {
            data: `00020126PIXSTRIPE${++this.#n}`,
            expires_at: Math.floor(Date.now() / 1000) + 600,
          },
        },
      };
      if (typeof key === 'string') this.#intentByKey.set(key, intent);
      return intent;
    },
  };

  /** O criador termina o cadastro na Stripe. */
  ready(acct: string): void {
    const a = this.accountsById.get(acct)!;
    a.charges_enabled = true;
    a.payouts_enabled = true;
    a.requirements = { currently_due: [], past_due: [] };
  }

  asClient(): Stripe {
    return this as unknown as Stripe;
  }
}

describe.skipIf(!hasTestDatabase)(`Stripe Connect · cobranca e taxa ${hasTestDatabase ? '' : skipReason}`, () => {
  let appPool: DbPool;
  let stripe: FakeStripe;
  let mp: FakeMercadoPago;
  let connect: ConnectRuntime;
  let mpRuntime: PaymentAccountsRuntime;
  /** Implantacao so com o Connect ligado. */
  let soStripe: Harness;
  /** Implantacao com as duas formas de recebimento. */
  let ambos: Harness;

  interface Comunidade {
    slug: string;
    tenantId: string;
    owner: SeededAccount;
  }

  beforeAll(async () => {
    stripe = new FakeStripe();
    mp = new FakeMercadoPago();
    appPool = createPool({ connectionString: TEST_APP_URL, applicationName: 'test-connect-pay', max: 5 });
    connect = createConnectRuntime(appPool, {
      secretKey: FAKE_KEY,
      returnBaseUrl: 'https://organizer.test',
      environment: 'SANDBOX',
      client: stripe.asClient(),
    });
    mpRuntime = createPaymentAccountsRuntime(appPool, {
      clientId: mp.clientId,
      clientSecret: mp.clientSecret,
      credentialsKey: CREDENTIALS_KEY,
      redirectUri: mp.redirectUri,
      webhookSecret: mp.webhookSecret,
      environment: 'SANDBOX',
      fetchImpl: mp.fetch,
    });
    soStripe = await createHarness({ connect });
    ambos = await createHarness({ paymentAccounts: mpRuntime, connect });
    await cleanup(soStripe.owner);
  }, 180_000);

  afterAll(async () => {
    await soStripe?.close();
    await ambos?.close();
    await appPool?.end();
  });

  // ---- cenario ------------------------------------------------------------

  async function novaComunidade(h: Harness, prefixo: string): Promise<Comunidade> {
    const slug = unique(prefixo);
    const tenantId = await seedTenantWithSlug(h.owner, slug, `Comunidade ${prefixo}`);
    const owner = await seedAccount(h.owner);
    await grantMembership(h.owner, { tenantId, userId: owner.userId, role: 'OWNER' });
    return { slug, tenantId, owner };
  }

  /** Cadastro Connect pelo runtime (as rotas sao da Task 7). Devolve o `acct_`. */
  async function cadastrarStripe(c: Comunidade, pronta: boolean): Promise<string> {
    const { url } = await connect.beginOnboarding({ tenantId: c.tenantId, userId: c.owner.userId });
    const acct = url.split('/')[4]!;
    if (pronta) {
      stripe.ready(acct);
      await connect.syncAccount(acct);
    }
    return acct;
  }

  async function entrar(h: Harness, account: SeededAccount): Promise<string> {
    const secret = await seedConfirmedTotp(h.owner, account.userId);
    const login = await loginAs(h, account);
    return (await verifyMfa(h, login.cookie, await currentCode(secret))).cookie;
  }

  /** Conexao Mercado Pago pelo fluxo OAuth completo (rota, PKCE, callback). */
  async function conectarMp(h: Harness, c: Comunidade): Promise<void> {
    const vendedor = unique('seller-');
    mp.addSeller(vendedor);
    const cookie = await entrar(h, c.owner);
    const ini = await request(h.app)
      .post('/api/tenant/payment-accounts/connect')
      .set('Cookie', cookie)
      .set('x-tenant-slug', c.slug)
      .send({ provider: 'MERCADO_PAGO' });
    expect(ini.status, JSON.stringify(ini.body)).toBe(200);
    const u = new URL(ini.body.url as string);
    const code = mp.authorize(vendedor, u.searchParams.get('code_challenge')!);
    const res = await request(h.app)
      .get('/api/payment-accounts/oauth/callback')
      .query({ state: u.searchParams.get('state')!, code })
      .set('Cookie', cookie);
    expect(res.status).toBe(302);
    expect(new URL(res.headers['location'] as string).searchParams.get('conexao')).toBe('ok');
  }

  async function plano(feeBps: number): Promise<string> {
    const { rows } = await soStripe.owner.query<{ id: string }>(
      `INSERT INTO plans (code, name, billing_interval, price_cents, stripe_product_id, stripe_price_id, status, platform_fee_bps)
       VALUES ($1, 'Plano taxa', 'month', 1000, $2, $3, 'AVAILABLE', $4) RETURNING id`,
      [unique('pl-').toLowerCase().replace(/[^a-z0-9-]/g, '-'), unique('prod_'), unique('price_'), feeBps],
    );
    return rows[0]!.id;
  }

  async function assinar(c: Comunidade, planId: string): Promise<void> {
    const customer = unique('cus_').replace(/[^a-z0-9_]/gi, '');
    await soStripe.owner.query('INSERT INTO tenant_billing (tenant_id, stripe_customer_id) VALUES ($1, $2)', [c.tenantId, customer]);
    await soStripe.owner.query(
      `INSERT INTO tenant_subscriptions (tenant_id, plan_id, stripe_customer_id, stripe_subscription_id, status, stripe_synced_at)
       VALUES ($1, $2, $3, $4, 'active', now())`,
      [c.tenantId, planId, customer, unique('sub_').replace(/[^a-z0-9_]/gi, '')],
    );
  }

  async function sorteio(h: Harness, c: Comunidade, preco: number): Promise<string> {
    const { rows } = await h.owner.query<{ id: string }>(
      `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers, status)
       VALUES ($1, $2, 'Sorteio', 'Moto', $3, 100, 'ATIVA') RETURNING id`,
      [c.tenantId, unique('s-'), preco],
    );
    return rows[0]!.id;
  }

  /** Reserva + pedido (o PIX e gerado ali). */
  async function comprar(h: Harness, c: Comunidade, preco = 1999) {
    const d = await sorteio(h, c, preco);
    const reserva = await request(h.app)
      .post(`/api/public/draws/${d}/reservations`)
      .set('x-tenant-slug', c.slug)
      .send({ numbers: [1] });
    expect(reserva.status, JSON.stringify(reserva.body)).toBe(201);
    return request(h.app)
      .post('/api/public/orders')
      .set('x-tenant-slug', c.slug)
      .send({
        reservationId: reserva.body.reservationId,
        buyer: { name: 'Maria Souza', phone: '+55 11 91234-5678', email: 'maria@example.com' },
        acceptedTerms: true,
      });
  }

  interface PagamentoRow {
    provider: string;
    provider_payment_id: string;
    amount_cents: number;
    payment_account_id: string | null;
    platform_fee_bps: number | null;
    platform_fee_cents: number | null;
  }

  async function pagamentoDe(orderId: string): Promise<PagamentoRow> {
    const { rows } = await soStripe.owner.query<PagamentoRow>(
      `SELECT provider, provider_payment_id, amount_cents, payment_account_id, platform_fee_bps, platform_fee_cents
         FROM payments WHERE order_id = $1`,
      [orderId],
    );
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  async function compraOk(h: Harness, c: Comunidade, preco = 1999) {
    const pedido = await comprar(h, c, preco);
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(201);
    expect(pedido.body.payment, JSON.stringify(pedido.body)).not.toBeNull();
    const orderId = pedido.body.orderId as string;
    return { orderId, pedido: pedido.body, pagamento: await pagamentoDe(orderId) };
  }

  const contaDe = async (tenantId: string, provider: string) =>
    (
      await soStripe.owner.query<{ id: string }>(
        `SELECT id FROM tenant_payment_accounts WHERE tenant_id = $1 AND provider = $2 AND status = 'CONNECTED'`,
        [tenantId, provider],
      )
    ).rows[0]!.id;

  const pagamentosDa = async (tenantId: string) =>
    (await soStripe.owner.query<{ n: number }>('SELECT count(*)::int AS n FROM payments WHERE tenant_id = $1', [tenantId]))
      .rows[0]!.n;

  // -------------------------------------------------------------------------
  describe('comunidade so com a Stripe', () => {
    it('conta pronta: cobra pelo gateway Stripe, com destino e taxa, e grava provider STRIPE', async () => {
      const c = await novaComunidade(soStripe, 'cs-');
      const acct = await cadastrarStripe(c, true);
      const antes = stripe.intents.length;

      const { orderId, pedido, pagamento } = await compraOk(soStripe, c, 1999);

      expect(stripe.intents).toHaveLength(antes + 1);
      const chamada = stripe.intents.at(-1)!;
      expect(chamada.opts?.['idempotencyKey']).toBe(orderId);
      expect(chamada.params).toMatchObject({
        amount: 1999,
        currency: 'brl',
        payment_method_types: ['pix'],
        transfer_data: { destination: acct },
        // Sem assinatura: vale o padrao da plataforma (500 bps).
        application_fee_amount: Math.floor((1999 * 500) / 10_000),
        metadata: { order_id: orderId },
      });
      expect(pedido.payment.copyPaste).toMatch(/^00020126PIXSTRIPE/);
      expect(pagamento).toMatchObject({
        provider: 'STRIPE',
        amount_cents: 1999,
        payment_account_id: await contaDe(c.tenantId, 'STRIPE'),
        platform_fee_bps: 500,
        platform_fee_cents: Math.floor((1999 * 500) / 10_000),
      });
    });

    it('cadastro incompleto (sem charges_enabled): PAYMENT_ACCOUNT_UNAVAILABLE/NOT_READY e nenhuma cobranca', async () => {
      const c = await novaComunidade(soStripe, 'cs-np-');
      await cadastrarStripe(c, false);
      const antes = stripe.intents.length;

      const pedido = await comprar(soStripe, c);
      expect(pedido.status).toBe(503);
      expect(pedido.body.error.code).toBe('PAYMENT_ACCOUNT_UNAVAILABLE');
      expect(pedido.body.error.details).toEqual({ reason: 'NOT_READY' });
      expect(stripe.intents).toHaveLength(antes);
      expect(await pagamentosDa(c.tenantId)).toBe(0);
    });

    it('sem conta nenhuma: PAYMENTS_NOT_CONFIGURED', async () => {
      const c = await novaComunidade(soStripe, 'cs-0-');
      const pedido = await comprar(soStripe, c);
      expect(pedido.status).toBe(503);
      expect(pedido.body.error.code).toBe('PAYMENTS_NOT_CONFIGURED');
      expect(await pagamentosDa(c.tenantId)).toBe(0);
    });

    it('a tela de recebimentos mostra a conta STRIPE com o estado do cadastro', async () => {
      const c = await novaComunidade(soStripe, 'cs-ls-');
      await cadastrarStripe(c, false);
      const cookie = await entrar(soStripe, c.owner);
      const pendente = await request(soStripe.app).get('/api/tenant/payment-accounts').set('Cookie', cookie).set('x-tenant-slug', c.slug);
      expect(pendente.status, JSON.stringify(pendente.body)).toBe(200);
      expect(pendente.body).toMatchObject({ enabled: true, checkoutAvailable: false });
      expect(pendente.body.accounts).toHaveLength(1);
      expect(pendente.body.accounts[0]).toMatchObject({
        provider: 'STRIPE',
        status: 'CONNECTED',
        canReceivePayments: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        requirementsDue: ['external_account'],
      });

      const acct = pendente.body.accounts[0].providerAccountId as string;
      stripe.ready(acct);
      await connect.syncAccount(acct);
      const pronta = await request(soStripe.app).get('/api/tenant/payment-accounts').set('Cookie', cookie).set('x-tenant-slug', c.slug);
      expect(pronta.body).toMatchObject({ enabled: true, checkoutAvailable: true });
      expect(pronta.body.accounts[0]).toMatchObject({
        canReceivePayments: true,
        chargesEnabled: true,
        payoutsEnabled: true,
        requirementsDue: [],
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('comunidade com Mercado Pago e Stripe: vale a conectada mais recentemente que pode receber', () => {
    it('MP antes, Stripe depois: cobra pela Stripe', async () => {
      const c = await novaComunidade(ambos, 'cb-ms-');
      await conectarMp(ambos, c);
      const acct = await cadastrarStripe(c, true);
      const mpAntes = mp.callsTo('/v1/payments');
      const antes = stripe.intents.length;

      const { pagamento } = await compraOk(ambos, c);
      expect(pagamento.provider).toBe('STRIPE');
      expect(pagamento.payment_account_id).toBe(await contaDe(c.tenantId, 'STRIPE'));
      expect(stripe.intents).toHaveLength(antes + 1);
      expect(stripe.intents.at(-1)!.params['transfer_data']).toEqual({ destination: acct });
      expect(mp.callsTo('/v1/payments')).toBe(mpAntes);
    });

    it('Stripe antes, MP depois: cobra pelo Mercado Pago, sem taxa gravada', async () => {
      const c = await novaComunidade(ambos, 'cb-sm-');
      await cadastrarStripe(c, true);
      await conectarMp(ambos, c);
      const antes = stripe.intents.length;

      const { pagamento } = await compraOk(ambos, c);
      expect(pagamento).toMatchObject({
        provider: 'MERCADO_PAGO',
        payment_account_id: await contaDe(c.tenantId, 'MERCADO_PAGO'),
        platform_fee_bps: null,
        platform_fee_cents: null,
      });
      expect(stripe.intents).toHaveLength(antes);
    });

    it('Stripe mais recente mas sem charges_enabled: cobra pelo MP, que ainda pode receber', async () => {
      const c = await novaComunidade(ambos, 'cb-mn-');
      await conectarMp(ambos, c);
      await cadastrarStripe(c, false);
      const antes = stripe.intents.length;

      const { pagamento } = await compraOk(ambos, c);
      expect(pagamento.provider).toBe('MERCADO_PAGO');
      expect(stripe.intents).toHaveLength(antes);
    });

    it('so a Stripe, sem charges_enabled: PAYMENT_ACCOUNT_UNAVAILABLE/NOT_READY e nenhuma cobranca', async () => {
      const c = await novaComunidade(ambos, 'cb-np-');
      await cadastrarStripe(c, false);
      const antes = stripe.intents.length;

      const pedido = await comprar(ambos, c);
      expect(pedido.status).toBe(503);
      expect(pedido.body.error.code).toBe('PAYMENT_ACCOUNT_UNAVAILABLE');
      expect(pedido.body.error.details).toEqual({ reason: 'NOT_READY' });
      expect(stripe.intents).toHaveLength(antes);
      expect(await pagamentosDa(c.tenantId)).toBe(0);
    });

    it('nenhuma conta: PAYMENTS_NOT_CONFIGURED', async () => {
      const c = await novaComunidade(ambos, 'cb-0-');
      const pedido = await comprar(ambos, c);
      expect(pedido.status).toBe(503);
      expect(pedido.body.error.code).toBe('PAYMENTS_NOT_CONFIGURED');
    });
  });

  // -------------------------------------------------------------------------
  describe('taxa da plataforma congelada no pagamento', () => {
    it('plano de 300 bps grava 300/floor(total x 0,03); trocar o plano para 800 nao muda o antigo e o novo usa 800', async () => {
      const c = await novaComunidade(soStripe, 'cf-');
      await cadastrarStripe(c, true);
      const planId = await plano(300);
      await assinar(c, planId);

      const primeiro = await compraOk(soStripe, c, 1999);
      expect(primeiro.pagamento).toMatchObject({ provider: 'STRIPE', platform_fee_bps: 300, platform_fee_cents: 59 });
      expect(stripe.intents.at(-1)!.params['application_fee_amount']).toBe(59);

      await soStripe.owner.query('UPDATE plans SET platform_fee_bps = 800 WHERE id = $1', [planId]);

      expect(await pagamentoDe(primeiro.orderId)).toMatchObject({ platform_fee_bps: 300, platform_fee_cents: 59 });
      const segundo = await compraOk(soStripe, c, 1999);
      expect(segundo.pagamento).toMatchObject({ platform_fee_bps: 800, platform_fee_cents: Math.floor((1999 * 800) / 10_000) });
      expect(stripe.intents.at(-1)!.params['application_fee_amount']).toBe(159);
      // O primeiro continua como foi vendido.
      expect(await pagamentoDe(primeiro.orderId)).toMatchObject({ platform_fee_bps: 300, platform_fee_cents: 59 });
    });

    it('sem assinatura: vale o padrao da plataforma (500 bps)', async () => {
      const c = await novaComunidade(soStripe, 'cf-d-');
      await cadastrarStripe(c, true);
      const { pagamento } = await compraOk(soStripe, c, 1000);
      expect(pagamento).toMatchObject({ platform_fee_bps: 500, platform_fee_cents: 50 });
    });

    it('taxa de 10000 bps nunca passa do total do pedido', async () => {
      const c = await novaComunidade(soStripe, 'cf-max-');
      await cadastrarStripe(c, true);
      await assinar(c, await plano(10_000));
      const { pagamento } = await compraOk(soStripe, c, 1500);
      expect(pagamento).toMatchObject({ amount_cents: 1500, platform_fee_bps: 10_000, platform_fee_cents: 1500 });
      expect(stripe.intents.at(-1)!.params['application_fee_amount']).toBe(1500);
    });
  });
});
