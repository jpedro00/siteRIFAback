import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createPool, type DbPool } from '@clubedarifa/db';
import {
  InvalidConnectWebhookError,
  createConnectRuntime,
  verifyConnectWebhook,
  type ConnectRuntime,
} from '@clubedarifa/payment-accounts';
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
import { ROUTE_CONTRACTS } from '@clubedarifa/shared';
import { FAKE_CONNECT_WEBHOOK_SECRET, FakeStripe, signedConnectEvent } from './helpers/fakeStripe.js';

/**
 * Stripe Connect · rotas de cadastro/atualizacao e webhook.
 *
 * A API roda com o runtime Connect REAL sobre uma Stripe FALSA em memoria. O webhook e assinado
 * com o SDK (`generateTestHeaderString`) e um segredo obviamente falso.
 *
 * O que se prova:
 *  - assinatura invalida: 401 e nenhum efeito;
 *  - o estado da conta e o do pagamento vem de CONSULTA a Stripe, nunca do corpo do aviso (RN06);
 *  - o mesmo `event.id` duas vezes tem efeito UMA vez; uma falha transitoria deixa o evento
 *    reprocessavel;
 *  - evento desconhecido, de outra conta ou de outro modo (live/test): 200 sem efeito;
 *  - desligado: as tres rotas respondem 404.
 */
const FAKE_KEY = 'sk_test_fake_for_unit_tests';

describe('verifyConnectWebhook (sem banco)', () => {
  const evento = () =>
    signedConnectEvent({ id: 'evt_unit1', type: 'account.updated', object: { id: 'acct_unit1' }, account: 'acct_unit1' });

  it('aceita o segredo certo, inclusive quando ele e o segundo da lista', () => {
    const { rawBody, signature } = evento();
    const ev = verifyConnectWebhook(Buffer.from(rawBody), signature, ['whsec_test_fake_outro', FAKE_CONNECT_WEBHOOK_SECRET]);
    expect(ev).toMatchObject({ id: 'evt_unit1', type: 'account.updated', account: 'acct_unit1', livemode: false });
  });

  it('recusa segredo errado, cabecalho ausente, corpo adulterado e lista vazia', () => {
    const { rawBody, signature } = evento();
    const body = Buffer.from(rawBody);
    expect(() => verifyConnectWebhook(body, signature, ['whsec_test_fake_outro'])).toThrow(InvalidConnectWebhookError);
    expect(() => verifyConnectWebhook(body, undefined, [FAKE_CONNECT_WEBHOOK_SECRET])).toThrow(InvalidConnectWebhookError);
    expect(() => verifyConnectWebhook(body, signature, [])).toThrow(InvalidConnectWebhookError);
    const adulterado = Buffer.from(rawBody.replace('acct_unit1', 'acct_unit2'));
    expect(() => verifyConnectWebhook(adulterado, signature, [FAKE_CONNECT_WEBHOOK_SECRET])).toThrow(InvalidConnectWebhookError);
  });
});

describe.skipIf(!hasTestDatabase)(`Stripe Connect · rotas e webhook ${hasTestDatabase ? '' : skipReason}`, () => {
  let appPool: DbPool;
  let stripe: FakeStripe;
  let connect: ConnectRuntime;
  let h: Harness;
  /** Implantacao com o Connect desligado. */
  let off: Harness;

  interface Comunidade {
    slug: string;
    tenantId: string;
    owner: SeededAccount;
    cookie: string;
  }

  beforeAll(async () => {
    stripe = new FakeStripe();
    appPool = createPool({ connectionString: TEST_APP_URL, applicationName: 'test-connect-routes', max: 5 });
    connect = createConnectRuntime(appPool, {
      secretKey: FAKE_KEY,
      returnBaseUrl: 'https://organizer.test',
      environment: 'SANDBOX',
      client: stripe.asClient(),
    });
    h = await createHarness({ connect });
    off = await createHarness();
    await cleanup(h.owner);
  }, 180_000);

  afterAll(async () => {
    await h?.close();
    await off?.close();
    await appPool?.end();
  });

  // ---- cenario ------------------------------------------------------------

  async function entrar(harness: Harness, account: SeededAccount, comMfa = true): Promise<string> {
    const secret = comMfa ? await seedConfirmedTotp(harness.owner, account.userId) : null;
    const login = await loginAs(harness, account);
    return secret ? (await verifyMfa(harness, login.cookie, await currentCode(secret))).cookie : login.cookie;
  }

  async function novaComunidade(prefixo: string, harness: Harness = h): Promise<Comunidade> {
    const slug = unique(prefixo);
    const tenantId = await seedTenantWithSlug(harness.owner, slug, `Comunidade ${prefixo}`);
    const owner = await seedAccount(harness.owner);
    await grantMembership(harness.owner, { tenantId, userId: owner.userId, role: 'OWNER' });
    return { slug, tenantId, owner, cookie: await entrar(harness, owner) };
  }

  async function membro(c: Comunidade, role: string, comMfa = true) {
    const conta = await seedAccount(h.owner);
    await grantMembership(h.owner, { tenantId: c.tenantId, userId: conta.userId, role });
    return entrar(h, conta, comMfa);
  }

  const post = (harness: Harness, url: string, cookie: string, slug: string, body: object = {}) =>
    request(harness.app).post(url).set('Cookie', cookie).set('x-tenant-slug', slug).send(body);

  const cadastrar = (c: Comunidade, cookie = c.cookie, body: object = {}) =>
    post(h, '/api/tenant/payment-accounts/connect-stripe', cookie, c.slug, body);
  const atualizar = (c: Comunidade, cookie = c.cookie, body: object = {}) =>
    post(h, '/api/tenant/payment-accounts/refresh-stripe', cookie, c.slug, body);

  /** Cadastro pela ROTA. Devolve o `acct_` criado na Stripe falsa. */
  async function cadastrarOk(c: Comunidade, pronta: boolean): Promise<string> {
    const res = await cadastrar(c);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const acct = (res.body.url as string).split('/')[4]!;
    if (pronta) {
      stripe.ready(acct);
      await connect.syncAccount(acct);
    }
    return acct;
  }

  const estadoDa = async (acct: string) =>
    (
      await h.owner.query<{ charges: boolean | null; payouts: boolean | null; due: string[] }>(
        `SELECT charges_enabled AS charges, payouts_enabled AS payouts, requirements_due AS due
           FROM payment_provider_authorizations WHERE provider = 'STRIPE' AND provider_account_id = $1`,
        [acct],
      )
    ).rows[0]!;

  const contasStripeDa = async (tenantId: string) =>
    (
      await h.owner.query<{ acct: string }>(
        `SELECT z.provider_account_id AS acct FROM tenant_payment_accounts a
           JOIN payment_provider_authorizations z ON z.id = a.authorization_id
          WHERE a.tenant_id = $1 AND a.provider = 'STRIPE'`,
        [tenantId],
      )
    ).rows.map((r) => r.acct);

  const eventoGravado = async (id: string) =>
    (
      await h.owner.query<{ processed: boolean }>(
        'SELECT processed_at IS NOT NULL AS processed FROM stripe_connect_webhook_events WHERE event_id = $1',
        [id],
      )
    ).rows[0] ?? null;

  const evtId = () => unique('evt_').replace(/[^A-Za-z0-9_]/g, '');

  function avisar(
    harness: Harness,
    event: { id?: string; type: string; object: Record<string, unknown>; account?: string; livemode?: boolean },
    secret = FAKE_CONNECT_WEBHOOK_SECRET,
  ) {
    const { rawBody, signature } = signedConnectEvent({ id: event.id ?? evtId(), ...event }, secret);
    return request(harness.app)
      .post('/api/webhooks/stripe-connect')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signature)
      .send(rawBody);
  }

  /** Compra numa comunidade com conta Stripe pronta: PIX gerado, pagamento PENDENTE. */
  async function compra(c: Comunidade) {
    const { rows } = await h.owner.query<{ id: string }>(
      `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers, status)
       VALUES ($1, $2, 'Sorteio', 'Moto', 1999, 100, 'ATIVA') RETURNING id`,
      [c.tenantId, unique('s-')],
    );
    const reserva = await request(h.app)
      .post(`/api/public/draws/${rows[0]!.id}/reservations`)
      .set('x-tenant-slug', c.slug)
      .send({ numbers: [1] });
    expect(reserva.status, JSON.stringify(reserva.body)).toBe(201);
    const pedido = await request(h.app)
      .post('/api/public/orders')
      .set('x-tenant-slug', c.slug)
      .send({
        reservationId: reserva.body.reservationId,
        buyer: { name: 'Maria Souza', phone: '+55 11 91234-5678', email: 'maria@example.com' },
        acceptedTerms: true,
      });
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(201);
    const orderId = pedido.body.orderId as string;
    const { rows: p } = await h.owner.query<{ provider_payment_id: string }>(
      `SELECT provider_payment_id FROM payments WHERE order_id = $1 AND provider = 'STRIPE'`,
      [orderId],
    );
    return { orderId, pi: p[0]!.provider_payment_id };
  }

  const statusDe = async (orderId: string) =>
    (
      await h.owner.query<{ pedido: string; pagamento: string }>(
        `SELECT o.status::text AS pedido, p.status::text AS pagamento
           FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.id = $1`,
        [orderId],
      )
    ).rows[0]!;

  const pagamentosConfirmados = async (orderId: string) =>
    (
      await h.owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_events WHERE target_id = $1 AND action = 'order.paid'`,
        [orderId],
      )
    ).rows[0]!.n;

  // -------------------------------------------------------------------------
  describe('desligado (CONNECT_ENABLED=false)', () => {
    it('as tres rotas respondem 404 e nada e gravado', async () => {
      const c = await novaComunidade('cn-off-', off);
      expect((await post(off, '/api/tenant/payment-accounts/connect-stripe', c.cookie, c.slug)).status).toBe(404);
      expect((await post(off, '/api/tenant/payment-accounts/refresh-stripe', c.cookie, c.slug)).status).toBe(404);
      const id = evtId();
      const wh = await avisar(off, { id, type: 'account.updated', object: { id: 'acct_qualquer1' }, account: 'acct_qualquer1' });
      expect(wh.status).toBe(404);
      expect(await eventoGravado(id)).toBeNull();
      expect(await contasStripeDa(c.tenantId)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe('cadastro (connect-stripe)', () => {
    it('dono com MFA: devolve so a URL de cadastro da Stripe e vincula a conta A ESTA comunidade', async () => {
      const c = await novaComunidade('cn-on-');
      const res = await cadastrar(c);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(Object.keys(res.body)).toEqual(['url']);
      expect(res.body.url).toMatch(/^https:\/\/connect\.stripe\.test\/setup\/acct_/);
      const acct = (res.body.url as string).split('/')[4]!;
      expect(await contasStripeDa(c.tenantId)).toEqual([acct]);
      expect(res.text).not.toContain(FAKE_KEY);
    });

    it('sem sessao: 401; SUPPORT e FINANCE: 403; dono sem segundo fator: 403 MFA — e nada e criado', async () => {
      const c = await novaComunidade('cn-auth-');
      const semSessao = await request(h.app).post('/api/tenant/payment-accounts/connect-stripe').set('x-tenant-slug', c.slug).send({});
      expect(semSessao.status).toBe(401);
      expect((await cadastrar(c, await membro(c, 'SUPPORT'))).status).toBe(403);
      expect((await cadastrar(c, await membro(c, 'FINANCE'))).status).toBe(403);

      const dono2 = await seedAccount(h.owner);
      await grantMembership(h.owner, { tenantId: c.tenantId, userId: dono2.userId, role: 'OWNER' });
      const semMfa = await cadastrar(c, await entrar(h, dono2, false));
      expect(semMfa.status).toBe(403);
      expect(semMfa.body.error.code).toMatch(/MFA/);
      expect(await contasStripeDa(c.tenantId)).toEqual([]);
    });

    it('nao serve para outra comunidade: sem vinculo e 404, e comunidade/conta no corpo sao ignoradas', async () => {
      const a = await novaComunidade('cn-a-');
      const b = await novaComunidade('cn-b-');
      const acctB = await cadastrarOk(b, false);
      // Dono de A pedindo pela comunidade B: barrado antes do handler (sem vinculo, a comunidade
      // nem e revelada: 404 do resolvedor de comunidade).
      expect((await post(h, '/api/tenant/payment-accounts/connect-stripe', a.cookie, b.slug)).status).toBe(404);
      expect(await contasStripeDa(b.tenantId)).toEqual([acctB]);
      // Dono de A tentando apontar a conta/comunidade de B pelo corpo: o corpo nao e lido.
      const res = await cadastrar(a, a.cookie, { tenantId: b.tenantId, account: acctB, accountId: acctB });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const acctA = (res.body.url as string).split('/')[4]!;
      expect(acctA).not.toBe(acctB);
      expect(await contasStripeDa(a.tenantId)).toEqual([acctA]);
      expect(await contasStripeDa(b.tenantId)).toEqual([acctB]);
    });
  });

  // -------------------------------------------------------------------------
  describe('atualizacao (refresh-stripe)', () => {
    it('rele na Stripe a conta DA PROPRIA comunidade e devolve as contas no formato da listagem', async () => {
      const c = await novaComunidade('cn-rf-');
      const acct = await cadastrarOk(c, false);
      stripe.ready(acct); // terminou o cadastro na Stripe; nenhum webhook chegou
      expect((await estadoDa(acct)).charges).toBe(false);

      const res = await atualizar(c);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ enabled: true, checkoutAvailable: true });
      expect(res.body.accounts).toHaveLength(1);
      expect(res.body.accounts[0]).toMatchObject({
        provider: 'STRIPE',
        providerAccountId: acct,
        chargesEnabled: true,
        payoutsEnabled: true,
        requirementsDue: [],
        canReceivePayments: true,
      });
    });

    it('nunca toca a conta de outra comunidade, mesmo com o acct_ dela no corpo', async () => {
      const a = await novaComunidade('cn-rfa-');
      const b = await novaComunidade('cn-rfb-');
      const acctA = await cadastrarOk(a, false);
      const acctB = await cadastrarOk(b, false);
      stripe.ready(acctA);
      const res = await atualizar(b, b.cookie, { account: acctA, accountId: acctA, tenantId: a.tenantId });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.accounts.map((x: { providerAccountId: string }) => x.providerAccountId)).toEqual([acctB]);
      // A conta de A continua com o estado antigo: so a de B foi relida.
      expect((await estadoDa(acctA)).charges).toBe(false);
      // E pela comunidade A, sem vinculo, B nao chega (404 do resolvedor de comunidade).
      expect((await post(h, '/api/tenant/payment-accounts/refresh-stripe', b.cookie, a.slug)).status).toBe(404);
      expect((await estadoDa(acctA)).charges).toBe(false);
    });

    it('sem conta Stripe: 404; sem permissao de gestao: 403; a rota em si nao exige MFA (so a permissao)', async () => {
      const c = await novaComunidade('cn-rf0-');
      expect((await atualizar(c)).status).toBe(404);
      expect((await atualizar(c, await membro(c, 'FINANCE'))).status).toBe(403);
      expect((await atualizar(c, await membro(c, 'SUPPORT'))).status).toBe(403);
      expect(ROUTE_CONTRACTS.refreshStripeAccount).toMatchObject({ mfa: false, tenantPermission: 'payment_account:manage' });
      expect(ROUTE_CONTRACTS.connectStripeAccount).toMatchObject({ mfa: true, tenantPermission: 'payment_account:manage' });
    });
  });

  // -------------------------------------------------------------------------
  describe('webhook (stripe-connect)', () => {
    it('assinatura invalida ou ausente: 401, nada gravado, nada consultado', async () => {
      const c = await novaComunidade('cn-sig-');
      const acct = await cadastrarOk(c, false);
      stripe.ready(acct);
      const id = evtId();
      const consultas = stripe.retrieved.length;

      const errado = await avisar(h, { id, type: 'account.updated', object: { id: acct }, account: acct }, 'whsec_test_fake_errado');
      expect(errado.status).toBe(401);
      const semAssinatura = await request(h.app)
        .post('/api/webhooks/stripe-connect')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ id, type: 'account.updated', account: acct, data: { object: { id: acct } } }));
      expect(semAssinatura.status).toBe(401);

      expect(await eventoGravado(id)).toBeNull();
      expect(stripe.retrieved.length).toBe(consultas);
      expect((await estadoDa(acct)).charges).toBe(false);
    });

    it('account.updated: o estado vem da STRIPE, nunca do corpo do aviso', async () => {
      const c = await novaComunidade('cn-au-');
      const acct = await cadastrarOk(c, false);

      // O corpo MENTE (charges_enabled true); a Stripe diz que nao.
      const mentira = await avisar(h, {
        type: 'account.updated',
        account: acct,
        object: { id: acct, object: 'account', charges_enabled: true, payouts_enabled: true, requirements: { currently_due: [] } },
      });
      expect(mentira.status, JSON.stringify(mentira.body)).toBe(200);
      expect(mentira.body).toEqual({ received: true, result: 'processed' });
      expect(await estadoDa(acct)).toEqual({ charges: false, payouts: false, due: ['external_account'] });

      // A Stripe passa a dizer que sim: o proximo aviso (mesmo com o corpo dizendo o contrario) liga.
      stripe.ready(acct);
      const real = await avisar(h, {
        type: 'account.updated',
        account: acct,
        object: { id: acct, object: 'account', charges_enabled: false, payouts_enabled: false },
      });
      expect(real.status).toBe(200);
      expect(await estadoDa(acct)).toEqual({ charges: true, payouts: true, due: [] });
    });

    it('payment_intent.succeeded: CONSULTA a Stripe; requires_action nao paga; succeeded paga (RN06)', async () => {
      const c = await novaComunidade('cn-pi-');
      await cadastrarOk(c, true);
      const { orderId, pi } = await compra(c);

      // O aviso diz "succeeded", mas na Stripe o PIX ainda espera o comprador.
      const consultas = stripe.retrieved.length;
      const cedo = await avisar(h, { type: 'payment_intent.succeeded', object: { id: pi, object: 'payment_intent', status: 'succeeded' } });
      expect(cedo.status, JSON.stringify(cedo.body)).toBe(200);
      expect(stripe.retrieved.slice(consultas)).toEqual([pi]);
      expect(await statusDe(orderId)).toEqual({ pedido: 'PENDENTE', pagamento: 'PENDENTE' });

      stripe.setIntentStatus(pi, 'succeeded');
      const pago = await avisar(h, { type: 'payment_intent.succeeded', object: { id: pi, object: 'payment_intent' } });
      expect(pago.status).toBe(200);
      expect(pago.body).toEqual({ received: true, result: 'processed' });
      expect(await statusDe(orderId)).toEqual({ pedido: 'PAGO', pagamento: 'APROVADO' });
    });

    it('o MESMO event.id duas vezes: efeito uma vez (a segunda nem consulta a Stripe)', async () => {
      const c = await novaComunidade('cn-dup-');
      await cadastrarOk(c, true);
      const { orderId, pi } = await compra(c);
      stripe.setIntentStatus(pi, 'succeeded');
      const id = evtId();

      const primeira = await avisar(h, { id, type: 'payment_intent.succeeded', object: { id: pi } });
      expect(primeira.body).toEqual({ received: true, result: 'processed' });
      const consultas = stripe.retrieved.length;
      const pagos = await pagamentosConfirmados(orderId);
      expect(pagos).toBe(1);

      const segunda = await avisar(h, { id, type: 'payment_intent.succeeded', object: { id: pi } });
      expect(segunda.status).toBe(200);
      expect(segunda.body).toEqual({ received: true, result: 'duplicate' });
      expect(stripe.retrieved.length).toBe(consultas);
      expect(await pagamentosConfirmados(orderId)).toBe(1);
      expect(await statusDe(orderId)).toEqual({ pedido: 'PAGO', pagamento: 'APROVADO' });
      expect(await eventoGravado(id)).toEqual({ processed: true });
    });

    it('falha transitoria da Stripe: 503 e o evento fica reprocessavel; o reenvio conclui', async () => {
      const c = await novaComunidade('cn-retry-');
      await cadastrarOk(c, true);
      const { orderId, pi } = await compra(c);
      stripe.setIntentStatus(pi, 'succeeded');
      const id = evtId();

      stripe.failNextRetrieve = Object.assign(new Error('rede'), { type: 'StripeConnectionError' });
      const falhou = await avisar(h, { id, type: 'payment_intent.succeeded', object: { id: pi } });
      expect(falhou.status).toBe(503);
      expect(await eventoGravado(id)).toEqual({ processed: false });
      expect(await statusDe(orderId)).toEqual({ pedido: 'PENDENTE', pagamento: 'PENDENTE' });

      const reenvio = await avisar(h, { id, type: 'payment_intent.succeeded', object: { id: pi } });
      expect(reenvio.status).toBe(200);
      expect(reenvio.body).toEqual({ received: true, result: 'processed' });
      expect(await pagamentosConfirmados(orderId)).toBe(1);
      expect(await statusDe(orderId)).toEqual({ pedido: 'PAGO', pagamento: 'APROVADO' });
      expect(await eventoGravado(id)).toEqual({ processed: true });
    });

    it('evento de OUTRA conta conectada que o pagamento: ignorado, sem consulta e sem efeito', async () => {
      const c = await novaComunidade('cn-acc-');
      await cadastrarOk(c, true);
      const { orderId, pi } = await compra(c);
      stripe.setIntentStatus(pi, 'succeeded');
      const consultas = stripe.retrieved.length;

      const res = await avisar(h, { type: 'payment_intent.succeeded', account: 'acct_deoutracomunidade1', object: { id: pi } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, result: 'ignored' });
      expect(stripe.retrieved.length).toBe(consultas);
      expect(await statusDe(orderId)).toEqual({ pedido: 'PENDENTE', pagamento: 'PENDENTE' });
    });

    it('PaymentIntent cujo destino nao e a conta do pagamento: consultado, recusado pelo gateway, nada pago', async () => {
      const c = await novaComunidade('cn-dst-');
      await cadastrarOk(c, true);
      const { orderId, pi } = await compra(c);
      stripe.setIntentStatus(pi, 'succeeded');
      stripe.setIntentDestination(pi, 'acct_deoutracomunidade2');
      const res = await avisar(h, { type: 'payment_intent.succeeded', object: { id: pi } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, result: 'ignored' });
      expect(await statusDe(orderId)).toEqual({ pedido: 'PENDENTE', pagamento: 'PENDENTE' });
    });

    it('payment_intent.canceled e .payment_failed e charge.refunded tambem so disparam a CONSULTA', async () => {
      const c = await novaComunidade('cn-oth-');
      await cadastrarOk(c, true);
      const { orderId, pi } = await compra(c);
      for (const [type, object] of [
        ['payment_intent.payment_failed', { id: pi }],
        ['payment_intent.canceled', { id: pi, status: 'canceled' }],
        ['charge.refunded', { id: 'ch_fake1', object: 'charge', payment_intent: pi, refunded: true }],
      ] as const) {
        const consultas = stripe.retrieved.length;
        const res = await avisar(h, { type, object });
        expect(res.status, `${type} ${JSON.stringify(res.body)}`).toBe(200);
        expect(stripe.retrieved.slice(consultas), type).toEqual([pi]);
      }
      // Na Stripe o PIX continua aguardando: nenhum aviso mudou o pedido.
      expect(await statusDe(orderId)).toEqual({ pedido: 'PENDENTE', pagamento: 'PENDENTE' });
    });

    it('pagamento desconhecido: 200 ignorado', async () => {
      const res = await avisar(h, { type: 'payment_intent.succeeded', object: { id: 'pi_naoexiste123' } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, result: 'ignored' });
    });

    it('evento desconhecido: 200 ignorado, nada gravado', async () => {
      const id = evtId();
      const res = await avisar(h, { id, type: 'customer.created', object: { id: 'cus_fake1' } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, result: 'ignored' });
      expect(await eventoGravado(id)).toBeNull();
    });

    it('evento LIVE numa instalacao de teste: 200 ignorado, nada consultado', async () => {
      const c = await novaComunidade('cn-live-');
      const acct = await cadastrarOk(c, false);
      stripe.ready(acct);
      const id = evtId();
      const res = await avisar(h, { id, type: 'account.updated', account: acct, object: { id: acct }, livemode: true });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, result: 'ignored' });
      expect(await eventoGravado(id)).toBeNull();
      expect((await estadoDa(acct)).charges).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('listagem numa implantacao so com a Stripe', () => {
    it('enabled=true mesmo sem o Mercado Pago ligado', async () => {
      const c = await novaComunidade('cn-ls-');
      const res = await request(h.app).get('/api/tenant/payment-accounts').set('Cookie', c.cookie).set('x-tenant-slug', c.slug);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ enabled: true, checkoutAvailable: false, accounts: [] });
    });

    it('a conexao do Mercado Pago (rota antiga) continua sendo so do Mercado Pago: indisponivel aqui', async () => {
      const c = await novaComunidade('cn-mp-');
      const res = await post(h, '/api/tenant/payment-accounts/connect', c.cookie, c.slug, { provider: 'MERCADO_PAGO' });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('PAYMENT_ACCOUNT_UNAVAILABLE');
      expect(await contasStripeDa(c.tenantId)).toEqual([]);
    });
  });
});
