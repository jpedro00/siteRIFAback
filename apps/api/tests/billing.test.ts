import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Stripe from 'stripe';
import { StripeBillingGateway, processDueStripeEvents, processStripeEvent } from '@clubedarifa/billing';
import { FakeStripeClient } from '@clubedarifa/billing/testing';
import { createPool, type DbPool } from '@clubedarifa/db';
import {
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
 * Fase 7 · Etapa 2 · Stripe Billing (FLUXO A: assinatura da PLATAFORMA).
 *
 * A API roda com o gateway REAL da Stripe sobre um cliente EM MEMORIA (sem rede) e com a
 * verificacao de assinatura do SDK de verdade. O worker e simulado com a conexao real
 * `app_worker`. Nenhuma chave live, nenhuma cobranca real, nenhum Mercado Pago.
 */
const WEBHOOK_SECRET = 'whsec_local_test_secret';

describe.skipIf(!hasTestDatabase)(`Stripe Billing · assinaturas da plataforma ${hasTestDatabase ? '' : skipReason}`, () => {
  let harness: Harness;
  let workerPool: DbPool;
  let fake: FakeStripeClient;
  let gateway: StripeBillingGateway;
  let pendentes: Promise<unknown>[];

  // Dados de cada teste
  let plan: { id: string; priceId: string };
  let slug: string;
  let tenantId: string;
  let owner: SeededAccount;
  let ownerCookie: string;

  async function entrar(account: SeededAccount, comMfa = true): Promise<string> {
    const secret = comMfa ? await seedConfirmedTotp(harness.owner, account.userId) : null;
    const login = await loginAs(harness, account);
    return secret ? (await verifyMfa(harness, login.cookie, await currentCode(secret))).cookie : login.cookie;
  }

  const como = (cookie: string, slugDaComunidade = slug) => ({
    get: (url: string) => request(harness.app).get(url).set('Cookie', cookie).set('x-tenant-slug', slugDaComunidade),
    post: (url: string, body?: object) =>
      request(harness.app).post(url).set('Cookie', cookie).set('x-tenant-slug', slugDaComunidade).send(body),
  });
  const dono = () => como(ownerCookie);

  async function novoPlano(extra: { maxDraws?: number | null; status?: string } = {}) {
    const priceId = unique('price_');
    const { rows } = await harness.owner.query<{ id: string }>(
      `INSERT INTO plans (code, name, billing_interval, price_cents, stripe_product_id, stripe_price_id, max_active_draws, status)
       VALUES ($1, 'Plano de teste', 'month', 1000, $2, $3, $4, $5::plan_status) RETURNING id`,
      [unique('plano-').toLowerCase().replace(/[^a-z0-9-]/g, '-'), unique('prod_'), priceId, extra.maxDraws ?? null, extra.status ?? 'AVAILABLE'],
    );
    return { id: rows[0]!.id, priceId };
  }

  /** Comunidade nova com dono (MFA ok). */
  async function novaComunidade(nome = 'Comunidade de Assinatura') {
    const s = unique('bill-');
    const t = await seedTenantWithSlug(harness.owner, s, nome);
    const conta = await seedAccount(harness.owner);
    await grantMembership(harness.owner, { tenantId: t, userId: conta.userId, role: 'OWNER' });
    return { slug: s, tenantId: t, account: conta, cookie: await entrar(conta) };
  }

  const id = (prefix: string) => `${prefix}_${unique('t')}`.replace(/[^a-zA-Z0-9_]/g, '');

  async function webhook(
    evento: { id?: string; type: string; object: Record<string, unknown>; livemode?: boolean },
    opts: { secret?: string; tamper?: boolean; semAssinatura?: boolean } = {},
  ) {
    const signed = fake.signedWebhook({ id: evento.id ?? id('evt'), ...evento }, opts.secret ?? WEBHOOK_SECRET);
    const corpo = opts.tamper ? Buffer.from(signed.rawBody.toString().replace('"type"', '"type" ')) : signed.rawBody;
    let req = request(harness.app).post('/api/webhooks/stripe').set('Content-Type', 'application/json');
    if (!opts.semAssinatura) req = req.set('Stripe-Signature', signed.signature);
    // Texto, nao Buffer: o superagent serializaria um Buffer como JSON e mudaria os bytes assinados.
    return { res: await req.send(corpo.toString('utf8')), eventId: JSON.parse(signed.rawBody.toString()).id as string };
  }
  const assentar = async () => {
    await Promise.all(pendentes.splice(0));
  };

  const eventoAssinatura = (subId: string, customer: string, status: string) => ({
    type: 'customer.subscription.updated',
    object: { id: subId, object: 'subscription', customer, status },
  });
  const eventoFatura = (invId: string, customer: string, subId: string | null, status: string, type = 'invoice.paid') => ({
    type,
    object: {
      id: invId,
      object: 'invoice',
      customer,
      status,
      parent: subId ? { subscription_details: { subscription: subId } } : null,
    },
  });

  const eventoDe = async (eventId: string) =>
    (
      await harness.owner.query<{ status: string; tenant_id: string | null; last_error: string | null; attempts: number }>(
        'SELECT status, tenant_id, last_error, attempts FROM stripe_webhook_events WHERE event_id = $1',
        [eventId],
      )
    ).rows[0]!;
  const assinaturas = async (t = tenantId) =>
    (
      await harness.owner.query<{ status: string; stripe_subscription_id: string; past_due_since: Date | null; current_period_end: Date | null }>(
        'SELECT status, stripe_subscription_id, past_due_since, current_period_end FROM tenant_subscriptions WHERE tenant_id = $1',
        [t],
      )
    ).rows;
  const clienteDe = async (t = tenantId) =>
    (await harness.owner.query<{ stripe_customer_id: string }>('SELECT stripe_customer_id FROM tenant_billing WHERE tenant_id = $1', [t])).rows[0]
      ?.stripe_customer_id;

  /** Faz o Checkout e devolve o cliente Stripe criado para a comunidade. */
  async function contratar(c = dono(), planId = plan.id) {
    const res = await c.post('/api/tenant/billing/checkout', { planId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res;
  }

  beforeAll(async () => {
    fake = new FakeStripeClient();
    gateway = new StripeBillingGateway({
      secretKey: 'sk_test_local',
      webhookSecret: WEBHOOK_SECRET,
      client: fake as unknown as Stripe,
    });
    pendentes = [];
    harness = await createHarness({
      billing: {
        gateway,
        // Processamento imediato "depois da resposta": guardamos a promessa para o teste esperar.
        schedule: (eventId) => {
          pendentes.push(processStripeEvent({ pool: harness.pool, gateway }, eventId));
        },
      },
    });
    workerPool = createPool({ connectionString: process.env['TEST_WORKER_DATABASE_URL']!, applicationName: 'test-billing-worker', max: 3 });
    await cleanup(harness.owner);
  }, 180_000);

  afterAll(async () => {
    await workerPool?.end();
    await harness?.close();
  });

  beforeEach(async () => {
    fake.reset();
    pendentes = [];
    await cleanup(harness.owner);
    plan = await novoPlano();
    const c = await novaComunidade();
    slug = c.slug;
    tenantId = c.tenantId;
    owner = c.account;
    ownerCookie = c.cookie;
  });

  // ---------------------------------------------------------------------------
  describe('Checkout', () => {
    it('primeiro Checkout: so o planId sai do navegador; preco e cliente vem do servidor', async () => {
      const res = await como(ownerCookie).post('/api/tenant/billing/checkout', {
        planId: plan.id,
        // Tentativas de impor valor: sao ignoradas (o schema so conhece `planId`).
        priceId: 'price_do_atacante',
        priceCents: 1,
        amount: 1,
        unit_amount: 1,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);

      const sessoes = [...fake.state.sessions.values()];
      expect(sessoes).toHaveLength(1);
      const params = sessoes[0]!.params as { mode: string; line_items: { price: string; quantity: number }[]; customer: string; metadata: Record<string, string>; success_url: string };
      expect(params.mode).toBe('subscription');
      // O Price e o do PLANO gravado no banco; nao ha valor monetario em lugar nenhum.
      expect(params.line_items).toEqual([{ price: plan.priceId, quantity: 1 }]);
      expect(JSON.stringify(params)).not.toMatch(/unit_amount|price_data|price_do_atacante/);
      expect(params.metadata).toEqual({ tenantId, planId: plan.id });
      expect(params.success_url).toBe('https://organizer.test/assinatura?checkout=success');

      // Cliente criado e vinculado a ESTA comunidade; sessao aberta registrada; auditoria.
      expect(await clienteDe()).toBe(params.customer);
      const { rows } = await harness.owner.query('SELECT status FROM billing_checkout_sessions WHERE tenant_id = $1', [tenantId]);
      expect(rows).toEqual([{ status: 'OPEN' }]);
      const audit = await harness.owner.query(`SELECT 1 FROM audit_events WHERE tenant_id = $1 AND action = 'billing.checkout_created'`, [tenantId]);
      expect(audit.rowCount).toBe(1);
    });

    it('plano inexistente, em rascunho ou arquivado: 404 igual, sem chamar a Stripe', async () => {
      for (const planId of ['00000000-0000-4000-8000-000000000000', (await novoPlano({ status: 'DRAFT' })).id, (await novoPlano({ status: 'ARCHIVED' })).id]) {
        expect((await dono().post('/api/tenant/billing/checkout', { planId })).status).toBe(404);
      }
      expect((await dono().post('/api/tenant/billing/checkout', { planId: 'nao-e-uuid' })).status).toBe(400);
      expect(fake.callsTo('checkout.sessions.create')).toBe(0);
    });

    it('Checkout REPETIDO devolve o mesmo, sem abrir outro na Stripe', async () => {
      const a = await contratar();
      const b = await contratar();
      expect(b.body.url).toBe(a.body.url);
      expect(fake.callsTo('checkout.sessions.create')).toBe(1);
      expect(fake.callsTo('customers.create')).toBe(1);
    });

    it('trocar de plano com um Checkout aberto: fecha o anterior na Stripe e abre o novo', async () => {
      const a = await contratar();
      const outro = await novoPlano();
      const b = await contratar(dono(), outro.id);
      expect(b.body.url).not.toBe(a.body.url);
      expect(fake.callsTo('checkout.sessions.expire')).toBe(1);
      const { rows } = await harness.owner.query<{ status: string }>('SELECT status FROM billing_checkout_sessions WHERE tenant_id = $1 ORDER BY created_at', [tenantId]);
      expect(rows.map((r) => r.status)).toEqual(['EXPIRED', 'OPEN']);
    });

    it('Checkout CONCORRENTE: uma sessao, um cliente, a mesma URL para todos', async () => {
      const respostas = await Promise.all(Array.from({ length: 6 }, () => dono().post('/api/tenant/billing/checkout', { planId: plan.id })));
      expect(respostas.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
      expect(new Set(respostas.map((r) => r.body.url)).size).toBe(1);
      expect(fake.callsTo('checkout.sessions.create')).toBe(1);
      expect(fake.callsTo('customers.create')).toBe(1);
      expect(fake.state.customers.size).toBe(1);
    });

    it('cliente Stripe DUPLICADO nao nasce: falha depois de criar o cliente e nova tentativa reaproveitam o mesmo', async () => {
      // A criacao da sessao falha (Stripe 503): a transacao inteira desfaz, inclusive o vinculo local.
      fake.failNext('checkout.sessions.create', { type: 'StripeAPIError', statusCode: 503, message: 'indisponivel' });
      const falha = await dono().post('/api/tenant/billing/checkout', { planId: plan.id });
      expect(falha.status).toBe(503);
      expect(falha.body.error.code).toBe('BILLING_UNAVAILABLE');
      expect(await clienteDe()).toBeUndefined();
      expect(fake.state.customers.size).toBe(1); // ja existia na Stripe

      // Nova tentativa: `customers.create` e chamado de novo, mas a chave de idempotencia
      // devolve o MESMO cliente — continua um so.
      await contratar();
      expect(fake.callsTo('customers.create')).toBe(2);
      expect(fake.state.customers.size).toBe(1);
      expect(await clienteDe()).toBe([...fake.state.customers.keys()][0]);
    });

    it('comunidade que JA tem assinatura: 409, e quem gerencia e o portal', async () => {
      await contratar();
      const cliente = (await clienteDe())!;
      const subId = id('sub');
      fake.putSubscription({ id: subId, customer: cliente, priceId: plan.priceId, status: 'active' });
      await webhook(eventoAssinatura(subId, cliente, 'active'));
      await assentar();

      const res = await dono().post('/api/tenant/billing/checkout', { planId: plan.id });
      expect(res.status).toBe(409);
      expect(res.body.error.details).toEqual({ reason: 'ALREADY_SUBSCRIBED' });
      expect(fake.callsTo('checkout.sessions.create')).toBe(1);
    });

    it('erro da Stripe vira BILLING_UNAVAILABLE (503) sem vazar o detalhe', async () => {
      fake.failNext('customers.create', { type: 'StripeConnectionError', message: 'ECONNRESET com sk_test_segredo123' });
      const res = await dono().post('/api/tenant/billing/checkout', { planId: plan.id });
      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).not.toContain('sk_test_segredo123');
    });
  });

  // ---------------------------------------------------------------------------
  describe('retorno do Checkout nao libera nada', () => {
    it('sem webhook confirmado a comunidade continua sem assinatura, mesmo depois de "voltar"', async () => {
      await contratar();
      const cobranca = await dono().get('/api/tenant/billing');
      expect(cobranca.body.state).toBe('NO_SUBSCRIPTION');
      expect(cobranca.body.subscription).toBeNull();
      const e = await dono().get('/api/tenant/billing/entitlements');
      expect(e.body.planCode).toBeNull();
    });

    it('checkout.session.completed com assinatura ainda INCOMPLETA: PENDING, nada liberado', async () => {
      const r = await contratar();
      const cliente = (await clienteDe())!;
      const sessaoId = [...fake.state.sessions.keys()][0]!;
      const subId = id('sub');
      fake.putSubscription({ id: subId, customer: cliente, priceId: plan.priceId, status: 'incomplete' });
      const { eventId } = await webhook({ type: 'checkout.session.completed', object: { id: sessaoId, object: 'checkout.session', customer: cliente, subscription: subId, mode: 'subscription', payment_status: 'unpaid' } });
      await assentar();

      expect((await eventoDe(eventId)).status).toBe('PROCESSED');
      expect(r.status).toBe(200);
      const c = await dono().get('/api/tenant/billing');
      expect(c.body.state).toBe('PENDING');

      // A sessao concluiu, mas quem concede acesso e a ASSINATURA: so `active` libera.
      await harness.owner.query('UPDATE billing_settings SET enforcement_enabled = true');
      try {
        const bloqueado = await dono().get('/api/tenant/billing/entitlements');
        expect(bloqueado.body).toMatchObject({ state: 'PENDING', canSubmitDraws: false, reason: 'SUBSCRIPTION_PENDING' });

        fake.putSubscription({ id: subId, customer: cliente, priceId: plan.priceId, status: 'active' });
        await webhook(eventoAssinatura(subId, cliente, 'active'));
        await assentar();
        const liberado = await dono().get('/api/tenant/billing/entitlements');
        expect(liberado.body).toMatchObject({ state: 'ACTIVE', canSubmitDraws: true, planCode: expect.any(String) });
      } finally {
        await harness.owner.query('UPDATE billing_settings SET enforcement_enabled = false');
      }
    });

    it('a sessao vira COMPLETED so pelo webhook', async () => {
      await contratar();
      const cliente = (await clienteDe())!;
      const sessaoId = [...fake.state.sessions.keys()][0]!;
      const { rows: antes } = await harness.owner.query<{ status: string }>('SELECT status FROM billing_checkout_sessions WHERE tenant_id = $1', [tenantId]);
      expect(antes[0]!.status).toBe('OPEN');
      await webhook({ type: 'checkout.session.completed', object: { id: sessaoId, object: 'checkout.session', customer: cliente, subscription: null, mode: 'subscription', payment_status: 'paid' } });
      await assentar();
      const { rows: depois } = await harness.owner.query<{ status: string }>('SELECT status FROM billing_checkout_sessions WHERE tenant_id = $1', [tenantId]);
      expect(depois[0]!.status).toBe('COMPLETED');
    });
  });

  // ---------------------------------------------------------------------------
  describe('webhook · assinatura, duplicidade, ordem e isolamento', () => {
    async function ativa(): Promise<{ cliente: string; subId: string }> {
      await contratar();
      const cliente = (await clienteDe())!;
      const subId = id('sub');
      fake.putSubscription({ id: subId, customer: cliente, priceId: plan.priceId, status: 'active' });
      await webhook(eventoAssinatura(subId, cliente, 'active'));
      await assentar();
      return { cliente, subId };
    }

    it('assinatura INVALIDA: 400 e nada e gravado (segredo errado, corpo alterado, sem cabecalho, modo live)', async () => {
      const evento = eventoAssinatura('sub_x', 'cus_x', 'active');
      expect((await webhook(evento, { secret: 'whsec_de_outro' })).res.status).toBe(400);
      expect((await webhook(evento, { tamper: true })).res.status).toBe(400);
      expect((await webhook(evento, { semAssinatura: true })).res.status).toBe(400);
      // Evento de PRODUCAO chegando numa instalacao de teste nunca e aceito.
      expect((await webhook({ ...evento, livemode: true })).res.status).toBe(400);
      const { rows } = await harness.owner.query('SELECT 1 FROM stripe_webhook_events');
      expect(rows).toHaveLength(0);
    });

    it('evento valido e GRAVADO antes de responder 2xx; falha ao gravar NAO confirma', async () => {
      const ok = await webhook(eventoAssinatura('sub_x', 'cus_desconhecido', 'active'));
      expect(ok.res.status).toBe(200);
      expect((await eventoDe(ok.eventId)).status).toMatch(/RECEIVED|PROCESSING|IGNORED/);

      // Banco fora: a persistencia falha e a resposta NAO pode ser 2xx (a Stripe reenvia).
      const original = harness.pool.query.bind(harness.pool);
      const conectar = harness.pool.connect.bind(harness.pool);
      (harness.pool as unknown as { connect: () => Promise<never> }).connect = () => Promise.reject(new Error('banco indisponivel'));
      try {
        const falha = await webhook(eventoAssinatura('sub_y', 'cus_y', 'active'));
        expect(falha.res.status).toBeGreaterThanOrEqual(500);
      } finally {
        (harness.pool as unknown as { connect: unknown }).connect = conectar;
        void original;
      }
    });

    it('evento DUPLICADO: uma linha, uma assinatura, uma auditoria', async () => {
      await contratar();
      const cliente = (await clienteDe())!;
      const subId = id('sub');
      fake.putSubscription({ id: subId, customer: cliente, priceId: plan.priceId, status: 'active' });
      const evento = { id: id('evt'), ...eventoAssinatura(subId, cliente, 'active') };
      for (let i = 0; i < 3; i++) expect((await webhook(evento)).res.status).toBe(200);
      await assentar();

      expect((await harness.owner.query('SELECT 1 FROM stripe_webhook_events WHERE event_id = $1', [evento.id])).rowCount).toBe(1);
      expect(await assinaturas()).toHaveLength(1);
      const audit = await harness.owner.query(`SELECT 1 FROM audit_events WHERE tenant_id = $1 AND action = 'billing.subscription_synced'`, [tenantId]);
      expect(audit.rowCount).toBe(1);
      expect((await eventoDe(evento.id)).status).toBe('PROCESSED');
    });

    it('a MESMA assinatura por eventos DISTINTOS e simultaneos: continua uma so', async () => {
      await contratar();
      const cliente = (await clienteDe())!;
      const subId = id('sub');
      fake.putSubscription({ id: subId, customer: cliente, priceId: plan.priceId, status: 'active' });
      await Promise.all(Array.from({ length: 5 }, () => webhook(eventoAssinatura(subId, cliente, 'active'))));
      await assentar();
      expect(await assinaturas()).toHaveLength(1);
    });

    it('eventos FORA DE ORDEM: vale o estado ATUAL da Stripe, nao a ordem de chegada', async () => {
      await contratar();
      const cliente = (await clienteDe())!;
      const subId = id('sub');
      // O estado final na Stripe e "canceled"; os eventos chegam na ordem inversa.
      fake.putSubscription({ id: subId, customer: cliente, priceId: plan.priceId, status: 'canceled', canceledAt: Math.floor(Date.now() / 1000) });
      await webhook(eventoAssinatura(subId, cliente, 'active')); // evento ANTIGO, chega por ultimo em tese
      await webhook({ type: 'customer.subscription.deleted', object: { id: subId, object: 'subscription', customer: cliente, status: 'canceled' } });
      await webhook(eventoAssinatura(subId, cliente, 'incomplete'));
      await assentar();
      expect((await assinaturas())[0]!.status).toBe('canceled');
    });

    it('processamento ATRASADO com um estado antigo NAO sobrescreve o mais novo (lock por objeto)', async () => {
      await contratar();
      const cliente = (await clienteDe())!;
      const subId = id('sub');
      fake.putSubscription({ id: subId, customer: cliente, priceId: plan.priceId, status: 'incomplete' });
      // A resposta da Stripe chega LENTA e "velha" (incomplete) ...
      fake.afterReadDelays.set('subscriptions.retrieve', 500);
      const lento = await webhook(eventoAssinatura(subId, cliente, 'incomplete'));
      await new Promise((r) => setTimeout(r, 120));
      // ... enquanto a Stripe ja mudou para active e o segundo evento e processado.
      fake.putSubscription({ id: subId, customer: cliente, priceId: plan.priceId, status: 'active' });
      fake.afterReadDelays.delete('subscriptions.retrieve');
      const rapido = await webhook(eventoAssinatura(subId, cliente, 'active'));
      await assentar();

      expect((await eventoDe(lento.eventId)).status).toBe('PROCESSED');
      expect((await eventoDe(rapido.eventId)).status).toBe('PROCESSED');
      // O segundo esperou o lock do primeiro e consultou DEPOIS: o estado final e o novo.
      expect((await assinaturas())[0]!.status).toBe('active');
    });

    it('comunidade INEXISTENTE (cliente desconhecido): gravado, IGNORADO, nenhuma escrita de negocio', async () => {
      const { res, eventId } = await webhook(eventoAssinatura(id('sub'), 'cus_de_ninguem', 'active'));
      expect(res.status).toBe(200);
      await assentar();
      const e = await eventoDe(eventId);
      expect(e.status).toBe('IGNORED');
      expect(e.tenant_id).toBeNull();
      expect((await harness.owner.query('SELECT 1 FROM tenant_subscriptions')).rowCount).toBe(0);
      expect(fake.callsTo('subscriptions.retrieve')).toBe(0);
    });

    it('tipo de evento que nao tratamos: IGNORADO, sem consultar a Stripe', async () => {
      const { eventId } = await webhook({ type: 'customer.updated', object: { id: 'cus_x', object: 'customer' } });
      await assentar();
      expect((await eventoDe(eventId)).status).toBe('IGNORED');
    });

    it('uma comunidade NAO recebe a assinatura nem as faturas de outra', async () => {
      const { cliente, subId } = await ativa();
      const invId = id('in');
      fake.putInvoice({ id: invId, customer: cliente, subscriptionId: subId, status: 'paid' });
      await webhook(eventoFatura(invId, cliente, subId, 'paid'));
      await assentar();

      const b = await novaComunidade('Outra comunidade');
      const vistaPorB = await como(b.cookie, b.slug).get('/api/tenant/billing');
      expect(vistaPorB.status).toBe(200);
      expect(vistaPorB.body.state).toBe('NO_SUBSCRIPTION');
      expect(vistaPorB.body.subscription).toBeNull();
      expect(vistaPorB.body.invoices).toEqual([]);

      const vistaPorA = await dono().get('/api/tenant/billing');
      expect(vistaPorA.body.state).toBe('ACTIVE');
      expect(vistaPorA.body.invoices).toHaveLength(1);
      expect(vistaPorA.body.invoices[0].status).toBe('paid');

      // O dono de A nao entra na comunidade de B com a propria sessao.
      const cruzado = await como(ownerCookie, b.slug).get('/api/tenant/billing');
      expect(cruzado.status).toBe(404);
    });

    it('checkout.session.completed de uma sessao da comunidade A com cliente da B: DEAD, nada gravado', async () => {
      await contratar();
      const clienteA = (await clienteDe())!;
      const sessaoA = [...fake.state.sessions.keys()][0]!;
      const b = await novaComunidade('Comunidade B');
      const resB = await como(b.cookie, b.slug).post('/api/tenant/billing/checkout', { planId: plan.id });
      expect(resB.status).toBe(200);
      const clienteB = (await clienteDe(b.tenantId))!;
      expect(clienteB).not.toBe(clienteA);

      const subId = id('sub');
      fake.putSubscription({ id: subId, customer: clienteB, priceId: plan.priceId, status: 'active' });
      const { eventId } = await webhook({ type: 'checkout.session.completed', object: { id: sessaoA, object: 'checkout.session', customer: clienteB, subscription: subId, mode: 'subscription', payment_status: 'paid' } });
      await assentar();
      expect((await eventoDe(eventId)).status).toBe('DEAD');
      expect(await assinaturas()).toHaveLength(0);
      expect(await assinaturas(b.tenantId)).toHaveLength(0);
    });

    it('a assinatura consultada pertence a OUTRO cliente Stripe: DEAD, sem retry e sem escrita', async () => {
      await contratar();
      const cliente = (await clienteDe())!;
      const subId = id('sub');
      fake.putSubscription({ id: subId, customer: 'cus_de_outra_conta', priceId: plan.priceId, status: 'active' });
      const { eventId } = await webhook(eventoAssinatura(subId, cliente, 'active'));
      await assentar();
      const e = await eventoDe(eventId);
      expect(e.status).toBe('DEAD');
      expect(e.tenant_id).toBe(tenantId);
      expect(await assinaturas()).toHaveLength(0);
    });

    it('preco desconhecido (plano ainda nao sincronizado): FAILED com recuo; some o problema e o retry conclui', async () => {
      await contratar();
      const cliente = (await clienteDe())!;
      const subId = id('sub');
      fake.putSubscription({ id: subId, customer: cliente, priceId: 'price_ainda_nao_cadastrado', status: 'active' });
      const { eventId } = await webhook(eventoAssinatura(subId, cliente, 'active'));
      await assentar();
      expect((await eventoDe(eventId)).status).toBe('FAILED');
      expect(await assinaturas()).toHaveLength(0);

      await harness.owner.query(
        `INSERT INTO plans (code, name, billing_interval, price_cents, stripe_product_id, stripe_price_id, status)
         VALUES ($1, 'Novo', 'month', 1000, $2, 'price_ainda_nao_cadastrado', 'AVAILABLE')`,
        [unique('novo-').toLowerCase().replace(/[^a-z0-9-]/g, '-'), unique('prod_')],
      );
      await harness.owner.query(`UPDATE stripe_webhook_events SET next_attempt_at = now() WHERE event_id = $1`, [eventId]);
      const totais = await processDueStripeEvents({ pool: workerPool, gateway });
      expect(totais.PROCESSED).toBe(1);
      expect((await assinaturas())[0]!.status).toBe('active');
    });
  });

  // ---------------------------------------------------------------------------
  describe('faturas e ciclo de renovacao', () => {
    async function ativa() {
      await contratar();
      const cliente = (await clienteDe())!;
      const subId = id('sub');
      fake.putSubscription({ id: subId, customer: cliente, priceId: plan.priceId, status: 'active' });
      await webhook(eventoAssinatura(subId, cliente, 'active'));
      await assentar();
      return { cliente, subId };
    }

    it('fatura recebida ANTES da assinatura: fica solta e passa a apontar para ela quando ela chega', async () => {
      await contratar();
      const cliente = (await clienteDe())!;
      const subId = id('sub');
      const invId = id('in');
      fake.putInvoice({ id: invId, customer: cliente, subscriptionId: subId, status: 'paid' });
      // A assinatura ainda "nao existe" na Stripe para este processamento (404 transitorio).
      const evInv = await webhook(eventoFatura(invId, cliente, subId, 'paid'));
      await assentar();
      expect((await eventoDe(evInv.eventId)).status).toBe('FAILED'); // a fatura foi gravada; a assinatura nao pode ser consultada ainda
      let fat = await harness.owner.query<{ subscription_id: string | null; stripe_subscription_ref: string }>('SELECT subscription_id, stripe_subscription_ref FROM billing_invoices WHERE stripe_invoice_id = $1', [invId]);
      expect(fat.rows[0]!.subscription_id).toBeNull();
      expect(fat.rows[0]!.stripe_subscription_ref).toBe(subId);

      // A assinatura aparece: o evento dela liga a fatura.
      fake.putSubscription({ id: subId, customer: cliente, priceId: plan.priceId, status: 'active' });
      await webhook(eventoAssinatura(subId, cliente, 'active'));
      await assentar();
      fat = await harness.owner.query('SELECT subscription_id FROM billing_invoices WHERE stripe_invoice_id = $1', [invId]);
      expect(fat.rows[0]!.subscription_id).not.toBeNull();
    });

    it('invoice.paid NAO libera nada sozinho: vale o estado da assinatura sincronizada', async () => {
      await contratar();
      const cliente = (await clienteDe())!;
      const subId = id('sub');
      const invId = id('in');
      // A fatura esta paga, mas a assinatura na Stripe esta INCOMPLETA.
      fake.putSubscription({ id: subId, customer: cliente, priceId: plan.priceId, status: 'incomplete' });
      fake.putInvoice({ id: invId, customer: cliente, subscriptionId: subId, status: 'paid' });
      await webhook(eventoFatura(invId, cliente, subId, 'paid'));
      await assentar();
      expect((await dono().get('/api/tenant/billing')).body.state).toBe('PENDING');
    });

    it('renovacao APROVADA: periodo avanca, fatura paga, sai do atraso', async () => {
      const { cliente, subId } = await ativa();
      const antes = (await assinaturas())[0]!.current_period_end!;
      const proximo = Math.floor(Date.now() / 1000) + 61 * 86400;
      fake.putSubscription({ id: subId, customer: cliente, priceId: plan.priceId, status: 'active', periodEnd: proximo });
      const invId = id('in');
      fake.putInvoice({ id: invId, customer: cliente, subscriptionId: subId, status: 'paid' });
      await webhook(eventoFatura(invId, cliente, subId, 'paid'));
      await assentar();

      const depois = (await assinaturas())[0]!;
      expect(new Date(depois.current_period_end!).getTime()).toBeGreaterThan(new Date(antes).getTime());
      expect(depois.status).toBe('active');
      const c = await dono().get('/api/tenant/billing');
      expect(c.body.invoices[0]).toMatchObject({ status: 'paid', amountPaidCents: 1000 });
    });

    it('renovacao RECUSADA: past_due com a tolerancia contada UMA vez, mesmo com o webhook repetido', async () => {
      const { cliente, subId } = await ativa();
      fake.putSubscription({ id: subId, customer: cliente, priceId: plan.priceId, status: 'past_due' });
      const invId = id('in');
      fake.putInvoice({ id: invId, customer: cliente, subscriptionId: subId, status: 'open', attemptCount: 1 });
      const falhou = { id: id('evt'), ...eventoFatura(invId, cliente, subId, 'open', 'invoice.payment_failed') };
      await webhook(falhou);
      await assentar();
      const primeira = (await assinaturas())[0]!;
      expect(primeira.status).toBe('past_due');
      expect(primeira.past_due_since).not.toBeNull();

      // Mesmo evento reenviado e OUTRO evento de falha (nova tentativa): a referencia nao anda.
      await new Promise((r) => setTimeout(r, 30));
      await webhook(falhou);
      await webhook({ ...eventoFatura(invId, cliente, subId, 'open', 'invoice.payment_failed') });
      await assentar();
      expect(new Date((await assinaturas())[0]!.past_due_since!).getTime()).toBe(new Date(primeira.past_due_since!).getTime());

      const dentro = await dono().get('/api/tenant/billing/entitlements');
      expect(dentro.body.state).toBe('PAST_DUE_GRACE');
      expect(dentro.body.graceEndsAt).not.toBeNull();

      // Passados 4 dias de atraso: fora da tolerancia. Com a cobranca ligada, bloqueia o ENVIO.
      await harness.owner.query(`UPDATE tenant_subscriptions SET past_due_since = now() - interval '4 days' WHERE tenant_id = $1`, [tenantId]);
      await harness.owner.query('UPDATE billing_settings SET enforcement_enabled = true');
      try {
        const fora = await dono().get('/api/tenant/billing/entitlements');
        expect(fora.body).toMatchObject({ state: 'PAST_DUE_BLOCKED', canSubmitDraws: false, reason: 'SUBSCRIPTION_PAST_DUE_BLOCKED' });
        // O historico segue acessivel.
        expect((await dono().get('/api/tenant/billing')).status).toBe(200);
      } finally {
        await harness.owner.query('UPDATE billing_settings SET enforcement_enabled = false');
      }

      // Pagou: volta ao normal e a referencia some.
      fake.putSubscription({ id: subId, customer: cliente, priceId: plan.priceId, status: 'active' });
      await webhook(eventoAssinatura(subId, cliente, 'active'));
      await assentar();
      expect((await assinaturas())[0]!.past_due_since).toBeNull();
      expect((await dono().get('/api/tenant/billing')).body.state).toBe('ACTIVE');
    });

    it('CANCELAMENTO: estado cancelado, dados historicos preservados', async () => {
      const { cliente, subId } = await ativa();
      const { rows: d } = await harness.owner.query<{ id: string }>(
        `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers) VALUES ($1,$2,'T','P',1000,100) RETURNING id`,
        [tenantId, unique('d-')],
      );
      fake.putSubscription({ id: subId, customer: cliente, priceId: plan.priceId, status: 'canceled', canceledAt: Math.floor(Date.now() / 1000) });
      await webhook({ type: 'customer.subscription.deleted', object: { id: subId, object: 'subscription', customer: cliente, status: 'canceled' } });
      await assentar();

      const c = await dono().get('/api/tenant/billing');
      expect(c.body.state).toBe('CANCELED');
      expect(c.body.subscription.status).toBe('canceled');
      // Nada foi apagado.
      expect((await harness.owner.query('SELECT 1 FROM draws WHERE id = $1', [d[0]!.id])).rowCount).toBe(1);
      expect((await harness.owner.query('SELECT 1 FROM tenant_subscriptions WHERE tenant_id = $1', [tenantId])).rowCount).toBe(1);
    });

    it('troca de plano no portal volta por evento: o plano local acompanha', async () => {
      const { cliente, subId } = await ativa();
      const outro = await novoPlano({ maxDraws: 7 });
      fake.putSubscription({ id: subId, customer: cliente, priceId: outro.priceId, status: 'active' });
      await webhook(eventoAssinatura(subId, cliente, 'active'));
      await assentar();
      expect((await assinaturas())[0]!.status).toBe('active');
      const e = await dono().get('/api/tenant/billing/entitlements');
      expect(e.body.activeDraws.max).toBe(7);
    });
  });

  // ---------------------------------------------------------------------------
  describe('falhas temporarias e recuperacao', () => {
    it('Stripe fora ao processar: FAILED com recuo; o worker retoma quando o recuo vence', async () => {
      await contratar();
      const cliente = (await clienteDe())!;
      const subId = id('sub');
      fake.putSubscription({ id: subId, customer: cliente, priceId: plan.priceId, status: 'active' });
      fake.failNext('subscriptions.retrieve', { type: 'StripeAPIError', statusCode: 503, message: 'stripe fora' });
      const { eventId } = await webhook(eventoAssinatura(subId, cliente, 'active'));
      await assentar();

      let e = await eventoDe(eventId);
      expect(e.status).toBe('FAILED');
      expect(e.attempts).toBe(1);
      expect(await assinaturas()).toHaveLength(0);

      // Ainda no recuo: o worker nao mexe.
      expect((await processDueStripeEvents({ pool: workerPool, gateway })).PROCESSED).toBe(0);
      await harness.owner.query(`UPDATE stripe_webhook_events SET next_attempt_at = now() WHERE event_id = $1`, [eventId]);
      const totais = await processDueStripeEvents({ pool: workerPool, gateway });
      expect(totais.PROCESSED).toBe(1);
      e = await eventoDe(eventId);
      expect(e.status).toBe('PROCESSED');
      expect(e.attempts).toBe(2);
      expect((await assinaturas())[0]!.status).toBe('active');
    });

    it('processamento INTERROMPIDO (lease vencido) e recuperado pelo worker', async () => {
      await contratar();
      const cliente = (await clienteDe())!;
      const subId = id('sub');
      fake.putSubscription({ id: subId, customer: cliente, priceId: plan.priceId, status: 'active' });
      // O evento e gravado mas o processamento imediato nao roda (processo caiu).
      const ev = fake.signedWebhook({ id: id('evt'), ...eventoAssinatura(subId, cliente, 'active') }, WEBHOOK_SECRET);
      const envelope = gateway.verifyWebhook({ rawBody: ev.rawBody, signature: ev.signature });
      const { recordStripeEvent } = await import('@clubedarifa/billing');
      await recordStripeEvent(harness.pool, envelope);
      // Alguem PEGOU o evento e morreu sem concluir.
      await harness.owner.query(
        `UPDATE stripe_webhook_events SET status = 'PROCESSING', lease_token = gen_random_uuid(), lease_expires_at = now() + interval '60 seconds', attempts = 1 WHERE event_id = $1`,
        [envelope.id],
      );
      // Lease vigente: o worker respeita.
      expect((await processDueStripeEvents({ pool: workerPool, gateway })).PROCESSED).toBe(0);
      expect(await assinaturas()).toHaveLength(0);

      await harness.owner.query(`UPDATE stripe_webhook_events SET lease_expires_at = now() - interval '1 second' WHERE event_id = $1`, [envelope.id]);
      const totais = await processDueStripeEvents({ pool: workerPool, gateway });
      expect(totais.PROCESSED).toBe(1);
      expect((await eventoDe(envelope.id)).status).toBe('PROCESSED');
      expect((await assinaturas())[0]!.status).toBe('active');
    });

    it('CONCLUSAO INDEVIDA: sem o token do lease ninguem conclui o evento, nem pelo runtime da API', async () => {
      await contratar();
      const cliente = (await clienteDe())!;
      const { res, eventId } = await webhook(eventoAssinatura(id('sub'), cliente, 'active'));
      expect(res.status).toBe(200);
      // Segura o evento como "em processamento" (recem-pego, com lease vigente e token secreto).
      await Promise.all(pendentes.splice(0));
      await harness.owner.query(
        `UPDATE stripe_webhook_events SET status = 'PROCESSING', lease_token = gen_random_uuid(), lease_expires_at = now() + interval '5 minutes' WHERE event_id = $1`,
        [eventId],
      );
      // O runtime da API tenta concluir com token inventado e sem token.
      for (const token of [null, '11111111-1111-4111-8111-111111111111']) {
        const r = await harness.pool.query<{ ok: boolean }>(
          `SELECT app.finish_stripe_event($1, $2::uuid, 'PROCESSED', NULL, NULL) AS ok`,
          [eventId, token],
        );
        expect(r.rows[0]!.ok).toBe(false);
      }
      expect((await eventoDe(eventId)).status).toBe('PROCESSING');
      // Nem por SQL direto: as tabelas de cobranca nao aceitam escrita do runtime.
      await expect(harness.pool.query(`UPDATE stripe_webhook_events SET status = 'PROCESSED' WHERE event_id = $1`, [eventId])).rejects.toThrow(/permission denied/i);
    });
  });

  // ---------------------------------------------------------------------------
  describe('Customer Portal', () => {
    it('so com cliente da PROPRIA comunidade: sem assinatura previa, 409; com cliente, devolve a URL e audita', async () => {
      const semCliente = await dono().post('/api/tenant/billing/portal');
      expect(semCliente.status).toBe(409);
      expect(semCliente.body.error.details).toEqual({ reason: 'NO_CUSTOMER' });

      await contratar();
      const cliente = (await clienteDe())!;
      const res = await dono().post('/api/tenant/billing/portal');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.url).toBe(`https://billing.stripe.test/p/session/${cliente}`);
      const audit = await harness.owner.query(`SELECT 1 FROM audit_events WHERE tenant_id = $1 AND action = 'billing.portal_opened'`, [tenantId]);
      expect(audit.rowCount).toBe(1);
    });

    it('o portal da comunidade B abre o cliente da B, nunca o da A', async () => {
      await contratar();
      const clienteA = (await clienteDe())!;
      const b = await novaComunidade('B');
      await como(b.cookie, b.slug).post('/api/tenant/billing/checkout', { planId: plan.id });
      const clienteB = (await clienteDe(b.tenantId))!;
      const res = await como(b.cookie, b.slug).post('/api/tenant/billing/portal');
      expect(res.body.url).toContain(clienteB);
      expect(res.body.url).not.toContain(clienteA);
    });
  });

  // ---------------------------------------------------------------------------
  describe('permissoes', () => {
    it('so o dono contrata e gerencia; o financeiro le; os demais nao veem', async () => {
      const casos: [string, number, number][] = [
        ['OWNER', 200, 200],
        ['FINANCE', 200, 403],
        ['OPERATOR', 403, 403],
        ['MARKETING', 403, 403],
        ['SUPPORT', 403, 403],
      ];
      for (const [role, leitura, escrita] of casos) {
        const conta = role === 'OWNER' ? owner : await seedAccount(harness.owner);
        if (role !== 'OWNER') await grantMembership(harness.owner, { tenantId, userId: conta.userId, role });
        const c = como(role === 'OWNER' ? ownerCookie : await entrar(conta, true));
        expect((await c.get('/api/tenant/billing')).status, `${role} le`).toBe(leitura);
        expect((await c.get('/api/tenant/billing/plans')).status, `${role} planos`).toBe(leitura);
        expect((await c.get('/api/tenant/billing/entitlements')).status, `${role} limites`).toBe(leitura);
        expect((await c.post('/api/tenant/billing/checkout', { planId: plan.id })).status, `${role} contrata`).toBe(escrita);
        expect((await c.post('/api/tenant/billing/portal')).status, `${role} portal`).toBe(role === 'OWNER' ? 200 : 403); // o dono ja contratou acima: o cliente existe
      }
    });

    it('sem sessao: 401', async () => {
      expect((await request(harness.app).get('/api/tenant/billing').set('x-tenant-slug', slug)).status).toBe(401);
    });

    it('a lista de planos traz so os A VENDA', async () => {
      await novoPlano({ status: 'DRAFT' });
      await novoPlano({ status: 'ARCHIVED' });
      const res = await dono().get('/api/tenant/billing/plans');
      expect(res.status).toBe(200);
      expect(res.body.plans.every((p: { status: string }) => p.status === 'AVAILABLE')).toBe(true);
      expect(res.body.plans.map((p: { id: string }) => p.id)).toContain(plan.id);
      // Nenhum identificador da Stripe vaza para a comunidade.
      expect(JSON.stringify(res.body)).not.toMatch(/stripe|price_/);
    });
  });

  // ---------------------------------------------------------------------------
  describe('cobranca desabilitada', () => {
    let semCobranca: Harness;
    beforeAll(async () => {
      semCobranca = await createHarness();
    });
    afterAll(async () => {
      await semCobranca?.close();
    });

    it('a leitura local segue funcionando; contratar e portal respondem BILLING_UNAVAILABLE; o webhook nao existe', async () => {
      const c = await novaComunidade('Sem cobranca');
      const req = (m: 'get' | 'post', url: string, body?: object) =>
        request(semCobranca.app)[m](url).set('Cookie', c.cookie).set('x-tenant-slug', c.slug).send(body);

      const leitura = await req('get', '/api/tenant/billing');
      expect(leitura.status).toBe(200);
      expect(leitura.body).toMatchObject({ state: 'NO_SUBSCRIPTION', subscription: null, invoices: [] });
      expect((await req('get', '/api/tenant/billing/plans')).status).toBe(200);
      const e = await req('get', '/api/tenant/billing/entitlements');
      expect(e.body).toMatchObject({ enforcementEnabled: false, canSubmitDraws: true, reason: 'ENFORCEMENT_OFF' });

      for (const [url, body] of [['/api/tenant/billing/checkout', { planId: plan.id }], ['/api/tenant/billing/portal', undefined]] as const) {
        const r = await req('post', url, body as object | undefined);
        expect(r.status, url).toBe(503);
        expect(r.body.error.code).toBe('BILLING_UNAVAILABLE');
      }
      const wh = await request(semCobranca.app).post('/api/webhooks/stripe').set('Content-Type', 'application/json').send('{}');
      expect(wh.status).toBe(404);
    });
  });

  it('a cobranca segue DESLIGADA por padrao (enforcement) e nao mexe em criar/editar rascunho', async () => {
    const e = await dono().get('/api/tenant/billing/entitlements');
    expect(e.body.enforcementEnabled).toBe(false);
    expect(e.body.canSubmitDraws).toBe(true);
  });
});
