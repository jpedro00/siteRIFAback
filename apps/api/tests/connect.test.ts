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
  grantPlatformRole,
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
    it('meios de pagamento sem nenhum provedor ligado: NO_ACCOUNT, nada ligado, mesmo com preferencia do criador gravada', async () => {
      const c = await novaComunidade('cn-pm-off-', off);
      await off.owner.query(
        `INSERT INTO tenant_payment_preferences (tenant_id, disabled_methods) VALUES ($1, '{PIX}')`,
        [c.tenantId],
      );
      const res = await request(off.app).get('/api/tenant/payment-methods').set('Cookie', c.cookie).set('x-tenant-slug', c.slug);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ status: 'NO_ACCOUNT', provider: null, accountId: null });
      // Sem provedor nada e reportado: o PIX fica desligado por isso (a preferencia so vale para o reportado).
      expect(res.body.methods.find((m: { kind: string }) => m.kind === 'PIX')).toEqual({
        kind: 'PIX',
        providerReported: false,
        enabled: false,
        reason: 'NOT_REPORTED_BY_PROVIDER',
      });
    });

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

    it('duas entregas SIMULTANEAS do mesmo event.id: uma processa, a outra responde 503 sem trabalho (a Stripe reenvia)', async () => {
      const c = await novaComunidade('cn-par-');
      await cadastrarOk(c, true);
      const { orderId, pi } = await compra(c);
      stripe.setIntentStatus(pi, 'succeeded');
      const id = evtId();
      const consultas = stripe.retrieved.filter((x) => x === pi).length;

      // Consulta lenta: a segunda entrega chega com a primeira ainda em andamento.
      stripe.retrieveDelayMs = 300;
      let respostas;
      try {
        respostas = await Promise.all([
          avisar(h, { id, type: 'payment_intent.succeeded', object: { id: pi } }),
          avisar(h, { id, type: 'payment_intent.succeeded', object: { id: pi } }),
        ]);
      } finally {
        stripe.retrieveDelayMs = 0;
      }
      // A que chegou com a outra em andamento NAO diz "duplicate": se a primeira falhar, a Stripe
      // ja teria parado de reenviar. 503 = "tente de novo depois".
      expect(respostas.map((r) => r.status).sort()).toEqual([200, 503]);
      expect(respostas.find((r) => r.status === 200)!.body).toEqual({ received: true, result: 'processed' });
      expect(stripe.retrieved.filter((x) => x === pi).length - consultas).toBe(1);
      expect(await pagamentosConfirmados(orderId)).toBe(1);
      expect(await eventoGravado(id)).toEqual({ processed: true });
    });

    it('lease: evento reivindicado ha pouco responde 503 sem trabalho; lease vencido (>60s) processa', async () => {
      const c = await novaComunidade('cn-lease-');
      await cadastrarOk(c, true);
      const { orderId, pi } = await compra(c);
      stripe.setIntentStatus(pi, 'succeeded');
      const id = evtId();
      // Outra entrega reivindicou agora e ainda nao terminou.
      await h.owner.query(
        `INSERT INTO stripe_connect_webhook_events (event_id, type, claimed_at) VALUES ($1, 'payment_intent.succeeded', now())`,
        [id],
      );
      const consultas = stripe.retrieved.length;
      const emAndamento = await avisar(h, { id, type: 'payment_intent.succeeded', object: { id: pi } });
      expect(emAndamento.status).toBe(503);
      expect(emAndamento.body).not.toHaveProperty('result');
      expect(stripe.retrieved.length).toBe(consultas);
      expect(await statusDe(orderId)).toEqual({ pedido: 'PENDENTE', pagamento: 'PENDENTE' });

      // Aquela entrega morreu no meio: passado o lease, o reenvio da Stripe processa.
      await h.owner.query(`UPDATE stripe_connect_webhook_events SET claimed_at = now() - interval '61 seconds' WHERE event_id = $1`, [id]);
      const reenvio = await avisar(h, { id, type: 'payment_intent.succeeded', object: { id: pi } });
      expect(reenvio.body).toEqual({ received: true, result: 'processed' });
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

    it('charge.refunded de pagamento PAGO, estornado na Stripe: ESTORNADO uma vez so, mesmo entregue duas vezes', async () => {
      const c = await novaComunidade('cn-ref-');
      await cadastrarOk(c, true);
      const { orderId, pi } = await compra(c);
      stripe.setIntentStatus(pi, 'succeeded');
      expect((await avisar(h, { type: 'payment_intent.succeeded', object: { id: pi } })).body.result).toBe('processed');
      expect(await statusDe(orderId)).toEqual({ pedido: 'PAGO', pagamento: 'APROVADO' });

      stripe.markRefunded(pi);
      const id = evtId();
      const corpo = { id: 'ch_fakeref1', object: 'charge', payment_intent: pi, refunded: true };
      const consultas = stripe.retrieved.length;
      const primeira = await avisar(h, { id, type: 'charge.refunded', object: corpo });
      expect(primeira.status, JSON.stringify(primeira.body)).toBe(200);
      expect(primeira.body).toEqual({ received: true, result: 'processed' });
      // RN06: o aviso so disparou a CONSULTA; quem disse "estornado" foi a Stripe.
      expect(stripe.retrieved.slice(consultas)).toEqual([pi]);
      // O pedido nao muda (o ramo 'refunded' de apply_psp_payment so mexe no pagamento).
      expect(await statusDe(orderId)).toEqual({ pedido: 'PAGO', pagamento: 'ESTORNADO' });

      // Mesmo event.id de novo: duplicate. Outro event.id (reenvio como evento novo): consulta, no-op.
      expect((await avisar(h, { id, type: 'charge.refunded', object: corpo })).body.result).toBe('duplicate');
      expect((await avisar(h, { type: 'charge.refunded', object: corpo })).body.result).toBe('processed');
      const { rows } = await h.owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_events a JOIN payments p ON a.target_id = p.id::text
          WHERE p.order_id = $1 AND a.action = 'payment.refunded'`,
        [orderId],
      );
      expect(rows[0]!.n).toBe(1);
      expect(await statusDe(orderId)).toEqual({ pedido: 'PAGO', pagamento: 'ESTORNADO' });
    });

    it('charge.refunded de estorno PARCIAL: o pagamento continua APROVADO', async () => {
      const c = await novaComunidade('cn-rfp-');
      await cadastrarOk(c, true);
      const { orderId, pi } = await compra(c);
      stripe.setIntentStatus(pi, 'succeeded');
      await avisar(h, { type: 'payment_intent.succeeded', object: { id: pi } });
      stripe.markRefunded(pi, 500);
      const res = await avisar(h, { type: 'charge.refunded', object: { id: 'ch_fakeref2', object: 'charge', payment_intent: pi } });
      expect(res.body.result).toBe('processed');
      expect(await statusDe(orderId)).toEqual({ pedido: 'PAGO', pagamento: 'APROVADO' });
    });

    describe('estorno que FALHOU depois de ESTORNADO (refund.failed / refund.updated / charge.refund.updated)', () => {
      /** Pago e estornado NA STRIPE, `charge.refunded` processado: pagamento ESTORNADO. */
      async function estornado(prefixo: string) {
        const c = await novaComunidade(prefixo);
        const acct = await cadastrarOk(c, true);
        const { orderId, pi } = await compra(c);
        stripe.setIntentStatus(pi, 'succeeded');
        await avisar(h, { type: 'payment_intent.succeeded', object: { id: pi } });
        const refund = (await stripe.refunds.create({ payment_intent: pi })) as { id: string };
        await avisar(h, { type: 'charge.refunded', object: { id: 'ch_x', object: 'charge', payment_intent: pi } });
        expect(await statusDe(orderId)).toEqual({ pedido: 'PAGO', pagamento: 'ESTORNADO' });
        return { c, acct, orderId, pi, refundId: refund.id };
      }
      const issues = async (orderId: string) =>
        (
          await h.owner.query<{ kind: string; detail: Record<string, unknown> }>(
            `SELECT i.kind, i.detail FROM payment_reconciliation_issues i
               WHERE i.order_id = $1 AND i.resolved_at IS NULL AND i.kind = 'REFUND_FAILED'`,
            [orderId],
          )
        ).rows;
      const corpoRefund = (pi: string, refundId: string, status: string) => ({
        id: refundId,
        object: 'refund',
        status,
        payment_intent: pi,
        amount: 1999,
      });

      it('Stripe diz failed: UMA divergencia REFUND_FAILED, mesmo com o evento repetido e por tres tipos; status continua ESTORNADO', async () => {
        const e = await estornado('cn-rff-');
        stripe.setRefundStatus(e.refundId, 'failed', 'expired_or_canceled_card');
        const id = evtId();
        const listas = stripe.refundLists.length;

        const primeira = await avisar(h, { id, type: 'refund.failed', object: corpoRefund(e.pi, e.refundId, 'failed') });
        expect(primeira.status, JSON.stringify(primeira.body)).toBe(200);
        expect(primeira.body).toEqual({ received: true, result: 'processed' });
        // RN06: quem disse "falhou" foi a CONSULTA (refunds.list do PaymentIntent).
        expect(stripe.refundLists.slice(listas)).toEqual([e.pi]);

        expect((await avisar(h, { id, type: 'refund.failed', object: corpoRefund(e.pi, e.refundId, 'failed') })).body.result).toBe(
          'duplicate',
        );
        for (const type of ['refund.updated', 'charge.refund.updated', 'refund.failed']) {
          const res = await avisar(h, { type, object: corpoRefund(e.pi, e.refundId, 'failed') });
          // Mesmo estorno ja registrado: nada novo (200, sem divergencia nova).
          expect(res.body, type).toEqual({ received: true, result: 'ignored' });
        }

        const abertas = await issues(e.orderId);
        const a = { refundId: e.refundId, failureReason: 'expired_or_canceled_card', amountCents: 1999 };
        expect(abertas).toEqual([{ kind: 'REFUND_FAILED', detail: { ...a, refunds: [a] } }]);
        expect(await statusDe(e.orderId)).toEqual({ pedido: 'PAGO', pagamento: 'ESTORNADO' });
        // Nenhuma tentativa automatica de estornar de novo.
        expect(stripe.refundCalls.filter((r) => r.params['payment_intent'] === e.pi)).toHaveLength(1);
      });

      it('o corpo NAO vale: diz failed mas a Stripe diz succeeded => ignorado, nenhuma divergencia', async () => {
        const e = await estornado('cn-rfl-');
        const res = await avisar(h, { type: 'refund.failed', object: { ...corpoRefund(e.pi, e.refundId, 'failed'), failure_reason: 'lost_or_stolen_card' } });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ received: true, result: 'ignored' });
        expect(await issues(e.orderId)).toEqual([]);
      });

      it('o corpo NAO vale: diz succeeded mas a Stripe diz failed => divergencia aberta', async () => {
        const e = await estornado('cn-rfr-');
        stripe.setRefundStatus(e.refundId, 'failed');
        const res = await avisar(h, { type: 'refund.updated', object: corpoRefund(e.pi, e.refundId, 'succeeded') });
        expect(res.body).toEqual({ received: true, result: 'processed' });
        const a = { refundId: e.refundId, failureReason: null, amountCents: 1999 };
        expect(await issues(e.orderId)).toEqual([{ kind: 'REFUND_FAILED', detail: { ...a, refunds: [a] } }]);
      });

      it('resolvida pelo operador: o estorno A (failed para sempre na Stripe) nao reabre quando o novo estorno B sai', async () => {
        const e = await estornado('cn-rfres-');
        stripe.setRefundStatus(e.refundId, 'failed', 'expired_or_canceled_card');
        await avisar(h, { type: 'refund.failed', object: corpoRefund(e.pi, e.refundId, 'failed') });
        // Procedimento do runbook: o operador faz um NOVO estorno B no Dashboard e resolve a divergencia.
        const b = stripe.addRefund(e.pi, 'pending');
        await h.owner.query(
          `UPDATE payment_reconciliation_issues SET resolved_at = now(), review_status = 'RESOLVIDA_MANUALMENTE'
            WHERE order_id = $1 AND kind = 'REFUND_FAILED'`,
          [e.orderId],
        );
        stripe.setRefundStatus(b, 'succeeded');
        for (const type of ['refund.updated', 'charge.refund.updated']) {
          const res = await avisar(h, { type, object: corpoRefund(e.pi, b, 'succeeded') });
          expect(res.body, type).toEqual({ received: true, result: 'ignored' });
        }
        expect(await issues(e.orderId)).toEqual([]);
        const { rows } = await h.owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM payment_reconciliation_issues WHERE order_id = $1 AND kind = 'REFUND_FAILED'`,
          [e.orderId],
        );
        expect(rows[0]!.n).toBe(1);
      });

      it('estorno B falha com a divergencia de A aberta: B fica visivel na MESMA divergencia', async () => {
        const e = await estornado('cn-rfb-');
        stripe.setRefundStatus(e.refundId, 'failed', 'expired_or_canceled_card');
        await avisar(h, { type: 'refund.failed', object: corpoRefund(e.pi, e.refundId, 'failed') });
        const b = stripe.addRefund(e.pi, 'failed', 'lost_or_stolen_card');
        const res = await avisar(h, { type: 'refund.failed', object: corpoRefund(e.pi, b, 'failed') });
        expect(res.body).toEqual({ received: true, result: 'processed' });
        const a = { refundId: e.refundId, failureReason: 'expired_or_canceled_card', amountCents: 1999 };
        const bb = { refundId: b, failureReason: 'lost_or_stolen_card', amountCents: 1999 };
        const abertas = await issues(e.orderId);
        expect(abertas).toHaveLength(1);
        expect(abertas[0]!.detail).toEqual({ ...a, refunds: expect.arrayContaining([a, bb]) });
        expect((abertas[0]!.detail['refunds'] as unknown[]).length).toBe(2);
        // De novo, por outro tipo: nada novo.
        expect((await avisar(h, { type: 'refund.updated', object: corpoRefund(e.pi, b, 'failed') })).body.result).toBe('ignored');
      });

      it('aparece na conciliacao do Console (pagamento ESTORNADO nao some da lista)', async () => {
        const e = await estornado('cn-rfv-');
        stripe.setRefundStatus(e.refundId, 'failed', 'expired_or_canceled_card');
        await avisar(h, { type: 'refund.failed', object: corpoRefund(e.pi, e.refundId, 'failed') });
        const fin = await seedAccount(h.owner);
        await grantPlatformRole(h.owner, { userId: fin.userId, role: 'PLATFORM_FINANCE' });
        const res = await request(h.app).get('/api/platform/reconciliation').set('Cookie', await entrar(h, fin));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.byKind).toContainEqual({ kind: 'REFUND_FAILED', count: expect.any(Number) });
        const item = res.body.issues.find((i: { reference: string; kind: string }) => i.reference === e.orderId.slice(0, 8) && i.kind === 'REFUND_FAILED');
        expect(item).toMatchObject({ kind: 'REFUND_FAILED', paymentStatus: 'ESTORNADO', amountCents: 1999 });
      });

      it('evento de OUTRA conta conectada, ou PaymentIntent de outra conta: ignorado, sem divergencia', async () => {
        const e = await estornado('cn-rfa-');
        stripe.setRefundStatus(e.refundId, 'failed');
        const listas = stripe.refundLists.length;
        const outra = await avisar(h, { type: 'refund.failed', account: 'acct_deoutracomunidade3', object: corpoRefund(e.pi, e.refundId, 'failed') });
        expect(outra.body).toEqual({ received: true, result: 'ignored' });
        stripe.setIntentDestination(e.pi, 'acct_deoutracomunidade4');
        const destino = await avisar(h, { type: 'refund.failed', object: corpoRefund(e.pi, e.refundId, 'failed') });
        expect(destino.body).toEqual({ received: true, result: 'ignored' });
        // Nem chegou a listar os estornos: a conta foi conferida antes.
        expect(stripe.refundLists.length).toBe(listas);
        expect(await issues(e.orderId)).toEqual([]);
      });

      it('pagamento desconhecido, ou que nao e STRIPE: ignorado', async () => {
        const desconhecido = await avisar(h, { type: 'refund.failed', object: corpoRefund('pi_naoexiste456', 're_naoexiste1', 'failed') });
        expect(desconhecido.body).toEqual({ received: true, result: 'ignored' });
        const semPi = await avisar(h, { type: 'refund.failed', object: { id: 're_x1', object: 'refund', status: 'failed' } });
        expect(semPi.body).toEqual({ received: true, result: 'ignored' });

        const e = await estornado('cn-rfo-');
        stripe.setRefundStatus(e.refundId, 'failed');
        await h.owner.query(`UPDATE payments SET provider = 'FAKE' WHERE provider_payment_id = $1`, [e.pi]);
        const outro = await avisar(h, { type: 'refund.failed', object: corpoRefund(e.pi, e.refundId, 'failed') });
        expect(outro.body).toEqual({ received: true, result: 'ignored' });
        expect(await issues(e.orderId)).toEqual([]);
      });

      it('falha transitoria ao listar os estornos: 503 e o reenvio abre a divergencia', async () => {
        const e = await estornado('cn-rft-');
        stripe.setRefundStatus(e.refundId, 'failed');
        const id = evtId();
        stripe.failNextRefundList = Object.assign(new Error('rede'), { type: 'StripeConnectionError' });
        expect((await avisar(h, { id, type: 'refund.failed', object: corpoRefund(e.pi, e.refundId, 'failed') })).status).toBe(503);
        expect(await eventoGravado(id)).toEqual({ processed: false });
        expect(await issues(e.orderId)).toEqual([]);
        const reenvio = await avisar(h, { id, type: 'refund.failed', object: corpoRefund(e.pi, e.refundId, 'failed') });
        expect(reenvio.body).toEqual({ received: true, result: 'processed' });
        expect(await issues(e.orderId)).toHaveLength(1);
      });
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
