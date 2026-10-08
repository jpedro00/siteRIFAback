import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  cleanup,
  createHarness,
  hasTestDatabase,
  sessionCookieFrom,
  skipReason,
  unique,
  type Harness,
} from './helpers/apiHarness.js';

/**
 * Jornada completa de uma conta NOVA: cadastro -> login -> sessao -> logout -> sessao negada.
 * Cobre a identidade global: a mesma conta e a do participante, sem sistema de login separado.
 */
describe.skipIf(!hasTestDatabase)(`jornada de autenticacao ${hasTestDatabase ? '' : skipReason}`, () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await cleanup(h.owner);
    await h.pool.end();
  });

  it('cadastro, login, sessao, logout e sessao negada depois', async () => {
    const email = `${unique('jornada-')}@example.com`;
    const password = 'Senha-Muito-Boa-2026!';

    const cadastro = await request(h.app)
      .post('/api/auth/register')
      .send({ displayName: 'Pessoa da Jornada', email, password, passwordConfirmation: password });
    expect(cadastro.status).toBe(201);

    const errada = await request(h.app).post('/api/auth/login').send({ email, password: 'outra-senha-qualquer' });
    expect(errada.status).toBe(401);

    const login = await request(h.app).post('/api/auth/login').send({ email, password });
    expect(login.status).toBe(200);
    const cookie = sessionCookieFrom(login, h.config.SESSION_COOKIE_NAME);

    const sessao = await request(h.app).get('/api/auth/session').set('Cookie', cookie);
    expect(sessao.status).toBe(200);
    expect(sessao.body.user.email).toBe(email);

    const logout = await request(h.app).post('/api/auth/logout').set('Cookie', cookie);
    expect(logout.status).toBeLessThan(300);

    const depois = await request(h.app).get('/api/auth/session').set('Cookie', cookie);
    expect(depois.status).toBe(401);
  });

  it('e-mail em outra caixa e com espacos nas pontas entra na mesma conta (a identidade e global e normalizada)', async () => {
    const base = `${unique('caixa-login-')}@example.com`;
    const password = 'Senha-Muito-Boa-2026!';
    await request(h.app)
      .post('/api/auth/register')
      .send({ displayName: 'Caixa Alta', email: base, password, passwordConfirmation: password });
    const login = await request(h.app).post('/api/auth/login').send({ email: ` ${base.toUpperCase()} `, password });
    expect(login.status).toBe(200);
  });
});
