import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
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
import { FakeStripe } from './helpers/fakeStripe.js';

/**
 * Stripe Connect · escolha do provedor na hora de cobrar e taxa CONGELADA no pagamento.
 *
 * A API roda com o runtime Connect REAL (resolvedor + gateway) sobre uma Stripe FALSA em memoria
 * que registra cada chamada, e — quando o teste pede as duas formas de recebimento — com o runtime
 * REAL do Mercado Pago sobre o `FakeMercadoPago`. Nenhuma chave real: so `sk_test_fake_for_unit_tests`.
 */
const FAKE_KEY = 'sk_test_fake_for_unit_tests';
const CREDENTIALS_KEY = Buffer.alloc(32, 7).toString('base64');

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

  /** Sessao com MFA; uma por pessoa e implantacao (o segundo fator so pode ser semeado uma vez). */
  const sessoes = new Map<string, string>();
  async function entrar(h: Harness, account: SeededAccount): Promise<string> {
    const chave = account.userId;
    const pronta = sessoes.get(chave);
    if (pronta) return pronta;
    const secret = await seedConfirmedTotp(h.owner, account.userId);
    const login = await loginAs(h, account);
    const cookie = (await verifyMfa(h, login.cookie, await currentCode(secret))).cookie;
    sessoes.set(chave, cookie);
    return cookie;
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
      // Chave = pedido + impressao digital dos parametros.
      expect(chamada.opts?.['idempotencyKey']).toMatch(new RegExp(`^${orderId}:[0-9a-f]{16}$`));
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

    it('a lista informa quais provedores estao ligados: connectEnabled e mercadoPagoEnabled', async () => {
      const soMp = await createHarness({ paymentAccounts: mpRuntime });
      const nenhum = await createHarness();
      try {
        const casos: Array<[string, Harness, boolean, boolean, boolean]> = [
          ['MP so', soMp, true, true, false],
          ['Connect so', soStripe, true, false, true],
          ['ambos', ambos, true, true, true],
          ['nenhum', nenhum, false, false, false],
        ];
        for (const [nome, h, enabled, mercadoPagoEnabled, connectEnabled] of casos) {
          const c = await novaComunidade(h, 'cs-fl-');
          const cookie = await entrar(h, c.owner);
          const res = await request(h.app).get('/api/tenant/payment-accounts').set('Cookie', cookie).set('x-tenant-slug', c.slug);
          expect(res.status, `${nome}: ${JSON.stringify(res.body)}`).toBe(200);
          expect(res.body, nome).toMatchObject({ enabled, mercadoPagoEnabled, connectEnabled });
        }
      } finally {
        await soMp.close();
        await nenhum.close();
      }
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

  // -------------------------------------------------------------------------
  describe('nova tentativa depois de falha parcial (idempotencia na Stripe x linha no banco)', () => {
    const pedidoMaisRecente = async (tenantId: string) =>
      (
        await soStripe.owner.query<{ id: string }>(
          'SELECT id FROM orders WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1',
          [tenantId],
        )
      ).rows[0]!.id;

    const gerarPix = (h: Harness, c: Comunidade, orderId: string) =>
      request(h.app).post(`/api/public/orders/${orderId}/payment`).set('x-tenant-slug', c.slug);

    /**
     * A PROXIMA gravacao de pagamento desta comunidade falha uma vez (a cobranca ja saiu na Stripe).
     * Sequencia, e nao tabela: o `nextval` sobrevive ao rollback do INSERT que falhou.
     */
    async function falharProximaGravacao(tenantId: string): Promise<() => Promise<void>> {
      const nome = unique('falha_').replace(/[^a-z0-9_]/gi, '_').toLowerCase();
      const o = soStripe.owner;
      await o.query(`CREATE SEQUENCE ${nome}_seq`);
      await o.query(
        `CREATE FUNCTION ${nome}_fn() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
         BEGIN
           IF NEW.tenant_id = '${tenantId}'::uuid AND nextval('${nome}_seq') = 1 THEN
             RAISE EXCEPTION 'falha simulada na gravacao do pagamento';
           END IF;
           RETURN NEW;
         END $f$`,
      );
      await o.query(`CREATE TRIGGER ${nome}_tg BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION ${nome}_fn()`);
      return async () => {
        await o.query(`DROP TRIGGER IF EXISTS ${nome}_tg ON payments`);
        await o.query(`DROP FUNCTION IF EXISTS ${nome}_fn()`);
        await o.query(`DROP SEQUENCE IF EXISTS ${nome}_seq`);
      };
    }

    it('PI criado mas a gravacao falhou; a nova tentativa (com taxa nova) cobra e o pedido mostra o PI da linha', async () => {
      const c = await novaComunidade(soStripe, 'ci-');
      await cadastrarStripe(c, true);
      const planId = await plano(300);
      await assinar(c, planId);
      const antes = stripe.intents.length;

      const desfazer = await falharProximaGravacao(c.tenantId);
      try {
        const primeira = await comprar(soStripe, c, 1999);
        expect(primeira.status).toBe(500);
      } finally {
        await desfazer();
      }
      const orderId = await pedidoMaisRecente(c.tenantId);
      expect(stripe.intents).toHaveLength(antes + 1);
      expect(await pagamentosDa(c.tenantId)).toBe(0);

      // Entre as tentativas o plano muda: os parametros da cobranca mudam (taxa e prazo).
      await soStripe.owner.query('UPDATE plans SET platform_fee_bps = 800 WHERE id = $1', [planId]);

      const segunda = await gerarPix(soStripe, c, orderId);
      expect(segunda.status, JSON.stringify(segunda.body)).toBe(200);
      expect(stripe.intents).toHaveLength(antes + 2);

      const linha = await pagamentoDe(orderId);
      expect(linha).toMatchObject({ provider: 'STRIPE', platform_fee_bps: 800, platform_fee_cents: 159 });
      const { rows } = await soStripe.owner.query<{ pix_copy_paste: string }>(
        'SELECT pix_copy_paste FROM payments WHERE order_id = $1',
        [orderId],
      );
      expect(segunda.body.payment.copyPaste).toBe(rows[0]!.pix_copy_paste);
      // As duas tentativas usaram chaves diferentes (pedido + impressao dos parametros).
      const [k1, k2] = stripe.intents.slice(-2).map((i) => i.opts?.['idempotencyKey'] as string);
      expect(k1).not.toBe(k2);
      expect(k1!.startsWith(`${orderId}:`)).toBe(true);
      expect(k2!.startsWith(`${orderId}:`)).toBe(true);

      // E a consulta seguinte devolve o mesmo pagamento, sem nova cobranca.
      const terceira = await gerarPix(soStripe, c, orderId);
      expect(terceira.body.payment.copyPaste).toBe(rows[0]!.pix_copy_paste);
      expect(stripe.intents).toHaveLength(antes + 2);
    });

    it('duplo envio simultaneo: UMA linha de pagamento e as duas respostas mostram o QR dela', async () => {
      const c = await novaComunidade(soStripe, 'cd-');
      await cadastrarStripe(c, true);
      // A primeira cobranca (no checkout) falha de forma temporaria: o pedido nasce sem PIX.
      stripe.failNextCreate = Object.assign(new Error('rede'), { type: 'StripeConnectionError' });
      const pedido = await comprar(soStripe, c, 1999);
      expect(pedido.status).toBe(201);
      expect(pedido.body.payment).toBeNull();
      const orderId = pedido.body.orderId as string;

      const respostas = await Promise.all([gerarPix(soStripe, c, orderId), gerarPix(soStripe, c, orderId)]);
      for (const r of respostas) expect(r.status, JSON.stringify(r.body)).toBe(200);

      const { rows } = await soStripe.owner.query<{ pix_copy_paste: string }>(
        'SELECT pix_copy_paste FROM payments WHERE order_id = $1',
        [orderId],
      );
      expect(rows).toHaveLength(1);
      for (const r of respostas) expect(r.body.payment.copyPaste).toBe(rows[0]!.pix_copy_paste);
    });
  });

  // -------------------------------------------------------------------------
  describe('meios de pagamento (GET /api/tenant/payment-methods)', () => {
    interface Meio {
      kind: string;
      providerReported: boolean;
      enabled: boolean;
      reason: string;
    }
    const meios = async (h: Harness, c: Comunidade) => {
      const cookie = await entrar(h, c.owner);
      const res = await request(h.app).get('/api/tenant/payment-methods').set('Cookie', cookie).set('x-tenant-slug', c.slug);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return { body: res.body as { status: string; provider: string | null; accountId: string | null; methods: Meio[] }, cookie };
    };
    const porTipo = (methods: Meio[], kind: string) => methods.find((m) => m.kind === kind)!;

    it('so a Stripe, conta pronta: provedor STRIPE, a conta dela, e so o PIX ligado', async () => {
      const c = await novaComunidade(soStripe, 'pm-s-');
      await cadastrarStripe(c, true);
      const { body } = await meios(soStripe, c);
      expect(body).toMatchObject({ status: 'OK', provider: 'STRIPE', accountId: await contaDe(c.tenantId, 'STRIPE') });
      expect(porTipo(body.methods, 'PIX')).toEqual({ kind: 'PIX', providerReported: true, enabled: true, reason: 'ENABLED' });
      for (const m of body.methods.filter((x) => x.kind !== 'PIX')) {
        expect(m, m.kind).toMatchObject({ providerReported: false, enabled: false });
      }
    });

    it('so a Stripe, cadastro incompleto: UNAVAILABLE com provedor STRIPE e nada ligado', async () => {
      const c = await novaComunidade(soStripe, 'pm-snr-');
      await cadastrarStripe(c, false);
      const { body } = await meios(soStripe, c);
      expect(body).toMatchObject({ status: 'UNAVAILABLE', provider: 'STRIPE', accountId: null });
      expect(body.methods.every((m) => !m.enabled)).toBe(true);
    });

    it('so a Stripe, sem conta: NO_ACCOUNT', async () => {
      const c = await novaComunidade(soStripe, 'pm-s0-');
      const { body } = await meios(soStripe, c);
      expect(body).toMatchObject({ status: 'NO_ACCOUNT', provider: null, accountId: null });
      expect(body.methods.every((m) => !m.enabled)).toBe(true);
    });

    it('o criador desliga o PIX numa comunidade Stripe: DISABLED_BY_CREATOR', async () => {
      const c = await novaComunidade(soStripe, 'pm-soff-');
      await cadastrarStripe(c, true);
      const { cookie } = await meios(soStripe, c);
      const off = await request(soStripe.app)
        .put('/api/tenant/payment-methods')
        .set('Cookie', cookie)
        .set('x-tenant-slug', c.slug)
        .send({ method: 'PIX', enabled: false });
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      expect(off.body.provider).toBe('STRIPE');
      expect(porTipo(off.body.methods as Meio[], 'PIX')).toMatchObject({ providerReported: true, enabled: false, reason: 'DISABLED_BY_CREATOR' });
    });

    it('os dois conectados: vale a conta mais recente que pode receber (mesma regra da cobranca)', async () => {
      const ms = await novaComunidade(ambos, 'pm-ms-');
      await conectarMp(ambos, ms);
      await cadastrarStripe(ms, true);
      expect((await meios(ambos, ms)).body).toMatchObject({
        status: 'OK',
        provider: 'STRIPE',
        accountId: await contaDe(ms.tenantId, 'STRIPE'),
      });

      const sm = await novaComunidade(ambos, 'pm-sm-');
      await cadastrarStripe(sm, true);
      await conectarMp(ambos, sm);
      expect((await meios(ambos, sm)).body).toMatchObject({
        status: 'OK',
        provider: 'MERCADO_PAGO',
        accountId: await contaDe(sm.tenantId, 'MERCADO_PAGO'),
      });

      // Stripe mais recente mas sem charges_enabled: o MP, que pode receber, responde.
      const mn = await novaComunidade(ambos, 'pm-mn-');
      await conectarMp(ambos, mn);
      await cadastrarStripe(mn, false);
      expect((await meios(ambos, mn)).body).toMatchObject({ status: 'OK', provider: 'MERCADO_PAGO' });
    });
  });

  // -------------------------------------------------------------------------
  describe('ambientes divergentes entre Mercado Pago e Connect', () => {
    it('falha fechado: PAYMENT_PROVIDER_UNAVAILABLE e nenhuma cobranca', async () => {
      // Runtime Connect que se declara de outro ambiente (o resto e o real).
      const divergente: ConnectRuntime = { ...connect, environment: 'PRODUCTION' };
      const h = await createHarness({ paymentAccounts: mpRuntime, connect: divergente });
      try {
        const c = await novaComunidade(h, 'cenv-');
        await cadastrarStripe(c, true);
        const antes = stripe.intents.length;
        const mpAntes = mp.callsTo('/v1/payments');

        const pedido = await comprar(h, c);
        // O checkout engole a indisponibilidade do provedor: o pedido nasce sem PIX.
        expect(pedido.status).toBe(201);
        expect(pedido.body.payment).toBeNull();
        const res = await request(h.app)
          .post(`/api/public/orders/${pedido.body.orderId as string}/payment`)
          .set('x-tenant-slug', c.slug);
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
        expect(stripe.intents).toHaveLength(antes);
        expect(mp.callsTo('/v1/payments')).toBe(mpAntes);
        expect(await pagamentosDa(c.tenantId)).toBe(0);
      } finally {
        await h.close();
      }
    });
  });
});
