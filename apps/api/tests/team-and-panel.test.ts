import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
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
import { csvCell } from '../src/modules/panel/panelService.js';

/**
 * Equipe, convites, dashboard, pedidos e paginacao. P9 · RN11.
 */
describe.skipIf(!hasTestDatabase)(`Equipe e painel ${hasTestDatabase ? '' : skipReason}`, () => {
  let harness: Harness;
  let slug: string;
  let tenantId: string;
  let owner: SeededAccount;
  let ownerCookie: string;

  /** Loga (com MFA satisfeito, se pedido) e devolve o cookie. */
  async function entrar(account: SeededAccount, comMfa: boolean): Promise<string> {
    const secret = comMfa ? await seedConfirmedTotp(harness.owner, account.userId) : null;
    const login = await loginAs(harness, account);
    return secret ? (await verifyMfa(harness, login.cookie, await currentCode(secret))).cookie : login.cookie;
  }

  beforeAll(async () => {
    harness = await createHarness();
    await cleanup(harness.owner);
    slug = unique('eq-');
    tenantId = await seedTenantWithSlug(harness.owner, slug, 'Comunidade da Equipe');
    owner = await seedAccount(harness.owner, { displayName: 'Dona da Comunidade' });
    await grantMembership(harness.owner, { tenantId, userId: owner.userId, role: 'OWNER' });
    ownerCookie = await entrar(owner, true);
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  const como = (cookie: string) => ({
    get: (url: string) => request(harness.app).get(url).set('Cookie', cookie).set('x-tenant-slug', slug),
    post: (url: string, body?: object) => request(harness.app).post(url).set('Cookie', cookie).set('x-tenant-slug', slug).send(body),
    patch: (url: string, body?: object) => request(harness.app).patch(url).set('Cookie', cookie).set('x-tenant-slug', slug).send(body),
    del: (url: string) => request(harness.app).delete(url).set('Cookie', cookie).set('x-tenant-slug', slug),
  });
  const dono = () => como(ownerCookie);
  const sha = (t: string) => createHash('sha256').update(t).digest('hex');

  // -------------------------------------------------------------------------
  describe('convites', () => {
    it('so o dono gerencia a equipe: operador e financeiro recebem 403', async () => {
      for (const role of ['OPERATOR', 'FINANCE', 'MARKETING', 'SUPPORT']) {
        const conta = await seedAccount(harness.owner);
        await grantMembership(harness.owner, { tenantId, userId: conta.userId, role });
        const c = como(await entrar(conta, true));
        expect((await c.get('/api/tenant/team')).status, role).toBe(403);
        expect((await c.post('/api/tenant/team/invitations', { email: 'x@example.com', role: 'OPERATOR' })).status, role).toBe(403);
      }
    });

    it('convida: devolve o token UMA vez e grava so o hash, valido por 7 dias', async () => {
      const email = `${unique('novo-')}@example.com`;
      const res = await dono().post('/api/tenant/team/invitations', { email, role: 'OPERATOR' });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      const dias = (new Date(res.body.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(dias).toBeGreaterThan(6.9);
      expect(dias).toBeLessThan(7.1);

      const { rows } = await harness.owner.query('SELECT token_hash FROM invitations WHERE id = $1', [res.body.id]);
      expect(rows[0]!.token_hash).toBe(sha(res.body.token));
      // O token NUNCA aparece na tabela nem na listagem.
      const lista = await dono().get('/api/tenant/team');
      expect(JSON.stringify(lista.body)).not.toContain(res.body.token);
      expect(lista.body.invitations.map((i: { email: string }) => i.email)).toContain(email);
    });

    it('reenviar revoga o convite anterior: o token velho para de funcionar', async () => {
      const email = `${unique('reenvio-')}@example.com`;
      const primeiro = await dono().post('/api/tenant/team/invitations', { email, role: 'FINANCE' });
      const segundo = await dono().post('/api/tenant/team/invitations', { email, role: 'FINANCE' });

      expect(segundo.body.token).not.toBe(primeiro.body.token);
      const velho = await request(harness.app).get(`/api/auth/invitations/${primeiro.body.token}`);
      const novo = await request(harness.app).get(`/api/auth/invitations/${segundo.body.token}`);
      expect(velho.body.state).toBe('REVOKED');
      expect(novo.body.state).toBe('OPEN');
    });

    it('quem ja tem o papel nao e convidado de novo (409)', async () => {
      const conta = await seedAccount(harness.owner);
      await grantMembership(harness.owner, { tenantId, userId: conta.userId, role: 'MARKETING' });
      const res = await dono().post('/api/tenant/team/invitations', { email: conta.email, role: 'MARKETING' });
      expect(res.status).toBe(409);
    });

    it('a previa mostra a comunidade e o papel, com o e-mail MASCARADO, sem sessao', async () => {
      const email = `${unique('previa-')}@example.com`;
      const convite = await dono().post('/api/tenant/team/invitations', { email, role: 'SUPPORT' });
      const res = await request(harness.app).get(`/api/auth/invitations/${convite.body.token}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ tenantName: 'Comunidade da Equipe', role: 'SUPPORT', state: 'OPEN' });
      expect(res.body.emailMasked).toMatch(/^p\*\*\*@example\.com$/);
      expect(JSON.stringify(res.body)).not.toContain(email);
    });

    it('token inexistente: 404', async () => {
      const res = await request(harness.app).get('/api/auth/invitations/nao-existe-de-jeito-nenhum');
      expect(res.status).toBe(404);
    });

    it('aceitar: cria o vinculo, encerra o convite e publica membership.granted', async () => {
      const convidada = await seedAccount(harness.owner);
      const convite = await dono().post('/api/tenant/team/invitations', { email: convidada.email, role: 'OPERATOR' });
      const cookie = (await loginAs(harness, convidada)).cookie;

      const res = await request(harness.app)
        .post(`/api/auth/invitations/${convite.body.token}/accept`)
        .set('Cookie', cookie);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({ tenantSlug: slug, tenantName: 'Comunidade da Equipe', role: 'OPERATOR' });

      const { rows } = await harness.owner.query(
        'SELECT role::text AS role FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL',
        [tenantId, convidada.userId],
      );
      expect(rows.map((r) => r.role)).toEqual(['OPERATOR']);
      const { rows: ev } = await harness.owner.query(
        "SELECT count(*)::int AS n FROM outbox WHERE event_type = 'membership.granted' AND payload->>'userId' = $1",
        [convidada.userId],
      );
      expect(ev[0]!.n).toBe(1);

      // E ja pode operar: o efeito e imediato.
      expect((await como(cookie).get('/api/tenant/draws')).status).toBe(200);
    });

    it('o convite so vale para o e-mail convidado: OUTRA conta recebe 404', async () => {
      const convidada = await seedAccount(harness.owner);
      const intrusa = await seedAccount(harness.owner);
      const convite = await dono().post('/api/tenant/team/invitations', { email: convidada.email, role: 'OPERATOR' });
      const cookie = (await loginAs(harness, intrusa)).cookie;

      const res = await request(harness.app)
        .post(`/api/auth/invitations/${convite.body.token}/accept`)
        .set('Cookie', cookie);

      expect(res.status).toBe(404);
      const { rows } = await harness.owner.query('SELECT 1 FROM memberships WHERE user_id = $1', [intrusa.userId]);
      expect(rows).toHaveLength(0);
    });

    it('sem sessao nao aceita (401); convite usado, revogado ou vencido: 409', async () => {
      const convidada = await seedAccount(harness.owner);
      const convite = await dono().post('/api/tenant/team/invitations', { email: convidada.email, role: 'OPERATOR' });
      const semSessao = await request(harness.app).post(`/api/auth/invitations/${convite.body.token}/accept`);
      expect(semSessao.status).toBe(401);

      const cookie = (await loginAs(harness, convidada)).cookie;
      const aceita = () => request(harness.app).post(`/api/auth/invitations/${convite.body.token}/accept`).set('Cookie', cookie);
      expect((await aceita()).status).toBe(200);
      expect((await aceita()).status).toBe(409); // ja usado

      const outra = await seedAccount(harness.owner);
      const revogado = await dono().post('/api/tenant/team/invitations', { email: outra.email, role: 'FINANCE' });
      await dono().del(`/api/tenant/team/invitations/${revogado.body.id}`);
      const cookieOutra = (await loginAs(harness, outra)).cookie;
      expect((await request(harness.app).post(`/api/auth/invitations/${revogado.body.token}/accept`).set('Cookie', cookieOutra)).status).toBe(409);

      const vencida = await seedAccount(harness.owner);
      const v = await dono().post('/api/tenant/team/invitations', { email: vencida.email, role: 'FINANCE' });
      await harness.owner.query("UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = $1", [v.body.id]);
      const cookieV = (await loginAs(harness, vencida)).cookie;
      expect((await request(harness.app).post(`/api/auth/invitations/${v.body.token}/accept`).set('Cookie', cookieV)).status).toBe(409);
      const previa = await request(harness.app).get(`/api/auth/invitations/${v.body.token}`);
      expect(previa.body.state).toBe('EXPIRED');
    });

    it('aceites simultaneos do mesmo convite: um vinculo so', async () => {
      const convidada = await seedAccount(harness.owner);
      const convite = await dono().post('/api/tenant/team/invitations', { email: convidada.email, role: 'SUPPORT' });
      const cookie = (await loginAs(harness, convidada)).cookie;
      const respostas = await Promise.all(
        Array.from({ length: 4 }, () => request(harness.app).post(`/api/auth/invitations/${convite.body.token}/accept`).set('Cookie', cookie)),
      );
      expect(respostas.filter((r) => r.status === 200)).toHaveLength(1);
      const { rows } = await harness.owner.query(
        'SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL',
        [tenantId, convidada.userId],
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('revogar convite deixa auditoria', async () => {
      const email = `${unique('rev-')}@example.com`;
      const c = await dono().post('/api/tenant/team/invitations', { email, role: 'OPERATOR' });
      expect((await dono().del(`/api/tenant/team/invitations/${c.body.id}`)).status).toBe(204);
      expect((await dono().del(`/api/tenant/team/invitations/${c.body.id}`)).status).toBe(404); // ja encerrado
      const { rows } = await harness.owner.query(
        "SELECT action FROM audit_events WHERE target_id = $1 ORDER BY occurred_at",
        [c.body.id],
      );
      expect(rows.map((r) => r.action)).toEqual(['team.invited', 'team.invitation_revoked']);
    });
  });

  // -------------------------------------------------------------------------
  describe('membros: trocar papel e remover (RN11)', () => {
    async function membro(role = 'OPERATOR') {
      const conta = await seedAccount(harness.owner);
      await grantMembership(harness.owner, { tenantId, userId: conta.userId, role });
      const lista = await dono().get('/api/tenant/team');
      const m = lista.body.members.find((x: { userId: string }) => x.userId === conta.userId);
      return { conta, membershipId: m.membershipId as string };
    }

    it('troca o papel: o vinculo antigo e REVOGADO (historico) e um novo nasce', async () => {
      const { conta, membershipId } = await membro('OPERATOR');
      const res = await dono().patch(`/api/tenant/team/members/${membershipId}`, { role: 'FINANCE' });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ userId: conta.userId, role: 'FINANCE' });
      const { rows } = await harness.owner.query(
        'SELECT role::text AS role, revoked_at IS NOT NULL AS revogado FROM memberships WHERE user_id = $1 ORDER BY created_at',
        [conta.userId],
      );
      expect(rows).toEqual([
        { role: 'OPERATOR', revogado: true },
        { role: 'FINANCE', revogado: false },
      ]);
      const { rows: ev } = await harness.owner.query(
        "SELECT event_type FROM outbox WHERE payload->>'userId' = $1 ORDER BY event_type",
        [conta.userId],
      );
      expect(ev.map((e) => e.event_type)).toEqual(['membership.granted', 'membership.revoked']);
      const { rows: audit } = await harness.owner.query(
        "SELECT before, after FROM audit_events WHERE action = 'team.member_role_changed' AND after->>'userId' = $1",
        [conta.userId],
      );
      expect(audit[0]).toMatchObject({ before: { role: 'OPERATOR' }, after: { role: 'FINANCE' } });
    });

    it('remover tem efeito IMEDIATO: a proxima requisicao do ex-membro e recusada', async () => {
      const { conta, membershipId } = await membro('OPERATOR');
      const cookie = await entrar(conta, false);
      expect((await como(cookie).get('/api/tenant/draws')).status).toBe(200);

      expect((await dono().del(`/api/tenant/team/members/${membershipId}`)).status).toBe(204);

      const depois = await como(cookie).get('/api/tenant/draws');
      expect([403, 404]).toContain(depois.status);
      const { rows } = await harness.owner.query('SELECT revoked_at, revoked_by FROM memberships WHERE id = $1', [membershipId]);
      expect(rows[0]!.revoked_at).not.toBeNull();
      expect(rows[0]!.revoked_by).toBe(owner.userId);
    });

    it('ninguem altera o proprio papel nem se remove', async () => {
      const lista = await dono().get('/api/tenant/team');
      const eu = lista.body.members.find((m: { userId: string }) => m.userId === owner.userId);
      expect(eu.isSelf).toBe(true);
      expect((await dono().patch(`/api/tenant/team/members/${eu.membershipId}`, { role: 'FINANCE' })).status).toBe(409);
      expect((await dono().del(`/api/tenant/team/members/${eu.membershipId}`)).status).toBe(409);
    });

    it('o ULTIMO dono nao sai nem e rebaixado; com outro dono, pode', async () => {
      // A comunidade tem um so dono (owner). Um segundo dono tenta tirar o primeiro:
      const segundo = await seedAccount(harness.owner);
      await grantMembership(harness.owner, { tenantId, userId: segundo.userId, role: 'OWNER' });
      const cookie2 = await entrar(segundo, true);
      const lista = await como(cookie2).get('/api/tenant/team');
      const primeiro = lista.body.members.find((m: { userId: string }) => m.userId === owner.userId);

      // Com dois donos, remover um e permitido...
      const outro = await seedAccount(harness.owner);
      await grantMembership(harness.owner, { tenantId, userId: outro.userId, role: 'OWNER' });
      const lista2 = await como(cookie2).get('/api/tenant/team');
      const donoExtra = lista2.body.members.find((m: { userId: string }) => m.userId === outro.userId);
      expect((await como(cookie2).del(`/api/tenant/team/members/${donoExtra.membershipId}`)).status).toBe(204);

      // ...mas se restarem so dois e um sai, o outro vira o ultimo: precisa parar.
      expect((await como(cookie2).del(`/api/tenant/team/members/${primeiro.membershipId}`)).status).toBe(204);
      // Agora `segundo` e o unico dono; ninguem mais pode remove-lo (nem ele mesmo).
      const lista3 = await como(cookie2).get('/api/tenant/team');
      const eu = lista3.body.members.find((m: { userId: string }) => m.userId === segundo.userId);
      expect((await como(cookie2).del(`/api/tenant/team/members/${eu.membershipId}`)).status).toBe(409);

      // Devolve o cenario ao estado inicial para os demais testes.
      await grantMembership(harness.owner, { tenantId, userId: owner.userId, role: 'OWNER' });
    });

    it('rebaixar o ultimo dono e recusado', async () => {
      const soDono = await seedTenantWithSlug(harness.owner, unique('umdono-'), 'Um dono');
      const a = await seedAccount(harness.owner);
      const b = await seedAccount(harness.owner);
      await grantMembership(harness.owner, { tenantId: soDono, userId: a.userId, role: 'OWNER' });
      await grantMembership(harness.owner, { tenantId: soDono, userId: b.userId, role: 'OWNER' });
      const cookieA = await entrar(a, true);
      const slugDono = (await harness.owner.query<{ slug: string }>('SELECT slug FROM tenants WHERE id = $1', [soDono])).rows[0]!.slug;
      const ca = (url: string) => request(harness.app).get(url).set('Cookie', cookieA).set('x-tenant-slug', slugDono);
      const lista = await ca('/api/tenant/team');
      const vinculoB = lista.body.members.find((m: { userId: string }) => m.userId === b.userId);
      // A rebaixa B (permitido: A continua dono).
      const rebaixa = await request(harness.app).patch(`/api/tenant/team/members/${vinculoB.membershipId}`).set('Cookie', cookieA).set('x-tenant-slug', slugDono).send({ role: 'FINANCE' });
      expect(rebaixa.status).toBe(200);
      // Agora A e o unico dono: um segundo dono nao existe para tentar.
    });

    it('membro de OUTRA comunidade: 404', async () => {
      const outra = await seedTenantWithSlug(harness.owner, unique('alheia-'), 'Alheia');
      const conta = await seedAccount(harness.owner);
      await grantMembership(harness.owner, { tenantId: outra, userId: conta.userId, role: 'OPERATOR' });
      const { rows } = await harness.owner.query<{ id: string }>('SELECT id FROM memberships WHERE user_id = $1', [conta.userId]);
      expect((await dono().patch(`/api/tenant/team/members/${rows[0]!.id}`, { role: 'FINANCE' })).status).toBe(404);
      expect((await dono().del(`/api/tenant/team/members/${rows[0]!.id}`)).status).toBe(404);
    });

    it('papel invalido: 400', async () => {
      const { membershipId } = await membro('OPERATOR');
      expect((await dono().patch(`/api/tenant/team/members/${membershipId}`, { role: 'REI' })).status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  describe('criar comunidade: dono por conta existente OU convite de 7 dias', () => {
    let adminCookie: string;

    beforeAll(async () => {
      const admin = await seedAccount(harness.owner);
      await grantPlatformRole(harness.owner, { userId: admin.userId, role: 'PLATFORM_OPERATIONS' });
      adminCookie = await entrar(admin, true);
    });

    const criar = (body: object) => request(harness.app).post('/api/platform/tenants').set('Cookie', adminCookie).send(body);

    it('e-mail SEM conta: a comunidade nasce com um convite de dono valido por 7 dias', async () => {
      const email = `${unique('futuro-')}@example.com`;
      const res = await criar({ slug: unique('nova-'), name: 'Nova Comunidade', ownerEmail: email });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.owner).toBeNull();
      expect(res.body.ownerInvitation).toMatchObject({ email });
      const dias = (new Date(res.body.ownerInvitation.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(dias).toBeGreaterThan(6.9);

      // A pessoa se cadastra, faz login e aceita: vira dona.
      const conta = await seedAccount(harness.owner, { email });
      const cookie = (await loginAs(harness, conta)).cookie;
      const aceite = await request(harness.app)
        .post(`/api/auth/invitations/${res.body.ownerInvitation.token}/accept`)
        .set('Cookie', cookie);
      expect(aceite.status).toBe(200);
      expect(aceite.body.role).toBe('OWNER');
    });

    it('e-mail COM conta: a pessoa vira dona na hora, sem convite', async () => {
      const conta = await seedAccount(harness.owner);
      const res = await criar({ slug: unique('ja-'), name: 'Ja Cadastrada', ownerEmail: conta.email });
      expect(res.status).toBe(201);
      expect(res.body.owner).toMatchObject({ userId: conta.userId });
      expect(res.body.ownerInvitation).toBeNull();
    });

    it('a comunidade nunca nasce sem dono: convite e comunidade na mesma transacao', async () => {
      const slugNovo = unique('atomica-');
      const res = await criar({ slug: slugNovo, name: 'Atomica', ownerEmail: `${unique('a-')}@example.com` });
      expect(res.status).toBe(201);
      const { rows } = await harness.owner.query(
        "SELECT count(*)::int AS n FROM invitations i JOIN tenants t ON t.id = i.tenant_id WHERE t.slug = $1 AND i.role = 'OWNER'",
        [slugNovo],
      );
      expect(rows[0]!.n).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('dashboard', () => {
    let financeCookie: string;
    let operatorCookie: string;

    beforeAll(async () => {
      const fin = await seedAccount(harness.owner);
      await grantMembership(harness.owner, { tenantId, userId: fin.userId, role: 'FINANCE' });
      financeCookie = await entrar(fin, true);
      const op = await seedAccount(harness.owner);
      await grantMembership(harness.owner, { tenantId, userId: op.userId, role: 'OPERATOR' });
      operatorCookie = await entrar(op, false);
    });

    async function sorteioComVendas(): Promise<string> {
      const { rows } = await harness.owner.query<{ id: string }>(
        `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers, status)
         VALUES ($1, $2, 'Dash', 'P', 1000, 100, 'ATIVA') RETURNING id`,
        [tenantId, unique('dash-')],
      );
      const drawId = rows[0]!.id;
      const { rows: b } = await harness.owner.query<{ id: string }>(
        "INSERT INTO buyers (tenant_id, name, phone) VALUES ($1, 'Maria Souza', '11912345678') RETURNING id", [tenantId],
      );
      const { rows: o } = await harness.owner.query<{ id: string }>(
        `INSERT INTO orders (tenant_id, draw_id, buyer_id, status, unit_price_cents, quantity, total_cents, accepted_terms_at, paid_at)
         VALUES ($1, $2, $3, 'PAGO', 1000, 3, 3000, now(), now()) RETURNING id`,
        [tenantId, drawId, b[0]!.id],
      );
      await harness.owner.query(
        'INSERT INTO order_items (tenant_id, order_id, number, unit_price_cents) SELECT $1, $2, n, 1000 FROM unnest($3::int[]) AS n',
        [tenantId, o[0]!.id, [1, 2, 3]],
      );
      await harness.owner.query(
        "INSERT INTO draw_numbers (tenant_id, draw_id, number, status, order_id) SELECT $1, $2, n, 'PAGO', $3 FROM unnest($4::int[]) AS n",
        [tenantId, drawId, o[0]!.id, [1, 2, 3]],
      );
      return drawId;
    }

    it('mostra vendidos (so PAGO), arrecadado, reservas, PIX pendentes e 30 dias sem buracos', async () => {
      await sorteioComVendas();
      // Reserva viva e PIX pendente: NAO contam como vendidos (RN18).
      const { rows } = await harness.owner.query<{ id: string }>(
        `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers, status)
         VALUES ($1, $2, 'Reservas', 'P', 1000, 100, 'ATIVA') RETURNING id`, [tenantId, unique('r-')],
      );
      await harness.owner.query(
        `INSERT INTO draw_numbers (tenant_id, draw_id, number, status, expires_at)
         VALUES ($1, $2, 50, 'RESERVADO', now() + interval '10 minutes'), ($1, $2, 51, 'RESERVADO', now() - interval '1 minute')`,
        [tenantId, rows[0]!.id],
      );

      const res = await dono().get('/api/tenant/dashboard');

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.soldNumbers).toBeGreaterThanOrEqual(3);
      expect(res.body.revenueCents).toBeGreaterThanOrEqual(3000);
      expect(res.body.activeReservations).toBeGreaterThanOrEqual(1); // so a que nao venceu
      expect(res.body.drawsByStatus.ATIVA).toBeGreaterThanOrEqual(2);
      expect(Object.keys(res.body.drawsByStatus)).toHaveLength(10);
      expect(res.body.salesByDay).toHaveLength(30);
      const hoje = res.body.salesByDay.at(-1);
      expect(hoje.paidNumbers).toBeGreaterThanOrEqual(3);
      const datas: string[] = res.body.salesByDay.map((d: { date: string }) => d.date);
      expect(new Set(datas).size).toBe(30);
      expect([...datas].sort()).toEqual(datas);
    });

    it('sem payment:read:full, os VALORES vem nulos (o operador ve so contagens)', async () => {
      const res = await como(operatorCookie).get('/api/tenant/dashboard');
      expect(res.status).toBe(200);
      expect(res.body.revenueCents).toBeNull();
      expect(res.body.manualRefunds).toBeNull();
      expect(res.body.salesByDay.every((d: { revenueCents: number | null }) => d.revenueCents === null)).toBe(true);
      expect(res.body.soldNumbers).toBeGreaterThanOrEqual(3);
    });

    it('o financeiro ve os valores', async () => {
      const res = await como(financeCookie).get('/api/tenant/dashboard');
      expect(res.body.revenueCents).not.toBeNull();
      expect(res.body.manualRefunds).not.toBeNull();
    });

    it('isolamento: a comunidade B nao ve os numeros da A', async () => {
      const outra = unique('vazia-');
      const outraId = await seedTenantWithSlug(harness.owner, outra, 'Vazia');
      const conta = await seedAccount(harness.owner);
      await grantMembership(harness.owner, { tenantId: outraId, userId: conta.userId, role: 'OWNER' });
      const cookie = await entrar(conta, true);
      const res = await request(harness.app).get('/api/tenant/dashboard').set('Cookie', cookie).set('x-tenant-slug', outra);
      expect(res.body.soldNumbers).toBe(0);
      expect(res.body.revenueCents).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('pedidos do sorteio e CSV', () => {
    let drawId: string;
    let supportCookie: string;
    let operatorCookie: string;

    async function pedido(numeros: number[], nome: string, telefone: string, email: string | null, criadoHa: string) {
      const { rows: b } = await harness.owner.query<{ id: string }>(
        'INSERT INTO buyers (tenant_id, name, phone, email) VALUES ($1, $2, $3, $4) RETURNING id',
        [tenantId, nome, telefone, email],
      );
      const { rows: o } = await harness.owner.query<{ id: string }>(
        `INSERT INTO orders (tenant_id, draw_id, buyer_id, status, unit_price_cents, quantity, total_cents, accepted_terms_at, created_at)
         VALUES ($1, $2, $3, 'PENDENTE', 1500, $4, $5, now(), now() - $6::interval) RETURNING id`,
        [tenantId, drawId, b[0]!.id, numeros.length, numeros.length * 1500, criadoHa],
      );
      await harness.owner.query(
        'INSERT INTO order_items (tenant_id, order_id, number, unit_price_cents) SELECT $1, $2, n, 1500 FROM unnest($3::int[]) AS n',
        [tenantId, o[0]!.id, numeros],
      );
      return o[0]!.id;
    }

    beforeAll(async () => {
      const { rows } = await harness.owner.query<{ id: string }>(
        `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers, status)
         VALUES ($1, $2, 'Pedidos', 'P', 1500, 100, 'ATIVA') RETURNING id`, [tenantId, unique('ped-')],
      );
      drawId = rows[0]!.id;
      for (let i = 0; i < 7; i += 1) {
        await pedido([i, i + 50], `Comprador ${i} Silva`, `1191234000${i}`, `c${i}@example.com`, `${(7 - i) * 10} minutes`);
      }
      const sup = await seedAccount(harness.owner);
      await grantMembership(harness.owner, { tenantId, userId: sup.userId, role: 'SUPPORT' });
      supportCookie = await entrar(sup, false);
      const op = await seedAccount(harness.owner);
      await grantMembership(harness.owner, { tenantId, userId: op.userId, role: 'OPERATOR' });
      operatorCookie = await entrar(op, false);
    });

    it('pagina por cursor, do mais novo ao mais antigo, sem repetir nem perder', async () => {
      const vistos: string[] = [];
      let cursor: string | null = null;
      let paginas = 0;
      do {
        const res: request.Response = await dono().get(`/api/tenant/draws/${drawId}/orders?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        vistos.push(...res.body.orders.map((o: { orderId: string }) => o.orderId));
        cursor = res.body.nextCursor;
        paginas += 1;
      } while (cursor && paginas < 10);

      expect(paginas).toBe(3); // 3 + 3 + 1
      expect(vistos).toHaveLength(7);
      expect(new Set(vistos).size).toBe(7);
    });

    it('quem tem buyer:read:full ve o contato; numeros e valores vem certos', async () => {
      const res = await dono().get(`/api/tenant/draws/${drawId}/orders?limit=1`);
      expect(res.body.contactVisible).toBe(true);
      expect(res.body.orders[0]).toMatchObject({
        buyerName: expect.stringContaining('Comprador'),
        buyerPhone: expect.stringMatching(/^\d+$/),
        buyerEmail: expect.stringContaining('@example.com'),
        quantity: 2,
        totalCents: 3000,
        status: 'PENDENTE',
        needsManualRefund: false,
      });
      expect(res.body.orders[0].numbers).toHaveLength(2);
    });

    it('quem so tem payment:read:status (operador) ve o estado, mas NADA de contato: nome mascarado', async () => {
      const res = await como(operatorCookie).get(`/api/tenant/draws/${drawId}/orders?limit=2`);
      expect(res.status).toBe(200);
      expect(res.body.contactVisible).toBe(false);
      const texto = JSON.stringify(res.body);
      expect(texto).not.toContain('example.com');
      expect(texto).not.toContain('1191234000');
      expect(texto).not.toContain('Silva');
      expect(res.body.orders[0].buyerName).toMatch(/^C\*\*\* \d\*\*\* S\*\*\*$/);
      expect(res.body.orders[0].buyerPhone).toBeNull();
      expect(res.body.orders[0].buyerEmail).toBeNull();
    });

    it('cursor adulterado: 400', async () => {
      for (const ruim of ['lixo', 'AAAA', 'bm9wZQ', encodeURIComponent("' OR 1=1 --")]) {
        expect((await dono().get(`/api/tenant/draws/${drawId}/orders?cursor=${ruim}`)).status, ruim).toBe(400);
      }
    });

    it('sorteio de OUTRA comunidade: 404', async () => {
      const outra = await seedTenantWithSlug(harness.owner, unique('alheia2-'), 'Alheia');
      const { rows } = await harness.owner.query<{ id: string }>(
        `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers)
         VALUES ($1, $2, 'A', 'P', 1000, 100) RETURNING id`, [outra, unique('a-')],
      );
      expect((await dono().get(`/api/tenant/draws/${rows[0]!.id}/orders`)).status).toBe(404);
      expect((await dono().get(`/api/tenant/draws/${rows[0]!.id}/orders/export`)).status).toBe(404);
    });

    it('exporta CSV com acentos (BOM), rotulos de 2 digitos e auditoria', async () => {
      const res = await como(supportCookie).get(`/api/tenant/draws/${drawId}/orders/export`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.filename).toMatch(/^pedidos-.+-\d{8}\.csv$/);
      const csv: string = res.body.content;
      expect(csv.charCodeAt(0)).toBe(0xfeff);
      const linhas = csv.slice(1).trimEnd().split('\r\n');
      expect(linhas[0]).toBe('pedido,status,criado_em,pago_em,quantidade,total_reais,numeros,nome,telefone,email,status_pagamento,estorno_manual');
      expect(linhas).toHaveLength(8); // cabecalho + 7 pedidos
      expect(linhas[1]).toContain('30.00');
      expect(linhas[1]).toMatch(/\d\d \d\d/); // 2 digitos: "00 50"
      const { rows } = await harness.owner.query(
        "SELECT after FROM audit_events WHERE action = 'draw.orders_exported' AND target_id = $1", [drawId],
      );
      expect(rows[0]!.after).toMatchObject({ rows: 7 });
    });

    it('a exportacao exige buyer:read:full: o operador recebe 403', async () => {
      expect((await como(operatorCookie).get(`/api/tenant/draws/${drawId}/orders/export`)).status).toBe(403);
    });

    it('o CSV neutraliza INJECAO DE FORMULA e escapa aspas, virgula e quebra de linha', async () => {
      await pedido([90], '=HYPERLINK("http://mal.exemplo","clique")', '+55 11 90000-0000', '-cmd@example.com', '1 minutes');
      await pedido([91], 'Maria, "a Grande"\nSouza', '@telefone', null, '2 minutes');
      const res = await como(supportCookie).get(`/api/tenant/draws/${drawId}/orders/export`);
      const csv: string = res.body.content;

      expect(csv).toContain("\"'=HYPERLINK(\"\"http://mal.exemplo\"\",\"\"clique\"\")\"");
      expect(csv).toContain("'+55 11 90000-0000");
      expect(csv).toContain("'-cmd@example.com");
      expect(csv).toContain("'@telefone");
      expect(csv).toContain('"Maria, ""a Grande""\nSouza"');
      // Nenhuma celula comeca com caractere de formula.
      for (const linha of csv.slice(1).split('\r\n').slice(1)) {
        for (const celula of linha.split(',')) expect(celula.replace(/^"/, '')).not.toMatch(/^[=+\-@]/);
      }
    });

    it('csvCell: casos de borda', () => {
      expect(csvCell(null)).toBe('');
      expect(csvCell(undefined)).toBe('');
      expect(csvCell(42)).toBe('42');
      expect(csvCell('simples')).toBe('simples');
      expect(csvCell('=1+1')).toBe("'=1+1");
      expect(csvCell('\t=x')).toBe("'\t=x");
      expect(csvCell('a;b')).toBe('"a;b"');
      expect(csvCell('-')).toBe("'-");
    });
  });

  // -------------------------------------------------------------------------
  describe('paginacao por cursor nas listagens', () => {
    async function paginar(cookie: string | null, url: string, chave: string, limite = 2) {
      const ids: string[] = [];
      let cursor: string | null = null;
      let paginas = 0;
      do {
        let req = request(harness.app).get(`${url}${url.includes('?') ? '&' : '?'}limit=${limite}${cursor ? `&cursor=${cursor}` : ''}`).set('x-tenant-slug', slug);
        if (cookie) req = req.set('Cookie', cookie);
        const res: request.Response = await req;
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        ids.push(...res.body[chave].map((x: { id: string }) => x.id));
        cursor = res.body.nextCursor;
        paginas += 1;
      } while (cursor && paginas < 50);
      return { ids, paginas };
    }

    it('sorteios do organizador: sem passar de 200, sem repetir', async () => {
      for (let i = 0; i < 5; i += 1) {
        await harness.owner.query(
          `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers)
           VALUES ($1, $2, $3, 'P', 1000, 100)`, [tenantId, unique('pg-'), `Paginado ${i}`],
        );
      }
      const { ids, paginas } = await paginar(ownerCookie, '/api/tenant/draws', 'draws');
      expect(paginas).toBeGreaterThanOrEqual(3);
      expect(new Set(ids).size).toBe(ids.length);
      const { rows } = await harness.owner.query('SELECT count(*)::int AS n FROM draws WHERE tenant_id = $1', [tenantId]);
      expect(ids).toHaveLength(rows[0]!.n);
    });

    it('vitrine: as vendas abertas vem primeiro e a paginacao respeita a faixa', async () => {
      const { ids } = await paginar(null, '/api/public/draws', 'draws');
      expect(new Set(ids).size).toBe(ids.length);
      const { rows } = await harness.owner.query<{ id: string; ativa: boolean }>(
        `SELECT id, status = 'ATIVA' AS ativa FROM draws
          WHERE tenant_id = $1 AND status IN ('ATIVA','PAUSADA','VENDAS ENCERRADAS','APURAÇÃO','RESULTADO PUBLICADO')`, [tenantId],
      );
      expect(ids.sort()).toEqual(rows.map((r) => r.id).sort());
      // Todas as ATIVA antes de qualquer outra.
      const { ids: ordem } = await paginar(null, '/api/public/draws', 'draws', 100);
      const ativas = new Set(rows.filter((r) => r.ativa).map((r) => r.id));
      const primeiraNaoAtiva = ordem.findIndex((id) => !ativas.has(id));
      if (primeiraNaoAtiva !== -1) expect(ordem.slice(primeiraNaoAtiva).some((id) => ativas.has(id))).toBe(false);
    });

    it('auditoria da comunidade pagina; limite acima do teto e cortado', async () => {
      const { ids, paginas } = await paginar(ownerCookie, '/api/tenant/audit-events', 'events', 5);
      expect(paginas).toBeGreaterThanOrEqual(2);
      expect(new Set(ids).size).toBe(ids.length);
      const res = await dono().get('/api/tenant/audit-events?limit=100000');
      expect(res.status).toBe(200);
      expect(res.body.events.length).toBeLessThanOrEqual(100);
    });

    it('comunidades da plataforma paginam', async () => {
      const admin = await seedAccount(harness.owner);
      await grantPlatformRole(harness.owner, { userId: admin.userId, role: 'PLATFORM_OPERATIONS' });
      const cookie = await entrar(admin, true);
      const { ids, paginas } = await paginar(cookie, '/api/platform/tenants', 'tenants', 3);
      expect(paginas).toBeGreaterThanOrEqual(2);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('cursor invalido em qualquer lista: 400', async () => {
      expect((await dono().get('/api/tenant/draws?cursor=lixo')).status).toBe(400);
      expect((await request(harness.app).get('/api/public/draws?cursor=lixo').set('x-tenant-slug', slug)).status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  describe('grade: ETag e consentimento de mensagens', () => {
    it('a grade responde com ETag e Cache-Control: no-cache; If-None-Match igual devolve 304', async () => {
      const { rows } = await harness.owner.query<{ id: string }>(
        `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers, status)
         VALUES ($1, $2, 'ETag', 'P', 1000, 100, 'ATIVA') RETURNING id`, [tenantId, unique('etag-')],
      );
      const url = `/api/public/draws/${rows[0]!.id}/numbers`;
      const primeira = await request(harness.app).get(url).set('x-tenant-slug', slug);
      expect(primeira.status).toBe(200);
      expect(primeira.headers['cache-control']).toBe('no-cache');
      const etag = primeira.headers['etag'];
      expect(etag).toBeTruthy();

      const segunda = await request(harness.app).get(url).set('x-tenant-slug', slug).set('If-None-Match', etag!);
      expect(segunda.status).toBe(304);
      expect(segunda.text).toBe('');

      // Mudou a grade: o ETag muda e volta o corpo.
      await harness.owner.query(
        "INSERT INTO draw_numbers (tenant_id, draw_id, number, status, expires_at) VALUES ($1, $2, 5, 'RESERVADO', now() + interval '10 minutes')",
        [tenantId, rows[0]!.id],
      );
      const terceira = await request(harness.app).get(url).set('x-tenant-slug', slug).set('If-None-Match', etag!);
      expect(terceira.status).toBe(200);
      expect(terceira.headers['etag']).not.toBe(etag);
    });

    it('o consentimento de mensagens e independente do aceite do regulamento', async () => {
      const { rows } = await harness.owner.query<{ id: string }>(
        `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers, status)
         VALUES ($1, $2, 'Consent', 'P', 1000, 100, 'ATIVA') RETURNING id`, [tenantId, unique('c-')],
      );
      const comprar = async (numero: number, extra: object) => {
        const r = await request(harness.app).post(`/api/public/draws/${rows[0]!.id}/reservations`).set('x-tenant-slug', slug).send({ numbers: [numero] });
        const p = await request(harness.app).post('/api/public/orders').set('x-tenant-slug', slug).send({
          reservationId: r.body.reservationId,
          buyer: { name: 'Maria Souza', phone: '+55 11 91234-5678' },
          acceptedTerms: true,
          ...extra,
        });
        expect(p.status, JSON.stringify(p.body)).toBe(201);
        return p.body.orderId as string;
      };
      const sem = await comprar(1, {});
      const nao = await comprar(2, { messagingConsent: false });
      const sim = await comprar(3, { messagingConsent: true });

      const { rows: o } = await harness.owner.query<{ id: string; termos: boolean; msg: boolean }>(
        'SELECT id, accepted_terms_at IS NOT NULL AS termos, messaging_consent_at IS NOT NULL AS msg FROM orders WHERE id = ANY($1::uuid[])',
        [[sem, nao, sim]],
      );
      const por = Object.fromEntries(o.map((x) => [x.id, x]));
      // Todos aceitaram o regulamento; so um consentiu em mensagens.
      expect([por[sem]!.termos, por[nao]!.termos, por[sim]!.termos]).toEqual([true, true, true]);
      expect([por[sem]!.msg, por[nao]!.msg, por[sim]!.msg]).toEqual([false, false, true]);
    });

    it('sem aceitar o regulamento nao compra, mesmo consentindo em mensagens', async () => {
      const { rows } = await harness.owner.query<{ id: string }>(
        `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers, status)
         VALUES ($1, $2, 'Sem aceite', 'P', 1000, 100, 'ATIVA') RETURNING id`, [tenantId, unique('sa-')],
      );
      const r = await request(harness.app).post(`/api/public/draws/${rows[0]!.id}/reservations`).set('x-tenant-slug', slug).send({ numbers: [9] });
      const p = await request(harness.app).post('/api/public/orders').set('x-tenant-slug', slug).send({
        reservationId: r.body.reservationId,
        buyer: { name: 'Maria Souza', phone: '+55 11 91234-5678' },
        acceptedTerms: false,
        messagingConsent: true,
      });
      expect(p.status).toBe(400);
    });
  });
});
