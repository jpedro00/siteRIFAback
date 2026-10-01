import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Stripe from 'stripe';
import { StripeBillingGateway } from '@clubedarifa/billing';
import { FakeStripeClient } from '@clubedarifa/billing/testing';
import {
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

/**
 * Fase 7 · Etapa 5 · catalogo de planos e assinaturas no Console Super Admin.
 *
 * O gateway da Stripe e o REAL, sobre um cliente em memoria (sem rede, sem chave real). O
 * preco de um plano so entra por aqui e nasce no servidor: o navegador nunca informa um ID
 * da Stripe.
 */
describe.skipIf(!hasTestDatabase)(`Console · planos e assinaturas ${hasTestDatabase ? '' : skipReason}`, () => {
  let harness: Harness;
  let fake: FakeStripeClient;
  let financeCookie: string;
  let supportCookie: string;
  let noMfaCookie: string;
  let ownerCookie: string;
  let ownerSlug: string;

  async function entrar(account: SeededAccount, comMfa = true): Promise<string> {
    const secret = comMfa ? await seedConfirmedTotp(harness.owner, account.userId) : null;
    const login = await loginAs(harness, account);
    return secret ? (await verifyMfa(harness, login.cookie, await currentCode(secret))).cookie : login.cookie;
  }

  const codigo = () => unique('pl-').toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const corpo = (extra: Record<string, unknown> = {}) => ({
    code: codigo(),
    name: 'Plano Console',
    description: 'Teste',
    interval: 'month',
    priceCents: 4990,
    currency: 'brl',
    maxActiveDraws: 5,
    maxTeamMembers: 3,
    features: [],
    ...extra,
  });
  const como = (cookie: string) => ({
    get: (url: string) => request(harness.app).get(url).set('Cookie', cookie),
    post: (url: string, body: object = {}) => request(harness.app).post(url).set('Cookie', cookie).send(body),
    patch: (url: string, body: object = {}) => request(harness.app).patch(url).set('Cookie', cookie).send(body),
  });
  const financeiro = () => como(financeCookie);

  async function novaComunidadeComAssinatura(status: string, planId: string, nome: string, extra: { pastDueAgo?: string } = {}) {
    const slug = unique('cs-');
    const tenantId = await seedTenantWithSlug(harness.owner, slug, nome);
    const customer = unique('cus_').replace(/[^a-zA-Z0-9_]/g, '');
    await harness.owner.query('INSERT INTO tenant_billing (tenant_id, stripe_customer_id) VALUES ($1, $2)', [tenantId, customer]);
    await harness.owner.query(
      `INSERT INTO tenant_subscriptions (tenant_id, plan_id, stripe_customer_id, stripe_subscription_id, status, stripe_synced_at,
                                         current_period_end, past_due_since)
       VALUES ($1, $2, $3, $4, $5::subscription_status, now(), now() + interval '20 days',
               CASE WHEN $5 = 'past_due' THEN now() - $6::interval END)`,
      [tenantId, planId, customer, unique('sub_').replace(/[^a-zA-Z0-9_]/g, ''), status, extra.pastDueAgo ?? '1 day'],
    );
    return { slug, tenantId };
  }

  beforeAll(async () => {
    fake = new FakeStripeClient();
    const gateway = new StripeBillingGateway({
      secretKey: 'sk_test_local',
      webhookSecret: 'whsec_local',
      client: fake as unknown as Stripe,
    });
    harness = await createHarness({ billing: { gateway, schedule: () => undefined } });
    await cleanup(harness.owner);

    const fin = await seedAccount(harness.owner);
    await grantPlatformRole(harness.owner, { userId: fin.userId, role: 'PLATFORM_FINANCE' });
    financeCookie = await entrar(fin);

    const sup = await seedAccount(harness.owner);
    await grantPlatformRole(harness.owner, { userId: sup.userId, role: 'PLATFORM_SUPPORT' });
    supportCookie = await entrar(sup);

    const semMfa = await seedAccount(harness.owner);
    await grantPlatformRole(harness.owner, { userId: semMfa.userId, role: 'PLATFORM_FINANCE' });
    noMfaCookie = await entrar(semMfa, false);

    ownerSlug = unique('own-');
    const t = await seedTenantWithSlug(harness.owner, ownerSlug, 'Comunidade Dona');
    const dono = await seedAccount(harness.owner);
    await grantMembership(harness.owner, { tenantId: t, userId: dono.userId, role: 'OWNER' });
    ownerCookie = await entrar(dono);
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  // -------------------------------------------------------------------------
  describe('permissao', () => {
    it('sem sessao: 401; dono de comunidade: 403; outro papel de plataforma: 403; financeiro SEM MFA: 403', async () => {
      expect((await request(harness.app).get('/api/platform/plans')).status).toBe(401);
      expect((await request(harness.app).post('/api/platform/plans').send(corpo())).status).toBe(401);
      expect((await como(ownerCookie).get('/api/platform/plans')).status).toBe(403);
      expect((await como(ownerCookie).post('/api/platform/plans', corpo())).status).toBe(403);
      expect((await como(supportCookie).get('/api/platform/plans')).status).toBe(403);
      expect((await como(supportCookie).post('/api/platform/plans', corpo())).status).toBe(403);
      expect((await como(supportCookie).get('/api/platform/subscriptions')).status).toBe(403);
      const semMfa = await como(noMfaCookie).get('/api/platform/plans');
      expect(semMfa.status).toBe(403);
      expect(semMfa.body.error.code).toMatch(/MFA/);
    });

    it('nada foi criado na Stripe pelas tentativas recusadas', async () => {
      expect(fake.state.products.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('criar plano', () => {
    it('o servidor cria Product e Price na Stripe com o preco do pedido e grava os IDs resultantes', async () => {
      const pedido = corpo({ priceCents: 12345, interval: 'year' });
      const res = await financeiro().post('/api/platform/plans', pedido);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ code: pedido.code, status: 'DRAFT', priceCents: 12345, interval: 'year', currency: 'brl' });

      const produto = fake.state.products.get(res.body.stripeProductId);
      const preco = fake.state.prices.get(res.body.stripePriceId);
      expect(produto?.name).toBe('Plano Console');
      expect(preco).toMatchObject({ product: res.body.stripeProductId, unitAmount: 12345, currency: 'brl', interval: 'year' });

      const { rows } = await harness.owner.query(`SELECT 1 FROM audit_events WHERE action = 'plan.created' AND target_id = $1`, [res.body.id]);
      expect(rows).toHaveLength(1);
    });

    it('IDs da Stripe e status enviados pelo navegador sao IGNORADOS', async () => {
      const res = await financeiro().post(
        '/api/platform/plans',
        corpo({ stripeProductId: 'prod_forjado', stripePriceId: 'price_forjado', status: 'AVAILABLE' }),
      );
      expect(res.status).toBe(201);
      expect(res.body.stripeProductId).not.toBe('prod_forjado');
      expect(res.body.stripePriceId).not.toBe('price_forjado');
      expect(res.body.status).toBe('DRAFT');
    });

    it('validacao: preco negativo, periodicidade invalida e codigo invalido sao 400', async () => {
      for (const ruim of [{ priceCents: -1 }, { interval: 'week' }, { code: 'Invalido Com Espaco' }, { maxTeamMembers: 0 }]) {
        expect((await financeiro().post('/api/platform/plans', corpo(ruim))).status).toBe(400);
      }
    });

    it('falha DEPOIS do Product e ANTES do Price: fica rascunho com o Product; repetir retoma sem duplicar', async () => {
      const pedido = corpo();
      const produtosAntes = fake.state.products.size;
      fake.failNext('prices.create', { type: 'StripeAPIError', statusCode: 503, message: 'indisponivel' }, 1);

      const falha = await financeiro().post('/api/platform/plans', pedido);
      expect(falha.status).toBe(503);
      expect(falha.body.error.code).toBe('BILLING_UNAVAILABLE');

      const { rows } = await harness.owner.query<{ id: string; stripe_product_id: string | null; stripe_price_id: string | null; status: string }>(
        'SELECT id, stripe_product_id, stripe_price_id, status FROM plans WHERE code = $1',
        [pedido.code],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.stripe_product_id).not.toBeNull();
      expect(rows[0]!.stripe_price_id).toBeNull();
      expect(rows[0]!.status).toBe('DRAFT');
      expect(fake.state.products.size).toBe(produtosAntes + 1);

      const retomado = await financeiro().post('/api/platform/plans', pedido);
      expect(retomado.status, JSON.stringify(retomado.body)).toBe(200);
      expect(retomado.body.stripeProductId).toBe(rows[0]!.stripe_product_id);
      expect(retomado.body.stripePriceId).toBeTruthy();
      // nenhum Product novo foi criado na retomada
      expect(fake.state.products.size).toBe(produtosAntes + 1);
    });

    it('falha ao criar o Product: rascunho sem IDs, e repetir conclui', async () => {
      const pedido = corpo();
      fake.failNext('products.create', { type: 'StripeConnectionError', message: 'rede' }, 1);
      expect((await financeiro().post('/api/platform/plans', pedido)).status).toBe(503);
      const { rows } = await harness.owner.query('SELECT stripe_product_id, stripe_price_id FROM plans WHERE code = $1', [pedido.code]);
      expect(rows[0]).toEqual({ stripe_product_id: null, stripe_price_id: null });
      const ok = await financeiro().post('/api/platform/plans', pedido);
      expect(ok.status).toBe(200);
      expect(ok.body.stripePriceId).toBeTruthy();
    });

    it('codigo duplicado: o pedido IGUAL de um plano ja sincronizado e 409; preco diferente tambem', async () => {
      const pedido = corpo();
      expect((await financeiro().post('/api/platform/plans', pedido)).status).toBe(201);
      const igual = await financeiro().post('/api/platform/plans', pedido);
      expect(igual.status).toBe(409);
      expect(igual.body.error.details).toMatchObject({ reason: 'PLAN_CODE_TAKEN' });
      const outroPreco = await financeiro().post('/api/platform/plans', { ...pedido, priceCents: pedido.priceCents + 1 });
      expect(outroPreco.status).toBe(409);
    });

    it('CONCORRENTE: cinco pedidos iguais ao mesmo tempo geram UM plano, UM Product e UM Price', async () => {
      const pedido = corpo();
      const produtos = fake.state.products.size;
      const precos = fake.state.prices.size;
      const respostas = await Promise.all(Array.from({ length: 5 }, () => financeiro().post('/api/platform/plans', pedido)));
      for (const r of respostas) expect([200, 201, 409], JSON.stringify(r.body)).toContain(r.status);
      expect(respostas.some((r) => r.status === 201)).toBe(true);
      const { rows } = await harness.owner.query('SELECT stripe_product_id, stripe_price_id FROM plans WHERE code = $1', [pedido.code]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!['stripe_price_id']).toBeTruthy();
      expect(fake.state.products.size).toBe(produtos + 1);
      expect(fake.state.prices.size).toBe(precos + 1);
    });

    it('cobranca desligada: BILLING_UNAVAILABLE e nenhum plano criado', async () => {
      const semStripe = await createHarness();
      try {
        const pedido = corpo();
        const res = await request(semStripe.app).post('/api/platform/plans').set('Cookie', financeCookie).send(pedido);
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('BILLING_UNAVAILABLE');
        const { rows } = await harness.owner.query('SELECT 1 FROM plans WHERE code = $1', [pedido.code]);
        expect(rows).toHaveLength(0);
      } finally {
        await semStripe.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('editar, publicar e arquivar', () => {
    async function planoCriado(extra: Record<string, unknown> = {}) {
      const res = await financeiro().post('/api/platform/plans', corpo(extra));
      expect(res.status).toBe(201);
      return res.body as { id: string; code: string; priceCents: number };
    }

    it('rascunho -> DISPONIVEL: a comunidade passa a ver o plano; antes, nao', async () => {
      const plano = await planoCriado();
      const antes = await como(ownerCookie).get('/api/tenant/billing/plans').set('x-tenant-slug', ownerSlug);
      expect(antes.body.plans.map((p: { id: string }) => p.id)).not.toContain(plano.id);

      const res = await financeiro().patch(`/api/platform/plans/${plano.id}`, { status: 'AVAILABLE' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe('AVAILABLE');

      const depois = await como(ownerCookie).get('/api/tenant/billing/plans').set('x-tenant-slug', ownerSlug);
      expect(depois.body.plans.map((p: { id: string }) => p.id)).toContain(plano.id);
      // a visao da comunidade nao expoe IDs da Stripe
      expect(JSON.stringify(depois.body)).not.toMatch(/stripe|prod_|price_/i);
    });

    it('nao publica um plano que ainda nao existe na Stripe (409 PLAN_NOT_SYNCED)', async () => {
      const pedido = corpo();
      fake.failNext('products.create', { type: 'StripeAPIError', statusCode: 500, message: 'x' }, 1);
      await financeiro().post('/api/platform/plans', pedido);
      const { rows } = await harness.owner.query<{ id: string }>('SELECT id FROM plans WHERE code = $1', [pedido.code]);
      const res = await financeiro().patch(`/api/platform/plans/${rows[0]!.id}`, { status: 'AVAILABLE' });
      expect(res.status).toBe(409);
      expect(res.body.error.details).toMatchObject({ reason: 'PLAN_NOT_SYNCED' });
    });

    it('edita nome, descricao, limites e funcionalidades; preco NAO muda (e o banco tambem recusa)', async () => {
      const plano = await planoCriado();
      const res = await financeiro().patch(`/api/platform/plans/${plano.id}`, {
        name: 'Novo nome',
        description: null,
        maxActiveDraws: null,
        maxTeamMembers: 10,
        features: ['relatorios_avancados'],
        priceCents: 1,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ name: 'Novo nome', description: null, maxActiveDraws: null, maxTeamMembers: 10, features: ['relatorios_avancados'] });
      expect(res.body.priceCents).toBe(plano.priceCents);

      // so o preco: nada a alterar
      expect((await financeiro().patch(`/api/platform/plans/${plano.id}`, { priceCents: 1 })).status).toBe(400);
      await expect(harness.owner.query('UPDATE plans SET price_cents = 1 WHERE id = $1', [plano.id])).rejects.toThrow(/crie um plano novo/);
      expect((await financeiro().patch(`/api/platform/plans/${plano.id}`, { maxTeamMembers: 0 })).status).toBe(400);
    });

    it('plano inexistente: 404; sem permissao: 403', async () => {
      expect((await financeiro().patch('/api/platform/plans/00000000-0000-4000-8000-000000000000', { name: 'x' })).status).toBe(404);
      const plano = await planoCriado();
      expect((await como(supportCookie).patch(`/api/platform/plans/${plano.id}`, { name: 'x' })).status).toBe(403);
      expect((await como(ownerCookie).patch(`/api/platform/plans/${plano.id}`, { name: 'x' })).status).toBe(403);
    });

    it('ARQUIVAR um plano em uso: some da vitrine de planos, mas a comunidade que o contratou continua vendo-o', async () => {
      const plano = await planoCriado();
      await financeiro().patch(`/api/platform/plans/${plano.id}`, { status: 'AVAILABLE' });
      const uso = await novaComunidadeComAssinatura('active', plano.id, 'Comunidade Em Uso');
      const donoUso = await seedAccount(harness.owner);
      await grantMembership(harness.owner, { tenantId: uso.tenantId, userId: donoUso.userId, role: 'OWNER' });
      const cookieUso = await entrar(donoUso);

      const arq = await financeiro().patch(`/api/platform/plans/${plano.id}`, { status: 'ARCHIVED' });
      expect(arq.body.status).toBe('ARCHIVED');

      const vitrine = await como(cookieUso).get('/api/tenant/billing/plans').set('x-tenant-slug', uso.slug);
      expect(vitrine.body.plans.map((p: { id: string }) => p.id)).not.toContain(plano.id);
      const minha = await como(cookieUso).get('/api/tenant/billing').set('x-tenant-slug', uso.slug);
      expect(minha.status).toBe(200);
      expect(minha.body.subscription.plan).toMatchObject({ id: plano.id, status: 'ARCHIVED' });

      // o catalogo do Super Admin continua mostrando o arquivado
      const lista = await financeiro().get('/api/platform/plans');
      expect(lista.body.plans.find((p: { id: string }) => p.id === plano.id)?.status).toBe('ARCHIVED');
    });
  });

  // -------------------------------------------------------------------------
  describe('catalogo (leitura)', () => {
    it('lista com IDs da Stripe para o financeiro e nenhuma credencial', async () => {
      const res = await financeiro().get('/api/platform/plans');
      expect(res.status).toBe(200);
      expect(res.body.plans.length).toBeGreaterThan(0);
      const primeiro = res.body.plans.find((p: { stripePriceId: string | null }) => p.stripePriceId);
      expect(primeiro).toMatchObject({ stripeProductId: expect.stringMatching(/^prod_/), stripePriceId: expect.stringMatching(/^price_/) });
      expect(JSON.stringify(res.body)).not.toMatch(/sk_test|whsec|secret/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('assinaturas (consulta)', () => {
    let planoId: string;
    let ids: Record<string, string>;

    beforeAll(async () => {
      // So as assinaturas: apagar contas derrubaria as sessoes ja abertas.
      await harness.owner.query('DELETE FROM tenant_subscriptions');
      await harness.owner.query('DELETE FROM tenant_billing');
      const criado = await financeiro().post('/api/platform/plans', corpo({ name: 'Plano Consulta' }));
      planoId = criado.body.id;
      await financeiro().patch(`/api/platform/plans/${planoId}`, { status: 'AVAILABLE' });
      ids = {};
      const a = await novaComunidadeComAssinatura('active', planoId, 'Alfa Clube');
      const b = await novaComunidadeComAssinatura('past_due', planoId, 'Beta Clube', { pastDueAgo: '1 day' });
      const c = await novaComunidadeComAssinatura('past_due', planoId, 'Gama Clube', { pastDueAgo: '40 days' });
      const d = await novaComunidadeComAssinatura('canceled', planoId, 'Delta_100% Clube');
      ids = { a: a.tenantId, b: b.tenantId, c: c.tenantId, d: d.tenantId };
    }, 120_000);

    it('lista uma linha por comunidade com o estado de negocio e o fim da tolerancia', async () => {
      const res = await financeiro().get('/api/platform/subscriptions');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const porNome = Object.fromEntries(res.body.subscriptions.map((s: { tenantName: string }) => [s.tenantName, s]));
      expect(porNome['Alfa Clube'], JSON.stringify(res.body)).toMatchObject({ state: 'ACTIVE', status: 'active', planName: 'Plano Consulta', graceEndsAt: null });
      expect(porNome['Beta Clube']).toMatchObject({ state: 'PAST_DUE_GRACE', status: 'past_due' });
      expect(porNome['Beta Clube'].graceEndsAt).toBeTruthy();
      expect(porNome['Gama Clube'].state).toBe('PAST_DUE_BLOCKED');
      expect(porNome['Delta_100% Clube'].state).toBe('CANCELED');
      expect(JSON.stringify(res.body)).not.toMatch(/stripe_customer|cus_|sub_|secret/i);
    });

    it('filtro por estado e busca por comunidade (com curingas do LIKE escapados)', async () => {
      const grace = await financeiro().get('/api/platform/subscriptions').query({ state: 'PAST_DUE_GRACE' });
      expect(grace.body.subscriptions.map((s: { tenantName: string }) => s.tenantName)).toEqual(['Beta Clube']);

      const busca = await financeiro().get('/api/platform/subscriptions').query({ q: 'gama' });
      expect(busca.body.subscriptions.map((s: { tenantName: string }) => s.tenantName)).toEqual(['Gama Clube']);

      // "%" e "_" sao texto, nao curinga
      const coringa = await financeiro().get('/api/platform/subscriptions').query({ q: '%' });
      expect(coringa.body.subscriptions.map((s: { tenantName: string }) => s.tenantName)).toEqual(['Delta_100% Clube']);
      const sublinhado = await financeiro().get('/api/platform/subscriptions').query({ q: '_' });
      expect(sublinhado.body.subscriptions.map((s: { tenantName: string }) => s.tenantName)).toEqual(['Delta_100% Clube']);

      expect((await financeiro().get('/api/platform/subscriptions').query({ state: 'INVENTADO' })).status).toBe(400);
    });

    it('paginacao por cursor: sem repetir nem pular, e cursor adulterado e 400', async () => {
      const p1 = await financeiro().get('/api/platform/subscriptions').query({ limit: 3 });
      expect(p1.body.subscriptions).toHaveLength(3);
      expect(p1.body.nextCursor).toBeTruthy();
      const p2 = await financeiro().get('/api/platform/subscriptions').query({ limit: 3, cursor: p1.body.nextCursor });
      expect(p2.body.subscriptions).toHaveLength(1);
      expect(p2.body.nextCursor).toBeNull();
      const todos = [...p1.body.subscriptions, ...p2.body.subscriptions].map((s: { tenantId: string }) => s.tenantId);
      expect(new Set(todos).size).toBe(4);
      expect(new Set(todos)).toEqual(new Set(Object.values(ids)));
      expect((await financeiro().get('/api/platform/subscriptions').query({ cursor: 'adulterado' })).status).toBe(400);
    });

    it('somente leitura: nao existe rota de escrita para assinaturas', async () => {
      for (const metodo of ['post', 'put', 'patch', 'delete'] as const) {
        const res = await request(harness.app)[metodo]('/api/platform/subscriptions').set('Cookie', financeCookie).send({});
        expect(res.status).toBe(404);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('Saude · novos indicadores', () => {
    it('conta eventos da Stripe com falha e mostra as contas de recebimento com problema, sem credencial', async () => {
      for (const tabela of ['stripe_webhook_events', 'payment_reconciliation_issues', 'tenant_payment_accounts', 'payment_provider_authorizations']) {
        await harness.owner.query(`DELETE FROM ${tabela}`);
      }
      const t = await seedTenantWithSlug(harness.owner, unique('sa-'), 'Comunidade Saude');
      // autorizacoes e contas (semeadas pelo dono: o papel da API nao escreve nelas)
      const auth = async (status: string, conta: string) =>
        (
          await harness.owner.query<{ id: string }>(
            `INSERT INTO payment_provider_authorizations (provider, environment, provider_account_id, status, access_token_encrypted,
                                                          refresh_token_encrypted, credentials_key_version, expires_at)
             VALUES ('MERCADO_PAGO', 'SANDBOX', $1, $2::payment_authorization_status,
                     CASE WHEN $2 = 'REVOKED' THEN NULL ELSE decode('01','hex') END,
                     CASE WHEN $2 = 'REVOKED' THEN NULL ELSE decode('02','hex') END,
                     CASE WHEN $2 = 'REVOKED' THEN NULL ELSE 1 END, now() + interval '30 days') RETURNING id`,
            [unique(conta), status],
          )
        ).rows[0]!.id;
      const a1 = await auth('ERROR', 'er-');
      const a2 = await auth('REVOKED', 'rv-');
      const a3 = await auth('ACTIVE', 'ok-');
      const conta = (authId: string, status: string) =>
        harness.owner.query(
          `INSERT INTO tenant_payment_accounts (tenant_id, authorization_id, provider, environment, status)
           VALUES ($1, $2, 'MERCADO_PAGO', 'SANDBOX', $3::payment_account_status)`,
          [t, authId, status],
        );
      await conta(a1, 'ERROR');
      await conta(a2, 'REVOKED');
      await conta(a3, 'DISCONNECTING');

      // evento da Stripe com falha + evento morto
      for (const [status, n] of [['FAILED', 1], ['DEAD', 1]] as const) {
        await harness.owner.query(
          `INSERT INTO stripe_webhook_events (event_id, event_type, livemode, stripe_created_at, status, attempts, last_error)
           VALUES ($1, 'customer.subscription.updated', false, now(), $2::stripe_event_status, $3, 'falha de teste')`,
          [unique('evt_').replace(/[^a-zA-Z0-9_]/g, ''), status, n],
        );
      }

      const res = await como(financeCookie).get('/api/platform/health');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.stripeEvents).toMatchObject({ failed: 1, dead: 1 });
      expect(res.body.stripeEvents.oldestProblemAt).toBeTruthy();
      expect(res.body.paymentAccounts).toMatchObject({ authorizationsError: 1, authorizationsRevoked: 1, accountsDisconnecting: 1 });
      expect(JSON.stringify(res.body)).not.toMatch(/token|secret|encrypted/i);
    });

    it('divergencias PAYMENT_AUTHORIZATION_UNAVAILABLE aparecem com comunidade e referencia curta', async () => {
      const t = await seedTenantWithSlug(harness.owner, unique('dv-'), 'Comunidade Divergente');
      const { rows: d } = await harness.owner.query<{ id: string }>(
        `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers, status)
         VALUES ($1, $2, 'S', 'P', 1000, 100, 'ATIVA') RETURNING id`,
        [t, unique('d-')],
      );
      const { rows: b } = await harness.owner.query<{ id: string }>(`INSERT INTO buyers (tenant_id, name, phone) VALUES ($1,'M','+5511912345678') RETURNING id`, [t]);
      const { rows: o } = await harness.owner.query<{ id: string }>(
        `INSERT INTO orders (tenant_id, draw_id, buyer_id, status, unit_price_cents, quantity, total_cents, accepted_terms_at)
         VALUES ($1,$2,$3,'PENDENTE',1000,1,1000,now()) RETURNING id`,
        [t, d[0]!.id, b[0]!.id],
      );
      const { rows: p } = await harness.owner.query<{ id: string }>(
        `INSERT INTO payments (tenant_id, order_id, provider, provider_payment_id, status, idempotency_key, amount_cents, expires_at)
         VALUES ($1,$2::uuid,'FAKE','900000001','PENDENTE',$2::text,1000, now() + interval '5 minutes') RETURNING id`,
        [t, o[0]!.id],
      );
      await harness.owner.query(
        `INSERT INTO payment_reconciliation_issues (tenant_id, payment_id, order_id, kind, detail)
         VALUES ($1, $2, $3, 'PAYMENT_AUTHORIZATION_UNAVAILABLE', '{}'::jsonb)`,
        [t, p[0]!.id, o[0]!.id],
      );

      const res = await como(financeCookie).get('/api/platform/health');
      const issues = res.body.paymentAccounts.unavailableIssues;
      expect(issues.count).toBeGreaterThanOrEqual(1);
      const meu = issues.items.find((i: { tenantName: string }) => i.tenantName === 'Comunidade Divergente');
      expect(meu).toMatchObject({ reference: o[0]!.id.slice(0, 8) });
      expect(meu.detectedAt).toBeTruthy();
      // a resposta nao inclui o ID completo do pagamento nem do pedido
      expect(JSON.stringify(res.body)).not.toContain(o[0]!.id);
      expect(JSON.stringify(res.body)).not.toContain(p[0]!.id);
    });

    it('quem nao e da plataforma nao le a saude; o papel da API nao executa a funcao fora do contexto de plataforma', async () => {
      expect((await como(ownerCookie).get('/api/platform/health')).status).toBe(403);
      const { rows } = await harness.pool.query('SELECT app.platform_payment_health(5) AS r');
      expect(rows[0].r).toBeNull();
    });
  });
});
