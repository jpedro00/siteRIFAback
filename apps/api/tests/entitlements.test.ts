import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createPool, type DbPool } from '@clubedarifa/db';
import { FakePsp } from '@clubedarifa/psp/testing';
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
import { requireFeature } from '../src/modules/billing/entitlementService.js';

/**
 * Fase 7 · Etapa 3 · entitlements: os limites e o estado da assinatura sao aplicados
 * pelo BACKEND, na transacao da propria operacao (gatilho do banco / aceite de convite).
 *
 * Tudo roda pelas rotas reais e pelas roles reais (`app_user`, `app_worker`); a
 * concorrencia usa requisicoes simultaneas de verdade e, onde precisa ser deterministica,
 * segura uma transacao aberta no banco (no arquivo `billing-foundation.test.ts`).
 */
describe.skipIf(!hasTestDatabase)(`Entitlements e limites dos planos ${hasTestDatabase ? '' : skipReason}`, () => {
  let harness: Harness;
  let psp: FakePsp;
  let worker: DbPool;

  interface Comunidade {
    slug: string;
    tenantId: string;
    dono: SeededAccount;
    cookie: string;
  }
  let c: Comunidade;

  async function entrar(conta: SeededAccount, comMfa = true): Promise<string> {
    const secret = comMfa ? await seedConfirmedTotp(harness.owner, conta.userId) : null;
    const login = await loginAs(harness, conta);
    return secret ? (await verifyMfa(harness, login.cookie, await currentCode(secret))).cookie : login.cookie;
  }

  async function novaComunidade(nome = 'Comunidade de Limites'): Promise<Comunidade> {
    const slug = unique('ent-');
    const tenantId = await seedTenantWithSlug(harness.owner, slug, nome);
    const dono = await seedAccount(harness.owner, { displayName: 'Dona' });
    await grantMembership(harness.owner, { tenantId, userId: dono.userId, role: 'OWNER' });
    return { slug, tenantId, dono, cookie: await entrar(dono) };
  }

  const como = (cookie: string, slug: string) => ({
    get: (url: string) => request(harness.app).get(url).set('Cookie', cookie).set('x-tenant-slug', slug),
    post: (url: string, body?: object) => request(harness.app).post(url).set('Cookie', cookie).set('x-tenant-slug', slug).send(body),
    patch: (url: string, body?: object) => request(harness.app).patch(url).set('Cookie', cookie).set('x-tenant-slug', slug).send(body),
    del: (url: string) => request(harness.app).delete(url).set('Cookie', cookie).set('x-tenant-slug', slug),
  });
  const dono = (com = c) => como(com.cookie, com.slug);

  const ligar = (ligado: boolean, grace = 3) =>
    harness.owner.query('UPDATE billing_settings SET enforcement_enabled = $1, past_due_grace_days = $2', [ligado, grace]);

  async function plano(extra: { maxDraws?: number | null; maxTeam?: number | null; features?: string[] } = {}) {
    const { rows } = await harness.owner.query<{ id: string }>(
      `INSERT INTO plans (code, name, billing_interval, price_cents, stripe_product_id, stripe_price_id, max_active_draws, max_team_members, features, status)
       VALUES ($1, 'Plano de teste', 'month', 1000, $2, $3, $4, $5, $6::text[], 'AVAILABLE') RETURNING id`,
      [unique('pl-').toLowerCase().replace(/[^a-z0-9-]/g, '-'), unique('prod_'), unique('price_'), extra.maxDraws ?? null, extra.maxTeam ?? null, extra.features ?? []],
    );
    return rows[0]!.id;
  }

  /** Coloca a comunidade em um estado de assinatura (semeadura pelo dono do schema). */
  async function assinar(com: Comunidade, status: string | null, opts: { planId?: string; atrasoHaDias?: number } = {}): Promise<string | null> {
    if (status === null) return null;
    const customer = unique('cus_').replace(/[^a-z0-9_]/gi, '');
    await harness.owner.query('INSERT INTO tenant_billing (tenant_id, stripe_customer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [com.tenantId, customer]);
    const { rows: cli } = await harness.owner.query<{ stripe_customer_id: string }>('SELECT stripe_customer_id FROM tenant_billing WHERE tenant_id = $1', [com.tenantId]);
    const planId = opts.planId ?? (await plano({ maxDraws: 50 }));
    await harness.owner.query(
      `INSERT INTO tenant_subscriptions (tenant_id, plan_id, stripe_customer_id, stripe_subscription_id, status, past_due_since, stripe_synced_at)
       VALUES ($1, $2, $3, $4, $5::subscription_status, $6, now())`,
      [com.tenantId, planId, cli[0]!.stripe_customer_id, unique('sub_').replace(/[^a-z0-9_]/gi, ''), status, status === 'past_due' ? new Date(Date.now() - (opts.atrasoHaDias ?? 1) * 86_400_000) : null],
    );
    return planId;
  }
  const trocarPlano = (com: Comunidade, planId: string) =>
    harness.owner.query(`UPDATE tenant_subscriptions SET plan_id = $2 WHERE tenant_id = $1`, [com.tenantId, planId]);

  async function rascunho(com = c): Promise<string> {
    const res = await dono(com).post('/api/tenant/draws', {
      title: `Sorteio ${unique('t-')}`,
      prizes: [{ name: 'Moto 0 km' }],
      ticketPriceCents: 1500,
      totalNumbers: 100,
      drawDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  }
  const enviar = (id: string, com = c) => dono(com).post(`/api/tenant/draws/${id}/status`, { status: 'REVISÃO COMPLIANCE' });
  const mudar = (id: string, status: string, com = c) => dono(com).post(`/api/tenant/draws/${id}/status`, { status });
  const statusDe = async (id: string) => (await harness.owner.query<{ status: string }>('SELECT status FROM draws WHERE id = $1', [id])).rows[0]!.status;
  /** Sorteio direto em um estado (semeadura do dono do schema). */
  async function sorteioEm(com: Comunidade, status: string): Promise<string> {
    const { rows } = await harness.owner.query<{ id: string }>(
      `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers) VALUES ($1,$2,'T','P',1500,100) RETURNING id`,
      [com.tenantId, unique('d-')],
    );
    if (status !== 'RASCUNHO') await harness.owner.query('UPDATE draws SET status = $2::draw_status WHERE id = $1', [rows[0]!.id, status]);
    return rows[0]!.id;
  }

  beforeAll(async () => {
    psp = new FakePsp();
    harness = await createHarness({ psp });
    worker = createPool({ connectionString: process.env['TEST_WORKER_DATABASE_URL']!, applicationName: 'test-entitlements-worker', max: 3 });
  }, 180_000);

  afterAll(async () => {
    await ligar(false);
    await worker?.end();
    await harness?.close();
  });

  beforeEach(async () => {
    await cleanup(harness.owner);
    await ligar(false);
    c = await novaComunidade();
  });

  // ---------------------------------------------------------------------------
  describe('politica de assinatura x envio de sorteio para revisao', () => {
    it('1. enforcement DESLIGADO (padrao): sem assinatura nenhuma, tudo segue como antes', async () => {
      const e = await dono().get('/api/tenant/billing/entitlements');
      expect(e.body).toMatchObject({ enforcementEnabled: false, canSubmitDraws: true, reason: 'ENFORCEMENT_OFF', state: 'NO_SUBSCRIPTION' });
      const id = await rascunho();
      expect((await enviar(id)).status).toBe(200);
      expect(await statusDe(id)).toBe('REVISÃO COMPLIANCE');
    });

    it('2/3/9. LIGADO e SEM assinatura: rascunho criado e editado, envio recusado com o motivo certo', async () => {
      await ligar(true);
      const id = await rascunho(); // criar rascunho nao consome nem exige assinatura
      expect((await dono().patch(`/api/tenant/draws/${id}`, { description: 'Regulamento novo' })).status).toBe(200); // editar tambem

      const res = await enviar(id);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('SUBSCRIPTION_REQUIRED');
      expect(res.body.error.details).toMatchObject({ reason: 'SUBSCRIPTION_NO_SUBSCRIPTION' });
      expect(res.body.error.message).toMatch(/ainda não tem uma assinatura/);
      // Nada da Stripe nem de dinheiro alheio na resposta.
      expect(JSON.stringify(res.body)).not.toMatch(/stripe|cus_|sub_|price_/i);
      expect(await statusDe(id)).toBe('RASCUNHO');
      // O que ja existe segue no ciclo: nada foi cancelado nem pausado.
      const s = await dono().get('/api/tenant/billing/entitlements');
      expect(s.body).toMatchObject({ enforcementEnabled: true, canSubmitDraws: false, reason: 'SUBSCRIPTION_NO_SUBSCRIPTION' });
    });

    const politica: [string, string, number, boolean, string?][] = [
      ['4. assinatura ACTIVE', 'active', 0, true],
      ['5. assinatura em TRIAL', 'trialing', 0, true],
      ['6. assinatura em TOLERANCIA (1 dia de atraso)', 'past_due', 1, true],
      ['7. assinatura APOS a tolerancia (4 dias)', 'past_due', 4, false, 'SUBSCRIPTION_PAST_DUE_BLOCKED'],
      ['pendente (incomplete)', 'incomplete', 0, false, 'SUBSCRIPTION_PENDING'],
      ['sem pagamento (unpaid)', 'unpaid', 0, false, 'SUBSCRIPTION_UNPAID'],
      ['pausada', 'paused', 0, false, 'SUBSCRIPTION_PAUSED'],
      ['8. assinatura CANCELADA', 'canceled', 0, false, 'SUBSCRIPTION_CANCELED'],
    ];
    for (const [nome, status, dias, liberado, motivo] of politica) {
      it(`${nome}`, async () => {
        await ligar(true);
        await assinar(c, status, { atrasoHaDias: dias });
        const id = await rascunho();
        const res = await enviar(id);
        if (liberado) {
          expect(res.status, JSON.stringify(res.body)).toBe(200);
          expect(await statusDe(id)).toBe('REVISÃO COMPLIANCE');
        } else {
          expect(res.status).toBe(403);
          expect(res.body.error).toMatchObject({ code: 'SUBSCRIPTION_REQUIRED', details: { reason: motivo } });
          expect(await statusDe(id)).toBe('RASCUNHO');
        }
      });
    }

    it('a tolerancia e a configurada pelo Super Admin (0 dias bloqueia no ato; 10 libera)', async () => {
      await assinar(c, 'past_due', { atrasoHaDias: 4 });
      await ligar(true, 3);
      const id = await rascunho();
      expect((await enviar(id)).status).toBe(403);
      await ligar(true, 10);
      expect((await enviar(id)).status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  describe('limites de sorteios ativos', () => {
    it('10. com vaga: entra; 11. no limite: recusa com used/max (409 PLAN_LIMIT_REACHED)', async () => {
      await ligar(true);
      await assinar(c, 'active', { planId: await plano({ maxDraws: 2 }) });
      const [a, b, x] = [await rascunho(), await rascunho(), await rascunho()];
      expect((await enviar(a)).status).toBe(200);
      expect((await enviar(b)).status).toBe(200);
      const res = await enviar(x);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'PLAN_LIMIT_REACHED', details: { reason: 'DRAW_LIMIT_REACHED', used: 2, max: 2 } });
      expect(await statusDe(x)).toBe('RASCUNHO');
      const e = await dono().get('/api/tenant/billing/entitlements');
      expect(e.body.activeDraws).toEqual({ used: 2, max: 2 });
    });

    it('12. dois envios SIMULTANEOS para a ultima vaga: um passa, o outro e recusado (5 de 5)', async () => {
      await ligar(true);
      await assinar(c, 'active', { planId: await plano({ maxDraws: 5 }) });
      for (let i = 0; i < 4; i++) await sorteioEm(c, 'ATIVA');
      const [d1, d2] = [await rascunho(), await rascunho()];
      const [r1, r2] = await Promise.all([enviar(d1), enviar(d2)]);
      expect([r1.status, r2.status].sort()).toEqual([200, 409]);
      const { rows } = await harness.owner.query<{ n: string }>(`SELECT count(*) AS n FROM draws WHERE tenant_id = $1 AND status IN ('REVISÃO COMPLIANCE','AGENDADA','ATIVA','PAUSADA')`, [c.tenantId]);
      expect(Number(rows[0]!.n)).toBe(5);
    });

    it('varios envios simultaneos para poucas vagas: nunca passa do limite', async () => {
      await ligar(true);
      await assinar(c, 'active', { planId: await plano({ maxDraws: 3 }) });
      const ids = await Promise.all(Array.from({ length: 8 }, () => rascunho()));
      const rs = await Promise.all(ids.map((id) => enviar(id)));
      expect(rs.filter((r) => r.status === 200)).toHaveLength(3);
      expect(rs.filter((r) => r.status === 409)).toHaveLength(5);
    });

    it('13. DOWNGRADE com consumo acima do limite: nada e cancelado/pausado; so o novo e barrado', async () => {
      await ligar(true);
      const grande = await plano({ maxDraws: 10 });
      await assinar(c, 'active', { planId: grande });
      const existentes = await Promise.all(Array.from({ length: 4 }, () => sorteioEm(c, 'ATIVA')));
      await trocarPlano(c, await plano({ maxDraws: 2 }));

      const novo = await rascunho();
      const res = await enviar(novo);
      expect(res.status).toBe(409);
      expect(res.body.error.details).toMatchObject({ reason: 'DRAW_LIMIT_REACHED', used: 4, max: 2 });
      for (const id of existentes) expect(await statusDe(id)).toBe('ATIVA');

      // Os existentes seguem o ciclo: pausar, retomar e encerrar nao passam pelo limite.
      expect((await mudar(existentes[0]!, 'PAUSADA')).status).toBe(200);
      expect((await mudar(existentes[0]!, 'ATIVA')).status).toBe(200);
      expect((await mudar(existentes[1]!, 'VENDAS ENCERRADAS')).status).toBe(200);
      expect((await mudar(existentes[2]!, 'VENDAS ENCERRADAS')).status).toBe(200);
      // Ainda 2 contando (limite 2): continua barrado ate a utilizacao ficar ABAIXO do limite.
      expect((await enviar(novo)).status).toBe(409);
      expect((await mudar(existentes[3]!, 'VENDAS ENCERRADAS')).status).toBe(200);
      expect((await enviar(novo)).status).toBe(200);
    });

    it('14. retomar um sorteio PAUSADO no limite nao consome vaga; e sem assinatura ativa tambem retoma', async () => {
      await ligar(true);
      await assinar(c, 'active', { planId: await plano({ maxDraws: 1 }) });
      const id = await sorteioEm(c, 'PAUSADA');
      expect((await mudar(id, 'ATIVA')).status).toBe(200);
      expect((await mudar(id, 'PAUSADA')).status).toBe(200);
      // Assinatura cancelada: o sorteio existente ainda pode ser retomado e encerrado.
      await harness.owner.query(`UPDATE tenant_subscriptions SET status = 'canceled' WHERE tenant_id = $1`, [c.tenantId]);
      expect((await mudar(id, 'ATIVA')).status).toBe(200);
      expect((await mudar(id, 'VENDAS ENCERRADAS')).status).toBe(200);
    });

    it('a comunidade nao consome nem enxerga a franquia da outra', async () => {
      await ligar(true);
      await assinar(c, 'active', { planId: await plano({ maxDraws: 1 }) });
      await sorteioEm(c, 'ATIVA');
      const outra = await novaComunidade('Outra');
      await assinar(outra, 'active', { planId: await plano({ maxDraws: null }) });
      for (let i = 0; i < 4; i++) await sorteioEm(outra, 'ATIVA');
      expect((await enviar(await rascunho(c), c)).status).toBe(409);
      expect((await enviar(await rascunho(outra), outra)).status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  describe('limite de equipe (aceite de convite)', () => {
    async function convidar(email: string, role = 'SUPPORT') {
      const res = await dono().post('/api/tenant/team/invitations', { email, role });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.token as string;
    }
    async function pessoa() {
      const conta = await seedAccount(harness.owner);
      return { conta, cookie: (await loginAs(harness, conta)).cookie };
    }
    const aceitar = (token: string, cookie: string) =>
      request(harness.app).post(`/api/auth/invitations/${token}/accept`).set('Cookie', cookie);
    // Membros ALEM do proprietario: e isso que `max_team_members` limita.
    const membros = async () =>
      Number((await harness.owner.query<{ n: number }>('SELECT app.team_member_count_unchecked($1) AS n', [c.tenantId])).rows[0]!.n);
    async function equipeDe(n: number) {
      for (let i = 0; i < n; i++) {
        const m = await seedAccount(harness.owner);
        await grantMembership(harness.owner, { tenantId: c.tenantId, userId: m.userId, role: 'SUPPORT' });
      }
    }

    it('15. aceite com vaga disponivel funciona e o convite pendente nao consumia vaga', async () => {
      await ligar(true);
      await assinar(c, 'active', { planId: await plano({ maxTeam: 3 }) });
      const p1 = await pessoa();
      const p2 = await pessoa();
      const t1 = await convidar(p1.conta.email);
      const t2 = await convidar(p2.conta.email);
      // Dois convites abertos, equipe de 1: nenhum ocupa vaga.
      expect((await dono().get('/api/tenant/billing/entitlements')).body.teamMembers).toEqual({ used: 0, max: 3 });
      expect((await aceitar(t1, p1.cookie)).status).toBe(200);
      expect((await aceitar(t2, p2.cookie)).status).toBe(200);
      expect(await membros()).toBe(2);
    });

    it('recusa no limite (409 PLAN_LIMIT_REACHED) sem criar vinculo, e o convite segue valido para depois', async () => {
      await ligar(true);
      await assinar(c, 'active', { planId: await plano({ maxTeam: 2 }) });
      await equipeDe(2);
      const p = await pessoa();
      const token = await convidar(p.conta.email);
      const res = await aceitar(token, p.cookie);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'PLAN_LIMIT_REACHED', details: { reason: 'MEMBER_LIMIT_REACHED', used: 2, max: 2 } });
      expect(await membros()).toBe(2);
      const previa = await request(harness.app).get(`/api/auth/invitations/${token}`);
      expect(previa.body.state).toBe('OPEN');
    });

    it('16. dois aceites SIMULTANEOS para a ultima vaga (4 de 5): um entra, o outro recebe o limite', async () => {
      await ligar(true);
      await assinar(c, 'active', { planId: await plano({ maxTeam: 5 }) });
      await equipeDe(4);
      const [a, b] = [await pessoa(), await pessoa()];
      const [ta, tb] = [await convidar(a.conta.email), await convidar(b.conta.email)];
      const [ra, rb] = await Promise.all([aceitar(ta, a.cookie), aceitar(tb, b.cookie)]);
      expect([ra.status, rb.status].sort()).toEqual([200, 409]);
      expect(await membros()).toBe(5);
    });

    it('17. remover um membro libera a vaga', async () => {
      await ligar(true);
      await assinar(c, 'active', { planId: await plano({ maxTeam: 2 }) });
      await equipeDe(2);
      const p = await pessoa();
      const token = await convidar(p.conta.email);
      expect((await aceitar(token, p.cookie)).status).toBe(409);

      const { rows } = await harness.owner.query<{ id: string }>(`SELECT m.id FROM memberships m WHERE m.tenant_id = $1 AND m.revoked_at IS NULL AND m.role <> 'OWNER'`, [c.tenantId]);
      expect((await dono().del(`/api/tenant/team/members/${rows[0]!.id}`)).status).toBe(204);
      expect((await aceitar(token, p.cookie)).status).toBe(200);
      expect(await membros()).toBe(2);
    });

    it('trocar o papel de um membro nao ocupa vaga; convite revogado, vencido e de outra comunidade seguem as respostas de sempre', async () => {
      await ligar(true);
      await assinar(c, 'active', { planId: await plano({ maxTeam: 2 }) });
      await equipeDe(2); // cheia
      const { rows } = await harness.owner.query<{ id: string }>(`SELECT m.id FROM memberships m WHERE m.tenant_id = $1 AND m.role = 'SUPPORT'`, [c.tenantId]);
      expect((await dono().patch(`/api/tenant/team/members/${rows[0]!.id}`, { role: 'FINANCE' })).status).toBe(200);
      expect(await membros()).toBe(2);

      const p = await pessoa();
      const revogado = await dono().post('/api/tenant/team/invitations', { email: p.conta.email, role: 'SUPPORT' });
      await dono().del(`/api/tenant/team/invitations/${revogado.body.id}`);
      expect((await aceitar(revogado.body.token, p.cookie)).status).toBe(409);
      expect((await aceitar(revogado.body.token, p.cookie)).body.error.code).toBe('CONFLICT');

      const vencido = await dono().post('/api/tenant/team/invitations', { email: p.conta.email, role: 'SUPPORT' });
      await harness.owner.query(`UPDATE invitations SET expires_at = now() - interval '1 day' WHERE id = $1`, [vencido.body.id]);
      const res = await aceitar(vencido.body.token, p.cookie);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT'); // vencido, nao "limite"

      // Convite da comunidade B aceito por quem nao e o destinatario: nao existe.
      const outra = await novaComunidade('Outra');
      const deOutra = await dono(outra).post('/api/tenant/team/invitations', { email: `${unique('x')}@example.com`, role: 'SUPPORT' });
      expect((await aceitar(deOutra.body.token, p.cookie)).status).toBe(404);
    });

    it('o dono nunca e barrado ao entrar: convite de dono para comunidade sem assinatura funciona com a cobranca ligada', async () => {
      await ligar(true);
      const slug = unique('novo-');
      const tenantId = await seedTenantWithSlug(harness.owner, slug, 'Sem membros');
      const futuroDono = await seedAccount(harness.owner);
      const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
      await harness.owner.query(
        `INSERT INTO invitations (tenant_id, email, role, token_hash) VALUES ($1, $2, 'OWNER', $3)`,
        [tenantId, futuroDono.email, (await import('node:crypto')).createHash('sha256').update(token).digest('hex')],
      );
      const cookie = (await loginAs(harness, futuroDono)).cookie;
      expect((await aceitar(token, cookie)).status).toBe(200);
    });

    it('o dono administra a assinatura mesmo com tudo bloqueado (leituras e portal nao passam pelos limites)', async () => {
      await ligar(true);
      await assinar(c, 'canceled');
      for (const url of ['/api/tenant/billing', '/api/tenant/billing/plans', '/api/tenant/billing/entitlements']) {
        expect((await dono().get(url)).status, url).toBe(200);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('permissao x direito comercial (duas condicoes independentes)', () => {
    it('18. sem a permissao de papel, o direito comercial nao ajuda; e ser dono nao ultrapassa o limite', async () => {
      await ligar(true);
      await assinar(c, 'active', { planId: await plano({ maxDraws: 1, features: ['recurso-x'] }) });
      // OPERATOR/SUPPORT/MARKETING nao veem a assinatura, mesmo com plano rico.
      for (const role of ['OPERATOR', 'SUPPORT', 'MARKETING']) {
        const conta = await seedAccount(harness.owner);
        await grantMembership(harness.owner, { tenantId: c.tenantId, userId: conta.userId, role });
        const cookie = await entrar(conta);
        expect((await como(cookie, c.slug).get('/api/tenant/billing/entitlements')).status, role).toBe(403);
        expect((await como(cookie, c.slug).post('/api/tenant/billing/checkout', { planId: randomUUID() })).status, role).toBe(403);
      }
      // O dono tem TODAS as permissoes de papel e, ainda assim, esbarra no limite do plano.
      await sorteioEm(c, 'ATIVA');
      const res = await enviar(await rascunho());
      expect(res.status).toBe(409);
    });

    it('funcionalidade do plano: exige o direito comercial da comunidade E respeita a assinatura', async () => {
      const comRecurso = await plano({ features: ['recurso-x'] });
      await assinar(c, 'active', { planId: comRecurso });
      const sem = await novaComunidade('Sem recurso');
      await assinar(sem, 'active', { planId: await plano() });
      const verifica = async (com: Comunidade) => {
        const client = await harness.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [com.tenantId, com.dono.userId]);
          await requireFeature(client, com.tenantId, 'recurso-x');
          await client.query('ROLLBACK');
          return 'liberado';
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          return (error as { code?: string }).code ?? 'erro';
        } finally {
          client.release();
        }
      };
      await ligar(false);
      expect(await verifica(sem)).toBe('liberado'); // desligado: nada barra
      await ligar(true);
      expect(await verifica(c)).toBe('liberado');
      expect(await verifica(sem)).toBe('FEATURE_NOT_IN_PLAN');
      await harness.owner.query(`UPDATE tenant_subscriptions SET status = 'canceled' WHERE tenant_id = $1`, [c.tenantId]);
      expect(await verifica(c)).toBe('SUBSCRIPTION_REQUIRED'); // plano rico, assinatura cancelada
    });

    it('19. uma comunidade nao consulta os limites da outra', async () => {
      await ligar(true);
      await assinar(c, 'active', { planId: await plano({ maxDraws: 7, maxTeam: 9 }) });
      const b = await novaComunidade('B');
      const eB = await dono(b).get('/api/tenant/billing/entitlements');
      expect(eB.body).toMatchObject({ state: 'NO_SUBSCRIPTION', planCode: null, canSubmitDraws: false });
      expect(eB.body.activeDraws.max).toBeNull();
      const eA = await dono().get('/api/tenant/billing/entitlements');
      expect(eA.body.activeDraws.max).toBe(7);
      // Sessao de A na comunidade de B: a comunidade "nao existe" para ela.
      expect((await como(c.cookie, b.slug).get('/api/tenant/billing/entitlements')).status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  describe('operacoes existentes preservadas durante inadimplencia e cancelamento', () => {
    async function ativoComVenda() {
      const drawId = await sorteioEm(c, 'ATIVA');
      return drawId;
    }
    const reservar = (drawId: string, numeros: number[]) =>
      request(harness.app).post(`/api/public/draws/${drawId}/reservations`).set('x-tenant-slug', c.slug).send({ numbers: numeros });
    const pedir = (reservationId: string) =>
      request(harness.app).post('/api/public/orders').set('x-tenant-slug', c.slug).send({
        reservationId,
        buyer: { name: 'Maria Souza', phone: '+55 11 91234-5678', email: 'maria@example.com' },
        acceptedTerms: true,
      });
    const avisar = (orderId: string) => {
      const w = psp.signedWebhook(psp.idDoPedido(orderId));
      return request(harness.app).post(`/api/webhooks/mercadopago/${c.slug}`).query(w.query).set(w.headers).send(w.body as object);
    };

    for (const [rotulo, status, dias] of [
      ['20. atraso FORA da tolerancia', 'past_due', 6],
      ['cancelada', 'canceled', 0],
      ['sem assinatura', null, 0],
    ] as [string, string | null, number][]) {
      it(`${rotulo}: reservar, pedir, pagar (PIX) e consultar continuam funcionando`, async () => {
        await ligar(true);
        await assinar(c, status, { atrasoHaDias: dias });
        const drawId = await ativoComVenda();

        const reserva = await reservar(drawId, [7, 8]);
        expect(reserva.status, JSON.stringify(reserva.body)).toBe(201);
        const pedido = await pedir(reserva.body.reservationId);
        expect(pedido.status, JSON.stringify(pedido.body)).toBe(201);
        const orderId = pedido.body.orderId as string;

        psp.approve(orderId);
        expect((await avisar(orderId)).status).toBe(200);
        const { rows } = await harness.owner.query<{ status: string }>('SELECT status::text AS status FROM orders WHERE id = $1', [orderId]);
        expect(rows[0]!.status).toBe('PAGO');

        // Historico e consultas da propria comunidade seguem abertos.
        const pedidos = await dono().get(`/api/tenant/draws/${drawId}/orders`);
        expect(pedidos.status).toBe(200);
        expect(pedidos.body.orders).toHaveLength(1);
        expect((await dono().get('/api/tenant/dashboard')).status).toBe(200);
        expect((await dono().get('/api/tenant/draws')).status).toBe(200);
        expect((await request(harness.app).get(`/api/public/orders/${orderId}`).set('x-tenant-slug', c.slug)).status).toBe(200);
      });
    }

    it('21. apuracao e resultado funcionam DEPOIS do cancelamento da assinatura (e a retificacao tambem)', async () => {
      await ligar(true);
      await assinar(c, 'canceled');
      const drawId = await ativoComVenda();
      // Vende os numeros 1..10 (pagos) — semeadura do dono.
      const { rows: b } = await harness.owner.query<{ id: string }>('INSERT INTO buyers (tenant_id, name, phone) VALUES ($1,$2,$3) RETURNING id', [c.tenantId, 'Maria Souza', '+55 11 91234-5678']);
      const { rows: o } = await harness.owner.query<{ id: string }>(
        `INSERT INTO orders (tenant_id, draw_id, buyer_id, status, unit_price_cents, quantity, total_cents, accepted_terms_at, paid_at)
         VALUES ($1,$2,$3,'PAGO',1500,10,15000,now(),now()) RETURNING id`, [c.tenantId, drawId, b[0]!.id]);
      const numeros = Array.from({ length: 10 }, (_, i) => i);
      await harness.owner.query('INSERT INTO order_items (tenant_id, order_id, number, unit_price_cents) SELECT $1,$2,n,1500 FROM unnest($3::int[]) n', [c.tenantId, o[0]!.id, numeros]);
      await harness.owner.query("INSERT INTO draw_numbers (tenant_id, draw_id, number, status, order_id) SELECT $1,$2,n,'PAGO',$3 FROM unnest($4::int[]) n", [c.tenantId, drawId, o[0]!.id, numeros]);

      expect((await mudar(drawId, 'VENDAS ENCERRADAS')).status).toBe(200);
      await worker.query('SELECT app.worker_create_draw_snapshot($1)', [drawId]);
      await worker.query("SELECT app.worker_transition_draw($1, 'APURAÇÃO', NULL)", [drawId]);

      const publicar = await dono().post(`/api/tenant/draws/${drawId}/result`, { federalNumber: '31905', federalContest: '6001', evidenceText: 'Loteria Federal 6001' });
      expect(publicar.status, JSON.stringify(publicar.body)).toBe(201);
      expect(await statusDe(drawId)).toBe('RESULTADO PUBLICADO');
      const corrigir = await dono().post(`/api/tenant/draws/${drawId}/result/correction`, { federalNumber: '31906', evidenceText: 'Conferencia', reason: 'digitacao' });
      expect([200, 201], JSON.stringify(corrigir.body)).toContain(corrigir.status);
      const pagina = await request(harness.app).get(`/api/public/draws/${(await harness.owner.query<{ slug: string }>('SELECT slug FROM draws WHERE id = $1', [drawId])).rows[0]!.slug}/result`).set('x-tenant-slug', c.slug);
      expect(pagina.status).toBe(200);
    });

    it('22. o historico da comunidade continua acessivel sem assinatura ativa (assinatura, faturas, sorteios, auditoria)', async () => {
      await ligar(true);
      await assinar(c, 'canceled');
      await harness.owner.query(
        `INSERT INTO billing_invoices (tenant_id, stripe_invoice_id, stripe_customer_id, status, currency, amount_due_cents, stripe_synced_at)
         SELECT $1, 'in_historico', stripe_customer_id, 'paid', 'brl', 1000, now() FROM tenant_billing WHERE tenant_id = $1`, [c.tenantId]);
      const cobranca = await dono().get('/api/tenant/billing');
      expect(cobranca.status).toBe(200);
      expect(cobranca.body.state).toBe('CANCELED');
      expect(cobranca.body.invoices).toHaveLength(1);
      expect((await dono().get('/api/tenant/draws')).status).toBe(200);
      expect((await dono().get('/api/tenant/audit-events')).status).toBe(200);
    });
  });
});
