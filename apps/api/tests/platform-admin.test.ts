import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
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
} from './helpers/apiHarness.js';

/**
 * Super Admin: usuarios, criadores e metricas. Somente leitura, com menor privilegio:
 * OPERATIONS e SUPPORT leem usuarios; OPERATIONS/FINANCE leem metricas; so quem tem a
 * permissao financeira ve o valor bruto. Nada devolve credencial.
 */
describe.skipIf(!hasTestDatabase)(`admin: usuarios, criadores e metricas ${hasTestDatabase ? '' : skipReason}`, () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
    await cleanup(h.owner);
  }, 120_000);

  afterAll(async () => {
    await cleanup(h.owner);
    await h.pool.end();
  });

  async function admin(role: string): Promise<string> {
    const conta = await seedAccount(h.owner, { displayName: `Admin ${role}` });
    await grantPlatformRole(h.owner, { userId: conta.userId, role });
    const segredo = await seedConfirmedTotp(h.owner, conta.userId);
    const { cookie } = await loginAs(h, conta);
    const elevado = await verifyMfa(h, cookie, await currentCode(segredo));
    expect(elevado.status).toBe(200);
    return elevado.cookie;
  }

  it('lista usuarios com busca e paginacao, sem expor credencial', async () => {
    const cookie = await admin('PLATFORM_OPERATIONS');
    const marca = unique('busca');
    const a = await seedAccount(h.owner, { email: `${marca}-a@example.com`, displayName: 'Ana da Busca' });
    await seedAccount(h.owner, { email: `${marca}-b@example.com`, displayName: 'Beto da Busca' });

    const todos = await request(h.app).get('/api/platform/users').query({ q: marca }).set('Cookie', cookie);
    expect(todos.status, JSON.stringify(todos.body)).toBe(200);
    expect(todos.body.users).toHaveLength(2);
    const ana = (todos.body.users as { id: string; email: string; membershipsCount: number; ordersCount: number; platformRoles: string[] }[]).find((u) => u.id === a.userId)!;
    expect(ana).toMatchObject({ email: a.email, membershipsCount: 0, ordersCount: 0, platformRoles: [] });
    const texto = JSON.stringify(todos.body);
    expect(texto).not.toMatch(/password|hash|secret|token/i);

    const p1 = await request(h.app).get('/api/platform/users').query({ q: marca, limit: 1 }).set('Cookie', cookie);
    expect(p1.body.users).toHaveLength(1);
    expect(p1.body.nextCursor).toEqual(expect.any(String));
    const p2 = await request(h.app).get('/api/platform/users').query({ q: marca, limit: 1, cursor: p1.body.nextCursor }).set('Cookie', cookie);
    expect(p2.body.users).toHaveLength(1);
    expect(p2.body.users[0].id).not.toBe(p1.body.users[0].id);

    // curinga do LIKE nao vira "todos": "%" literal nao casa com nada.
    const curinga = await request(h.app).get('/api/platform/users').query({ q: '%' }).set('Cookie', cookie);
    expect(curinga.body.users).toHaveLength(0);

    expect((await request(h.app).get('/api/platform/users').query({ status: 'QUALQUER' }).set('Cookie', cookie)).status).toBe(400);
    expect((await request(h.app).get('/api/platform/users').query({ cursor: 'adulterado' }).set('Cookie', cookie)).status).toBe(400);
  }, 90_000);

  it('criadores: so comunidades com dono, com o dono listado e sem segredo', async () => {
    const cookie = await admin('PLATFORM_OPERATIONS');
    const slugCom = unique('criador-');
    const slugSem = unique('semdono-');
    const tenantId = await seedTenantWithSlug(h.owner, slugCom, 'Rifas da Maria');
    await seedTenantWithSlug(h.owner, slugSem, 'Sem Dono');
    const dona = await seedAccount(h.owner, { displayName: 'Maria Dona' });
    await grantMembership(h.owner, { tenantId, userId: dona.userId, role: 'OWNER' });

    const res = await request(h.app).get('/api/platform/creators').query({ q: slugCom }).set('Cookie', cookie);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.creators).toHaveLength(1);
    expect(res.body.creators[0]).toMatchObject({
      tenantId,
      slug: slugCom,
      name: 'Rifas da Maria',
      planName: null,
      subscriptionStatus: null,
      paymentAccountStatus: null,
      publicDraws: 0,
      activeDraws: 0,
    });
    expect(res.body.creators[0].owners).toEqual([{ userId: dona.userId, displayName: 'Maria Dona', email: dona.email }]);

    const semDono = await request(h.app).get('/api/platform/creators').query({ q: slugSem }).set('Cookie', cookie);
    expect(semDono.body.creators).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash|secret|token/i);
  }, 90_000);

  it('metricas: contagens reais; valor bruto so com permissao financeira', async () => {
    const ops = await admin('PLATFORM_OPERATIONS');
    const fin = await admin('PLATFORM_FINANCE');

    const a = await request(h.app).get('/api/platform/metrics').set('Cookie', ops);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.users.total).toBeGreaterThanOrEqual(a.body.users.active);
    expect(a.body.communities.total).toBeGreaterThanOrEqual(1);
    expect(a.body.orders.paid).toBeGreaterThanOrEqual(0);
    expect(a.body.orders.grossPaidCents).toBeNull();

    const b = await request(h.app).get('/api/platform/metrics').set('Cookie', fin);
    expect(b.status).toBe(200);
    expect(b.body.orders.grossPaidCents).toEqual(expect.any(Number));
  }, 90_000);

  it('menor privilegio: cada papel ve so a sua area', async () => {
    const suporte = await admin('PLATFORM_SUPPORT');
    const financeiro = await admin('PLATFORM_FINANCE');
    expect((await request(h.app).get('/api/platform/users').set('Cookie', suporte)).status).toBe(200);
    expect((await request(h.app).get('/api/platform/metrics').set('Cookie', suporte)).status).toBe(403);
    expect((await request(h.app).get('/api/platform/users').set('Cookie', financeiro)).status).toBe(403);
    expect((await request(h.app).get('/api/platform/creators').set('Cookie', financeiro)).status).toBe(200);
  }, 90_000);

  it('quem nao e Super Admin, ou nao passou pelo MFA, nao entra', async () => {
    // dono de comunidade com MFA: nao e administrador da plataforma
    const tenantId = await seedTenantWithSlug(h.owner, unique('c-'));
    const dono = await seedAccount(h.owner);
    await grantMembership(h.owner, { tenantId, userId: dono.userId, role: 'OWNER' });
    const segredo = await seedConfirmedTotp(h.owner, dono.userId);
    const { cookie } = await loginAs(h, dono);
    const elevado = await verifyMfa(h, cookie, await currentCode(segredo));
    for (const rota of ['users', 'creators', 'metrics']) {
      expect((await request(h.app).get(`/api/platform/${rota}`).set('Cookie', elevado.cookie)).status).toBe(403);
    }

    // anonimo
    expect((await request(h.app).get('/api/platform/users')).status).toBe(401);

    // Super Admin sem MFA satisfeito
    const conta = await seedAccount(h.owner);
    await grantPlatformRole(h.owner, { userId: conta.userId, role: 'PLATFORM_OPERATIONS' });
    await seedConfirmedTotp(h.owner, conta.userId);
    const semMfa = await loginAs(h, conta);
    const res = await request(h.app).get('/api/platform/users').set('Cookie', semMfa.cookie);
    expect(res.status).toBe(403);
    expect(['MFA_REQUIRED', 'MFA_ENROLLMENT_REQUIRED']).toContain(res.body.error.code);
  }, 90_000);
});
