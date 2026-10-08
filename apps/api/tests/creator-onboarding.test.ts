import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  cleanup,
  createHarness,
  hasTestDatabase,
  loginAs,
  seedAccount,
  skipReason,
  unique,
  type Harness,
} from './helpers/apiHarness.js';

/**
 * Onboarding self-service: a MESMA conta do participante vira dona de uma comunidade.
 * Nao ha segundo login; o vinculo OWNER e o que muda.
 */
describe.skipIf(!hasTestDatabase)(`onboarding do criador ${hasTestDatabase ? '' : skipReason}`, () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
    await cleanup(h.owner);
  }, 120_000);

  afterAll(async () => {
    await cleanup(h.owner);
    await h.pool.end();
  });

  const criar = (cookie: string | null, body: object) => {
    const r = request(h.app).post('/api/creator/communities');
    return (cookie ? r.set('Cookie', cookie) : r).send(body);
  };

  it('exige sessao', async () => {
    expect((await criar(null, { name: 'Sem Sessao', slug: unique('ss-') })).status).toBe(401);
  });

  it('participante vira dono: comunidade, vinculo OWNER, marca e evento nascem juntos', async () => {
    const conta = await seedAccount(h.owner);
    const { cookie } = await loginAs(h, conta);
    const slug = unique('criador-');

    const res = await criar(cookie, { name: 'Clube do Criador', slug, contact: { whatsapp: '+55 11 99999-0000' } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ slug, name: 'Clube do Criador', status: 'ACTIVE', created: true });

    const vinculo = await h.owner.query<{ role: string; accepted: boolean }>(
      'SELECT role::text, accepted_at IS NOT NULL AS accepted FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [res.body.id, conta.userId],
    );
    expect(vinculo.rows).toEqual([{ role: 'OWNER', accepted: true }]);

    const marca = await h.owner.query<{ public_name: string; contact: Record<string, string> }>(
      'SELECT public_name, contact FROM tenant_branding WHERE tenant_id = $1',
      [res.body.id],
    );
    expect(marca.rows[0]).toMatchObject({ public_name: 'Clube do Criador', contact: { whatsapp: '+55 11 99999-0000' } });

    const evento = await h.owner.query<{ event_type: string }>(
      "SELECT event_type FROM outbox WHERE payload->>'tenantId' = $1",
      [res.body.id],
    );
    expect(evento.rows.map((e) => e.event_type)).toContain('tenant.created');

    const auditoria = await h.owner.query<{ action: string }>(
      "SELECT action FROM audit_events WHERE actor_user_id = $1 AND action = 'tenant.created_self_service'",
      [conta.userId],
    );
    expect(auditoria.rows).toHaveLength(1);

    // A sessao ja reconhece o vinculo (sem outra senha, sem outra conta).
    const sessao = await request(h.app).get('/api/auth/session').set('Cookie', cookie);
    expect(sessao.body.memberships.map((m: { tenantSlug?: string; slug?: string }) => m.tenantSlug ?? m.slug)).toContain(slug);
  });

  it('duplo clique CONCORRENTE nao duplica: uma criacao e uma devolucao da mesma comunidade', async () => {
    const conta = await seedAccount(h.owner);
    const slug = unique('retry-');
    const chamar = () =>
      h.owner.query<{ tenant_id: string; created: boolean }>(
        'SELECT tenant_id, created FROM app.create_own_community($1, $2, $3, $4::jsonb, 3)',
        [conta.userId, slug, 'Comunidade Retry', '{}'],
      );
    // Duas conexoes DIFERENTES ao mesmo tempo: o indice unico decide a corrida.
    const [a, b] = await Promise.all([chamar(), chamar()]);

    expect(a.rows[0]!.tenant_id).toBe(b.rows[0]!.tenant_id);
    expect([a.rows[0]!.created, b.rows[0]!.created].sort()).toEqual([false, true]);
    const { rows } = await h.owner.query<{ n: string }>('SELECT count(*) AS n FROM tenants WHERE slug = $1', [slug]);
    expect(Number(rows[0]!.n)).toBe(1);
    const vinculos = await h.owner.query<{ n: string }>("SELECT count(*) AS n FROM memberships WHERE tenant_id = $1 AND role = 'OWNER'", [a.rows[0]!.tenant_id]);
    expect(Number(vinculos.rows[0]!.n)).toBe(1);
  });

  it('depois da primeira comunidade a conta e DONA: RN12 passa a valer e a rota exige o MFA, em vez de criar outra', async () => {
    const conta = await seedAccount(h.owner);
    const { cookie } = await loginAs(h, conta);
    expect((await criar(cookie, { name: 'Primeira', slug: unique('primeira-') })).status).toBe(201);
    const outra = await criar(cookie, { name: 'Segunda', slug: unique('segunda-') });
    expect(outra.status).toBe(403);
  });

  it('a funcao e idempotente por SQL: repetir devolve a existente (created=false)', async () => {
    const conta = await seedAccount(h.owner);
    const slug = unique('sql-');
    const chamar = () =>
      h.owner.query<{ tenant_id: string; created: boolean }>(
        'SELECT tenant_id, created FROM app.create_own_community($1, $2, $3, $4::jsonb, 3)',
        [conta.userId, slug, 'Por SQL', '{}'],
      );
    const a = await chamar();
    const b = await chamar();
    expect(a.rows[0]!.created).toBe(true);
    expect(b.rows[0]).toEqual({ tenant_id: a.rows[0]!.tenant_id, created: false });
  });

  it('identificador de OUTRA pessoa e conflito (409) e nao da acesso nenhum', async () => {
    const dona = await seedAccount(h.owner);
    const intruso = await seedAccount(h.owner);
    const slug = unique('alheio-');
    const a = await criar((await loginAs(h, dona)).cookie, { name: 'Da Dona', slug });
    expect(a.status).toBe(201);

    const { cookie } = await loginAs(h, intruso);
    const b = await criar(cookie, { name: 'Do Intruso', slug });
    expect(b.status).toBe(409);
    const vinculo = await h.owner.query('SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2', [a.body.id, intruso.userId]);
    expect(vinculo.rowCount).toBe(0);

    // Trocar slug/header nao abre a comunidade alheia.
    const ctx = await request(h.app).get('/api/tenant/context').set('Cookie', cookie).set('x-tenant-slug', slug);
    expect(ctx.status).toBe(404);
  });

  it('endereco reservado, formato invalido e campos extras sao recusados; nao ha como indicar outro dono', async () => {
    const { cookie } = await loginAs(h, await seedAccount(h.owner));
    expect((await criar(cookie, { name: 'Admin', slug: 'admin' })).status).toBe(400);
    expect((await criar(cookie, { name: 'Maiusculas', slug: '-ruim-' })).status).toBe(400);
    expect((await criar(cookie, { name: 'Curto', slug: 'ab' })).status).toBe(400);
    expect((await criar(cookie, { name: 'Dono Alheio', slug: unique('x-'), ownerEmail: 'outra@example.com' })).status).toBe(201);
    // `ownerEmail` e ignorado (nao existe no contrato): o OWNER e sempre quem esta na sessao.
    const { rows } = await h.owner.query<{ n: string }>(
      "SELECT count(*) AS n FROM memberships WHERE role = 'OWNER' AND user_id NOT IN (SELECT id FROM users WHERE email LIKE 'user-%@example.com')",
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('limite de comunidades por criador', async () => {
    const conta = await seedAccount(h.owner);
    const limite = h.config.CREATOR_MAX_COMMUNITIES;
    const chamar = (slug: string) =>
      h.owner.query('SELECT * FROM app.create_own_community($1, $2, $3, $4::jsonb, $5)', [conta.userId, slug, 'Limite', '{}', limite]);
    for (let i = 0; i < limite; i += 1) await chamar(unique(`lim${i}-`));
    await expect(chamar(unique('lim-x-'))).rejects.toThrow(/limite de comunidades/);
  });

  it('conta inativa nao cria comunidade', async () => {
    const conta = await seedAccount(h.owner);
    const { cookie } = await loginAs(h, conta);
    await h.owner.query("UPDATE users SET status = 'DISABLED' WHERE id = $1", [conta.userId]);
    const res = await criar(cookie, { name: 'Inativa', slug: unique('inat-') });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('o dono recem-criado entra no fluxo de MFA (enrollment), nao fica preso', async () => {
    const conta = await seedAccount(h.owner);
    await criar((await loginAs(h, conta)).cookie, { name: 'Com MFA', slug: unique('mfa-') });
    const login = await request(h.app).post('/api/auth/login').send({ email: conta.email, password: conta.password });
    expect(login.status).toBe(200);
    expect(login.body.status).toBe('mfa_enrollment_required');
  });
});
