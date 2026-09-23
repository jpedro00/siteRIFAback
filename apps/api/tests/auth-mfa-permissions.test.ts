import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  cleanup,
  confirmMfaEnrollment,
  createHarness,
  currentCode,
  grantMembership,
  grantPlatformRole,
  hasTestDatabase,
  identityAuditActions,
  loginAs,
  seedAccount,
  seedConfirmedTotp,
  seedTenantWithSlug,
  skipReason,
  unique,
  verifyMfa,
  TEST_CORS_ORIGINS,
  type Harness,
} from './helpers/apiHarness.js';

/**
 * Autenticacao, MFA (RN12), matriz de permissoes (DOC-01 secao 3) e revogacao.
 * Secao 8 do pedido, itens 5, 6, 7 e 8.
 */
describe.skipIf(!hasTestDatabase)(`API · autenticacao e autorizacao ${
  hasTestDatabase ? '' : skipReason
}`, () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
    await cleanup(harness.owner);
  });

  afterAll(async () => {
    await harness?.close();
  });

  // -------------------------------------------------------------------------
  // Autenticacao real
  // -------------------------------------------------------------------------
  describe('autenticacao', () => {
    it('login com senha correta abre sessao com cookie httpOnly', async () => {
      const account = await seedAccount(harness.owner);
      const res = await request(harness.app)
        .post('/api/auth/login')
        .send({ email: account.email, password: account.password });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('authenticated');

      const cookies = res.headers['set-cookie'] as unknown as string[];
      const sessionCookie = cookies.find((c) =>
        c.startsWith(`${harness.config.SESSION_COOKIE_NAME}=`),
      );
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie).toContain('HttpOnly');
      expect(sessionCookie).toContain('SameSite=Lax');
    });

    it('o token de sessao NAO aparece no corpo da resposta', async () => {
      const account = await seedAccount(harness.owner);
      const res = await request(harness.app)
        .post('/api/auth/login')
        .send({ email: account.email, password: account.password });
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/token/i);
    });

    it('senha errada e e-mail inexistente devolvem a MESMA resposta', async () => {
      const account = await seedAccount(harness.owner);

      const wrongPassword = await request(harness.app)
        .post('/api/auth/login')
        .send({ email: account.email, password: 'senha-errada' });
      const noSuchUser = await request(harness.app)
        .post('/api/auth/login')
        .send({ email: `${unique('ghost-')}@example.com`, password: 'qualquer' });

      expect(wrongPassword.status).toBe(401);
      expect(noSuchUser.status).toBe(401);
      expect(wrongPassword.body).toEqual(noSuchUser.body);
    });

    it('sem cookie, rota autenticada devolve 401', async () => {
      const res = await request(harness.app).get('/api/auth/session');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('cookie forjado nao autentica', async () => {
      const res = await request(harness.app)
        .get('/api/auth/session')
        .set('Cookie', `${harness.config.SESSION_COOKIE_NAME}=token-inventado`);
      expect(res.status).toBe(401);
    });

    it('tentativas repetidas bloqueiam a conta temporariamente', async () => {
      const account = await seedAccount(harness.owner);
      for (let i = 0; i < harness.config.LOGIN_MAX_ATTEMPTS; i += 1) {
        await request(harness.app)
          .post('/api/auth/login')
          .send({ email: account.email, password: 'errada' });
      }

      // O bloqueio e REAL: nem a senha correta abre sessao enquanto durar.
      const res = await request(harness.app)
        .post('/api/auth/login')
        .send({ email: account.email, password: account.password });
      expect(res.status).toBe(401);

      const { rows } = await harness.owner.query<{ locked_until: string | null }>(
        'SELECT locked_until FROM user_credentials WHERE user_id = $1',
        [account.userId],
      );
      expect(rows[0]?.locked_until, 'a conta deveria estar bloqueada no banco').not.toBeNull();

      const sessions = await harness.owner.query('SELECT 1 FROM sessions WHERE user_id = $1', [
        account.userId,
      ]);
      expect(sessions.rows).toHaveLength(0);
    });

    it('a conta BLOQUEADA responde igual a um e-mail inexistente', async () => {
      // Devolver 429 aqui entregaria uma lista de e-mails validos: bastaria
      // gastar as tentativas de um endereco e ler o codigo de status.
      const account = await seedAccount(harness.owner);
      for (let i = 0; i < harness.config.LOGIN_MAX_ATTEMPTS; i += 1) {
        await request(harness.app)
          .post('/api/auth/login')
          .send({ email: account.email, password: 'errada' });
      }

      const locked = await request(harness.app)
        .post('/api/auth/login')
        .send({ email: account.email, password: account.password });
      const ghost = await request(harness.app)
        .post('/api/auth/login')
        .send({ email: `${unique('ghost-')}@example.com`, password: account.password });

      expect(locked.status).toBe(ghost.status);
      expect(locked.body).toEqual(ghost.body);
      expect(locked.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('insistir numa conta bloqueada NAO estende o bloqueio', async () => {
      // Contabilizar a tentativa de quem ja esta bloqueado empurraria
      // `locked_until` para frente a cada requisicao: qualquer um manteria uma
      // conta conhecida trancada para sempre, apenas insistindo.
      const account = await seedAccount(harness.owner);
      for (let i = 0; i < harness.config.LOGIN_MAX_ATTEMPTS; i += 1) {
        await request(harness.app)
          .post('/api/auth/login')
          .send({ email: account.email, password: 'errada' });
      }

      const readLock = async (): Promise<string> => {
        const { rows } = await harness.owner.query<{ locked_until: string }>(
          'SELECT locked_until FROM user_credentials WHERE user_id = $1',
          [account.userId],
        );
        return rows[0]!.locked_until;
      };

      const before = await readLock();
      for (let i = 0; i < 3; i += 1) {
        await request(harness.app)
          .post('/api/auth/login')
          .send({ email: account.email, password: 'errada-de-novo' });
      }
      expect(await readLock()).toBe(before);
    });

    it('a conta INATIVA responde igual a um e-mail inexistente', async () => {
      const account = await seedAccount(harness.owner);
      await harness.owner.query("UPDATE users SET status = 'DISABLED' WHERE id = $1", [
        account.userId,
      ]);

      const inactive = await request(harness.app)
        .post('/api/auth/login')
        .send({ email: account.email, password: account.password });
      const ghost = await request(harness.app)
        .post('/api/auth/login')
        .send({ email: `${unique('ghost-')}@example.com`, password: account.password });

      expect(inactive.status).toBe(ghost.status);
      expect(inactive.body).toEqual(ghost.body);
    });
  });

  // -------------------------------------------------------------------------
  // Item 8 · revogacao
  // -------------------------------------------------------------------------
  describe('item 8 · revogacao impede reutilizacao do acesso', () => {
    it('logout invalida o cookie na requisicao seguinte', async () => {
      const account = await seedAccount(harness.owner);
      const { cookie } = await loginAs(harness, account);

      const before = await request(harness.app).get('/api/auth/session').set('Cookie', cookie);
      expect(before.status).toBe(200);

      const logout = await request(harness.app).post('/api/auth/logout').set('Cookie', cookie);
      expect(logout.status).toBe(204);

      // O MESMO cookie, reapresentado, nao vale mais.
      const after = await request(harness.app).get('/api/auth/session').set('Cookie', cookie);
      expect(after.status).toBe(401);
    });

    it('logout-all revoga todas as sessoes abertas', async () => {
      const account = await seedAccount(harness.owner);
      const first = await loginAs(harness, account);
      const second = await loginAs(harness, account);

      const res = await request(harness.app)
        .post('/api/auth/logout-all')
        .set('Cookie', second.cookie);
      expect(res.status).toBe(200);
      expect(res.body.revoked).toBeGreaterThanOrEqual(2);

      for (const cookie of [first.cookie, second.cookie]) {
        const check = await request(harness.app).get('/api/auth/session').set('Cookie', cookie);
        expect(check.status).toBe(401);
      }
    });

    it('sessao revogada no banco para de valer imediatamente', async () => {
      const account = await seedAccount(harness.owner);
      const { cookie } = await loginAs(harness, account);

      await harness.owner.query(
        "UPDATE sessions SET revoked_at = now(), revoked_reason = 'teste' WHERE user_id = $1",
        [account.userId],
      );

      const res = await request(harness.app).get('/api/auth/session').set('Cookie', cookie);
      expect(res.status).toBe(401);
    });

    it('sessao expirada nao vale', async () => {
      const account = await seedAccount(harness.owner);
      const { cookie } = await loginAs(harness, account);

      // `sessions_expires_after_creation` exige expires_at > created_at.
      // Envelhecer so o expires_at violaria a CHECK; a sessao precisa ser
      // envelhecida por inteiro, como uma sessao antiga de verdade.
      await harness.owner.query(
        `UPDATE sessions
            SET created_at = now() - interval '2 hours',
                expires_at = now() - interval '1 hour'
          WHERE user_id = $1`,
        [account.userId],
      );

      const res = await request(harness.app).get('/api/auth/session').set('Cookie', cookie);
      expect(res.status).toBe(401);
    });

    it('revogar o vinculo tira o acesso ao painel na requisicao seguinte', async () => {
      const slug = unique('rev-');
      const tenantId = await seedTenantWithSlug(harness.owner, slug);
      const account = await seedAccount(harness.owner);
      await grantMembership(harness.owner, { tenantId, userId: account.userId, role: 'MARKETING' });

      const { cookie } = await loginAs(harness, account);

      const before = await request(harness.app)
        .get('/api/tenant/context')
        .set('Cookie', cookie)
        .set('x-tenant-slug', slug);
      expect(before.status).toBe(200);

      await harness.owner.query(
        'UPDATE memberships SET revoked_at = now() WHERE tenant_id = $1 AND user_id = $2',
        [tenantId, account.userId],
      );

      const after = await request(harness.app)
        .get('/api/tenant/context')
        .set('Cookie', cookie)
        .set('x-tenant-slug', slug);
      expect(after.status).toBe(404);
      expect(after.body.error.code).toBe('TENANT_ACCESS_DENIED');
    });
  });

  // -------------------------------------------------------------------------
  // Item 6 · MFA obrigatorio (RN12)
  // -------------------------------------------------------------------------
  describe('item 6 · RN12 · MFA obrigatorio para dono, financeiro e Super Admin', () => {
    async function accountWithRole(role: string, platform = false) {
      const slug = unique('mfa-');
      const tenantId = await seedTenantWithSlug(harness.owner, slug);
      const account = await seedAccount(harness.owner);
      if (platform) {
        await grantPlatformRole(harness.owner, { userId: account.userId, role });
      } else {
        await grantMembership(harness.owner, { tenantId, userId: account.userId, role });
      }
      return { account, tenantId, slug };
    }

    it('DONO sem fator cadastrado recebe mfa_enrollment_required no login', async () => {
      const { account } = await accountWithRole('OWNER');
      const { status } = await loginAs(harness, account);
      expect(status).toBe('mfa_enrollment_required');
    });

    it('FINANCEIRO sem fator cadastrado recebe mfa_enrollment_required', async () => {
      const { account } = await accountWithRole('FINANCE');
      const { status } = await loginAs(harness, account);
      expect(status).toBe('mfa_enrollment_required');
    });

    it('SUPER ADMIN sem fator cadastrado recebe mfa_enrollment_required', async () => {
      const { account } = await accountWithRole('PLATFORM_OPERATIONS', true);
      const { status } = await loginAs(harness, account);
      expect(status).toBe('mfa_enrollment_required');
    });

    it('DONO sem MFA satisfeito NAO acessa o painel da comunidade', async () => {
      const { account, slug } = await accountWithRole('OWNER');
      const { cookie } = await loginAs(harness, account);

      const res = await request(harness.app)
        .get('/api/tenant/context')
        .set('Cookie', cookie)
        .set('x-tenant-slug', slug);

      expect(res.status).toBe(403);
      expect(['MFA_REQUIRED', 'MFA_ENROLLMENT_REQUIRED']).toContain(res.body.error.code);
    });

    it('FINANCEIRO sem MFA satisfeito NAO acessa o painel', async () => {
      const { account, slug } = await accountWithRole('FINANCE');
      const { cookie } = await loginAs(harness, account);
      const res = await request(harness.app)
        .get('/api/tenant/context')
        .set('Cookie', cookie)
        .set('x-tenant-slug', slug);
      expect(res.status).toBe(403);
    });

    it('SUPER ADMIN sem MFA satisfeito NAO lista comunidades', async () => {
      const { account } = await accountWithRole('PLATFORM_OPERATIONS', true);
      const { cookie } = await loginAs(harness, account);
      const res = await request(harness.app).get('/api/platform/tenants').set('Cookie', cookie);
      expect(res.status).toBe(403);
      expect(['MFA_REQUIRED', 'MFA_ENROLLMENT_REQUIRED']).toContain(res.body.error.code);
    });

    it('SUPER ADMIN sem MFA satisfeito NAO cria comunidade', async () => {
      const { account } = await accountWithRole('PLATFORM_OPERATIONS', true);
      const { cookie } = await loginAs(harness, account);
      const res = await request(harness.app)
        .post('/api/platform/tenants')
        .set('Cookie', cookie)
        .send({ slug: unique('novo-'), name: 'Nova Comunidade' });
      expect(res.status).toBe(403);
    });

    it('com fator confirmado, login pede verificacao e o codigo correto libera', async () => {
      const { account, slug } = await accountWithRole('OWNER');
      const secret = await seedConfirmedTotp(harness.owner, account.userId);

      const login = await loginAs(harness, account);
      expect(login.status).toBe('mfa_required');

      const blocked = await request(harness.app)
        .get('/api/tenant/context')
        .set('Cookie', login.cookie)
        .set('x-tenant-slug', slug);
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('MFA_REQUIRED');

      // A elevacao rotaciona o token: quem segue e o cookie NOVO.
      const verified = await verifyMfa(harness, login.cookie, await currentCode(secret));
      expect(verified.status).toBe(200);

      const allowed = await request(harness.app)
        .get('/api/tenant/context')
        .set('Cookie', verified.cookie)
        .set('x-tenant-slug', slug);
      expect(allowed.status).toBe(200);
      expect(allowed.body.roles).toContain('OWNER');
    });

    it('codigo TOTP errado nao satisfaz o segundo fator', async () => {
      const { account } = await accountWithRole('OWNER');
      await seedConfirmedTotp(harness.owner, account.userId);
      const login = await loginAs(harness, account);

      const res = await request(harness.app)
        .post('/api/auth/mfa/verify')
        .set('Cookie', login.cookie)
        .send({ code: '000000' });
      expect(res.status).toBe(401);
    });

    it('o mesmo codigo nao vale duas vezes (replay)', async () => {
      const { account } = await accountWithRole('OWNER');
      const secret = await seedConfirmedTotp(harness.owner, account.userId);
      const login = await loginAs(harness, account);
      const code = await currentCode(secret);

      const first = await request(harness.app)
        .post('/api/auth/mfa/verify')
        .set('Cookie', login.cookie)
        .send({ code });
      expect(first.status).toBe(200);

      const second = await loginAs(harness, account);
      const replay = await request(harness.app)
        .post('/api/auth/mfa/verify')
        .set('Cookie', second.cookie)
        .send({ code });
      expect(replay.status).toBe(401);
    });

    it('tentativas erradas de codigo bloqueiam o segundo fator', async () => {
      // Um codigo TOTP tem 10^6 combinacoes e quem chega aqui ja tem a senha.
      // Sem limite, o segundo fator seria so um atraso.
      const { account } = await accountWithRole('OWNER');
      await seedConfirmedTotp(harness.owner, account.userId);
      const login = await loginAs(harness, account);

      for (let i = 0; i < harness.config.LOGIN_MAX_ATTEMPTS; i += 1) {
        const res = await request(harness.app)
          .post('/api/auth/mfa/verify')
          .set('Cookie', login.cookie)
          .send({ code: '000000' });
        expect(res.status).toBe(401);
      }

      const blocked = await request(harness.app)
        .post('/api/auth/mfa/verify')
        .set('Cookie', login.cookie)
        .send({ code: '000000' });
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
    });

    it('a contagem de tentativas do MFA sobrevive ao erro (nao volta no rollback)', async () => {
      const { account } = await accountWithRole('OWNER');
      await seedConfirmedTotp(harness.owner, account.userId);
      const login = await loginAs(harness, account);

      await request(harness.app)
        .post('/api/auth/mfa/verify')
        .set('Cookie', login.cookie)
        .send({ code: '000000' });

      const { rows } = await harness.owner.query<{ mfa_failed_attempts: number }>(
        'SELECT mfa_failed_attempts FROM user_credentials WHERE user_id = $1',
        [account.userId],
      );
      expect(rows[0]?.mfa_failed_attempts).toBe(1);
    });

    it('acertar o codigo zera o contador de tentativas', async () => {
      const { account } = await accountWithRole('OWNER');
      const secret = await seedConfirmedTotp(harness.owner, account.userId);
      const login = await loginAs(harness, account);

      await request(harness.app)
        .post('/api/auth/mfa/verify')
        .set('Cookie', login.cookie)
        .send({ code: '000000' });

      const ok = await request(harness.app)
        .post('/api/auth/mfa/verify')
        .set('Cookie', login.cookie)
        .send({ code: await currentCode(secret) });
      expect(ok.status).toBe(200);

      const { rows } = await harness.owner.query<{ mfa_failed_attempts: number }>(
        'SELECT mfa_failed_attempts FROM user_credentials WHERE user_id = $1',
        [account.userId],
      );
      expect(rows[0]?.mfa_failed_attempts).toBe(0);
    });

    it('MFA satisfeito numa sessao NAO satisfaz outra sessao', async () => {
      const { account, slug } = await accountWithRole('OWNER');
      const secret = await seedConfirmedTotp(harness.owner, account.userId);

      const sessionA = await loginAs(harness, account);
      await request(harness.app)
        .post('/api/auth/mfa/verify')
        .set('Cookie', sessionA.cookie)
        .send({ code: await currentCode(secret) });

      const sessionB = await loginAs(harness, account);
      const res = await request(harness.app)
        .get('/api/tenant/context')
        .set('Cookie', sessionB.cookie)
        .set('x-tenant-slug', slug);
      expect(res.status).toBe(403);
    });

    it('o cadastro do segundo fator fica acessivel a quem ainda nao tem fator', async () => {
      const { account } = await accountWithRole('OWNER');
      const { cookie } = await loginAs(harness, account);

      const start = await request(harness.app).post('/api/auth/mfa/enroll').set('Cookie', cookie);
      expect(start.status).toBe(200);
      expect(typeof start.body.secret).toBe('string');
      expect(start.body.otpauthUri).toContain('otpauth://totp/');

      const confirmed = await confirmMfaEnrollment(
        harness,
        cookie,
        await currentCode(start.body.secret),
      );
      expect(confirmed.status).toBe(200);

      // Cadastrar e confirmar ja satisfaz o fator na sessao corrente — mas a
      // confirmacao ELEVA a sessao, entao quem segue e o cookie rotacionado.
      const session = await request(harness.app)
        .get('/api/auth/session')
        .set('Cookie', confirmed.cookie);
      expect(session.body.mfaSatisfied).toBe(true);
      expect(session.body.mfaEnrolled).toBe(true);
    });

    it('marketing, suporte e operador entram sem MFA', async () => {
      for (const role of ['MARKETING', 'SUPPORT', 'OPERATOR']) {
        const slug = unique('nomfa-');
        const tenantId = await seedTenantWithSlug(harness.owner, slug);
        const account = await seedAccount(harness.owner);
        await grantMembership(harness.owner, { tenantId, userId: account.userId, role });

        const { cookie, status } = await loginAs(harness, account);
        expect(status, `${role} nao deveria exigir MFA`).toBe('authenticated');

        const res = await request(harness.app)
          .get('/api/tenant/context')
          .set('Cookie', cookie)
          .set('x-tenant-slug', slug);
        expect(res.status, `${role} deveria acessar o painel`).toBe(200);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Item 7 · matriz da secao 3 aplicada no backend
  // -------------------------------------------------------------------------
  describe('item 7 · suporte, marketing e operador respeitam a matriz', () => {
    it('as permissoes devolvidas seguem a matriz do DOC-01 secao 3', async () => {
      const esperado: Record<string, { tem: string[]; naoTem: string[] }> = {
        SUPPORT: {
          tem: ['payment:read:status', 'buyer:read:full', 'support:act'],
          naoTem: ['payment:read:full', 'payment:refund', 'draw:write', 'team:manage'],
        },
        MARKETING: {
          tem: ['draw:write', 'draw:media:write', 'branding:write'],
          naoTem: [
            'payment:read:full',
            'payment:read:status',
            'buyer:read:full',
            'draw:lifecycle:write',
          ],
        },
        OPERATOR: {
          tem: ['draw:write', 'draw:lifecycle:write', 'payment:read:status', 'support:act'],
          naoTem: ['payment:read:full', 'payment:refund', 'buyer:read:full', 'branding:write'],
        },
      };

      for (const [role, expectation] of Object.entries(esperado)) {
        const slug = unique('mtx-');
        const tenantId = await seedTenantWithSlug(harness.owner, slug);
        const account = await seedAccount(harness.owner);
        await grantMembership(harness.owner, { tenantId, userId: account.userId, role });

        const { cookie } = await loginAs(harness, account);
        const res = await request(harness.app)
          .get('/api/tenant/context')
          .set('Cookie', cookie)
          .set('x-tenant-slug', slug);

        expect(res.status).toBe(200);
        const permissions: string[] = res.body.permissions;
        for (const permission of expectation.tem) {
          expect(permissions, `${role} deveria ter ${permission}`).toContain(permission);
        }
        for (const permission of expectation.naoTem) {
          expect(permissions, `${role} NAO deveria ter ${permission}`).not.toContain(permission);
        }
      }
    });

    it('rota que exige team:manage e negada a quem nao e dono', async () => {
      const slug = unique('audit-');
      const tenantId = await seedTenantWithSlug(harness.owner, slug);

      for (const role of ['SUPPORT', 'MARKETING', 'OPERATOR']) {
        const account = await seedAccount(harness.owner);
        await grantMembership(harness.owner, { tenantId, userId: account.userId, role });
        const { cookie } = await loginAs(harness, account);

        const res = await request(harness.app)
          .get('/api/tenant/audit-events')
          .set('Cookie', cookie)
          .set('x-tenant-slug', slug);

        // A rota exige MFA (RN12) e team:manage. Nenhum dos tres papeis passa.
        expect([403]).toContain(res.status);
      }
    });

    it('esconder o botao nao basta: a rota nega no backend', async () => {
      // O operador nao tem team:manage; a chamada direta a API e recusada,
      // independentemente de o painel exibir ou nao o botao.
      const slug = unique('backend-');
      const tenantId = await seedTenantWithSlug(harness.owner, slug);
      const account = await seedAccount(harness.owner);
      await grantMembership(harness.owner, { tenantId, userId: account.userId, role: 'OPERATOR' });
      const { cookie } = await loginAs(harness, account);

      const res = await request(harness.app)
        .get('/api/tenant/audit-events')
        .set('Cookie', cookie)
        .set('x-tenant-slug', slug);
      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Item 5 · usuario sem vinculo
  // -------------------------------------------------------------------------
  describe('item 5 · usuario sem vinculo nao acessa o painel', () => {
    it('usuario autenticado sem vinculo recebe 404 (nao 403)', async () => {
      const slug = unique('semvinculo-');
      await seedTenantWithSlug(harness.owner, slug);
      const outsider = await seedAccount(harness.owner);
      const { cookie } = await loginAs(harness, outsider);

      const res = await request(harness.app)
        .get('/api/tenant/context')
        .set('Cookie', cookie)
        .set('x-tenant-slug', slug);

      // 404 de proposito: um 403 confirmaria que a comunidade existe.
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('TENANT_ACCESS_DENIED');
    });

    it('usuario da comunidade A recebe 404 ao pedir a comunidade B', async () => {
      const slugA = unique('a-');
      const slugB = unique('b-');
      const tenantA = await seedTenantWithSlug(harness.owner, slugA);
      await seedTenantWithSlug(harness.owner, slugB);

      const account = await seedAccount(harness.owner);
      await grantMembership(harness.owner, {
        tenantId: tenantA,
        userId: account.userId,
        role: 'SUPPORT',
      });
      const { cookie } = await loginAs(harness, account);

      const ownTenant = await request(harness.app)
        .get('/api/tenant/context')
        .set('Cookie', cookie)
        .set('x-tenant-slug', slugA);
      expect(ownTenant.status).toBe(200);

      const otherTenant = await request(harness.app)
        .get('/api/tenant/context')
        .set('Cookie', cookie)
        .set('x-tenant-slug', slugB);
      expect(otherTenant.status).toBe(404);
    });

    it('papel de comunidade NAO concede acesso de plataforma', async () => {
      const slug = unique('dono-');
      const tenantId = await seedTenantWithSlug(harness.owner, slug);
      const account = await seedAccount(harness.owner);
      await grantMembership(harness.owner, { tenantId, userId: account.userId, role: 'OWNER' });
      const secret = await seedConfirmedTotp(harness.owner, account.userId);

      const { cookie } = await loginAs(harness, account);
      const elevado = await verifyMfa(harness, cookie, await currentCode(secret));
      expect(elevado.status).toBe(200);

      // Dono da comunidade, com MFA satisfeito: ainda assim nao e Super Admin.
      const res = await request(harness.app)
        .get('/api/platform/tenants')
        .set('Cookie', elevado.cookie);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('revogar privilegio de plataforma tem efeito imediato', () => {
    it('Super Admin revogado perde acesso na requisicao seguinte', async () => {
      const account = await seedAccount(harness.owner);
      await grantPlatformRole(harness.owner, {
        userId: account.userId,
        role: 'PLATFORM_OPERATIONS',
      });
      const secret = await seedConfirmedTotp(harness.owner, account.userId);

      const { cookie } = await loginAs(harness, account);
      const elevado = await verifyMfa(harness, cookie, await currentCode(secret));
      expect(elevado.status).toBe(200);

      const before = await request(harness.app)
        .get('/api/platform/tenants')
        .set('Cookie', elevado.cookie);
      expect(before.status).toBe(200);

      await harness.owner.query(
        'UPDATE platform_admins SET revoked_at = now() WHERE user_id = $1',
        [account.userId],
      );

      const after = await request(harness.app)
        .get('/api/platform/tenants')
        .set('Cookie', elevado.cookie);
      expect(after.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Resolucao de comunidade
  // -------------------------------------------------------------------------
  describe('resolucao de comunidade', () => {
    it('slug desconhecido devolve 404, nunca uma comunidade padrao', async () => {
      const res = await request(harness.app)
        .get('/api/public/tenant')
        .set('x-tenant-slug', 'comunidade-que-nao-existe');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('TENANT_NOT_RESOLVED');
    });

    it('host desconhecido devolve 404, nunca uma comunidade padrao', async () => {
      const res = await request(harness.app)
        .get('/api/public/tenant')
        .set('Host', 'dominio-desconhecido.example');
      expect(res.status).toBe(404);
    });

    it('host desconhecido NAO e salvo pelo cabecalho quando ele esta desligado', async () => {
      // Com TENANT_HEADER_ENABLED desligado (o padrao, e o de producao), o
      // cabecalho e ignorado: o host volta a ser a unica fonte da comunidade.
      const slug = unique('gated-');
      await seedTenantWithSlug(harness.owner, slug);

      const strict = await createHarness({ tenantHeaderEnabled: false });
      try {
        const res = await request(strict.app)
          .get('/api/public/tenant')
          .set('Host', 'host-desconhecido.example')
          .set('x-tenant-slug', slug);

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('TENANT_NOT_RESOLVED');
      } finally {
        await strict.close();
      }
    });

    it('a vitrine publica devolve a marca sem exigir sessao', async () => {
      const slug = unique('vitrine-');
      await seedTenantWithSlug(harness.owner, slug, 'Comunidade Vitrine');

      const res = await request(harness.app).get('/api/public/tenant').set('x-tenant-slug', slug);
      expect(res.status).toBe(200);
      expect(res.body.slug).toBe(slug);
      expect(res.body.name).toBe('Comunidade Vitrine');
    });

    it('a vitrine publica nao expoe dado de negocio nem pessoal', async () => {
      const slug = unique('vitrine2-');
      await seedTenantWithSlug(harness.owner, slug);
      const res = await request(harness.app).get('/api/public/tenant').set('x-tenant-slug', slug);

      const keys = Object.keys(res.body);
      for (const proibido of ['memberships', 'users', 'roles', 'permissions', 'auditEvents']) {
        expect(keys).not.toContain(proibido);
      }
    });

    it('subdominio {slug}.dominio-base resolve a comunidade', async () => {
      const slug = unique('sub-');
      await seedTenantWithSlug(harness.owner, slug);
      const res = await request(harness.app)
        .get('/api/public/tenant')
        .set('Host', `${slug}.plataforma.local`);
      expect(res.status).toBe(200);
      expect(res.body.slug).toBe(slug);
    });
  });

  // -------------------------------------------------------------------------
  // Controle de origem
  // -------------------------------------------------------------------------
  describe('controle de origem', () => {
    it('origem declarada em CORS_ORIGINS e aceita', async () => {
      const origin = harness.config.corsOrigins[0];
      expect(origin, 'a bancada precisa de ao menos uma origem declarada').toBeTruthy();

      const res = await request(harness.app).get('/api/health').set('Origin', origin!);
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('origem DESCONHECIDA e recusada com 403, nao apenas privada dos cabecalhos', async () => {
      // Omitir cabecalhos so impede o navegador de LER a resposta; a
      // requisicao ja teria sido executada.
      const res = await request(harness.app)
        .get('/api/health')
        .set('Origin', 'https://site-malicioso.example');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('escrita vinda de origem desconhecida nao chega a executar', async () => {
      const account = await seedAccount(harness.owner);
      const res = await request(harness.app)
        .post('/api/auth/login')
        .set('Origin', 'https://site-malicioso.example')
        .send({ email: account.email, password: account.password });

      expect(res.status).toBe(403);
      // Nenhuma sessao foi aberta.
      const sessions = await harness.owner.query('SELECT 1 FROM sessions WHERE user_id = $1', [
        account.userId,
      ]);
      expect(sessions.rows).toHaveLength(0);
    });

    it('requisicao SEM Origin nao e afetada', async () => {
      // `Origin` e posto pelo navegador; sua ausencia nao e origem cruzada.
      const res = await request(harness.app).get('/api/health');
      expect(res.status).toBe(200);
    });

    it('white-label: subdominio de comunidade existente e origem valida', async () => {
      // Uma lista estatica quebraria o dominio proprio: cada comunidade chama
      // a API de um lugar diferente.
      const slug = unique('origem-');
      await seedTenantWithSlug(harness.owner, slug);

      const res = await request(harness.app)
        .get('/api/health')
        .set('Origin', `https://${slug}.plataforma.local`);

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(`https://${slug}.plataforma.local`);
    });

    it('subdominio de comunidade INEXISTENTE e recusado', async () => {
      const res = await request(harness.app)
        .get('/api/health')
        .set('Origin', 'https://comunidade-que-nao-existe.plataforma.local');
      expect(res.status).toBe(403);
    });

    it('a allowlist e exatamente a lista declarada, nao um prefixo dela', async () => {
      // Um `startsWith` deixaria "https://organizer.test.atacante.example"
      // passar. A comparacao e por origem inteira.
      for (const origem of [
        `${TEST_CORS_ORIGINS[0]}.atacante.example`,
        `${TEST_CORS_ORIGINS[0]}evil`,
        'http://organizer.test', // esquema diferente
      ]) {
        const res = await request(harness.app).get('/api/health').set('Origin', origem);
        expect(res.status, `${origem} nao deveria ser aceita`).toBe(403);
      }
    });

    it('preflight de origem declarada responde 204 com os cabecalhos', async () => {
      const origin = TEST_CORS_ORIGINS[0];
      const res = await request(harness.app).options('/api/auth/login').set('Origin', origin);

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-allow-methods']).toContain('POST');
    });

    it('preflight de origem desconhecida e recusado', async () => {
      const res = await request(harness.app)
        .options('/api/auth/login')
        .set('Origin', 'https://site-malicioso.example');
      expect(res.status).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('a resposta liberada declara Vary: Origin', async () => {
      // Sem `Vary`, um cache intermediario serviria a resposta de uma origem
      // para outra — e o cabecalho de liberacao viajaria junto.
      const res = await request(harness.app).get('/api/health').set('Origin', TEST_CORS_ORIGINS[1]);
      expect(res.status).toBe(200);
      expect(res.headers['vary']).toContain('Origin');
    });
  });

  // -------------------------------------------------------------------------
  // Allowlist VAZIA: instalacao que nao declarou painel interno nenhum
  // -------------------------------------------------------------------------
  describe('controle de origem · allowlist vazia', () => {
    let semLista: Harness;

    beforeAll(async () => {
      semLista = await createHarness({ corsOrigins: [] });
    });

    afterAll(async () => {
      await semLista?.close();
    });

    it('lista vazia nao libera nada por omissao', async () => {
      // O erro que se quer evitar e o oposto do intuitivo: "lista vazia" nao
      // pode significar "sem restricao".
      for (const origem of [...TEST_CORS_ORIGINS, 'https://qualquer-coisa.example']) {
        const res = await request(semLista.app).get('/api/health').set('Origin', origem);
        expect(res.status, `${origem} deveria ser recusada`).toBe(403);
      }
    });

    it('com lista vazia, o dominio da comunidade continua sendo origem valida', async () => {
      // O caminho white-label nao depende da lista: e por isso que a lista pode
      // ficar vazia numa instalacao sem paineis internos proprios.
      const slug = unique('vazia-');
      await seedTenantWithSlug(semLista.owner, slug);

      const res = await request(semLista.app)
        .get('/api/health')
        .set('Origin', `https://${slug}.plataforma.local`);
      expect(res.status).toBe(200);
    });

    it('com lista vazia, requisicao sem Origin continua passando', async () => {
      const res = await request(semLista.app).get('/api/health');
      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // RN12 · elevacao de papel DURANTE a sessao
  //
  // Regressao do contorno encontrado na validacao: a sessao de quem nao exigia
  // MFA nascia com `mfa_satisfied_at` preenchido, e a trava
  // `mfaRequired && !mfaSatisfied` nunca disparava depois de uma promocao.
  // -------------------------------------------------------------------------
  describe('RN12 · promocao de papel durante a sessao', () => {
    it('SUPPORT promovido a OWNER perde acesso ate comprovar MFA', async () => {
      const slug = unique('promo-');
      const tenantId = await seedTenantWithSlug(harness.owner, slug);
      const account = await seedAccount(harness.owner);
      await grantMembership(harness.owner, { tenantId, userId: account.userId, role: 'SUPPORT' });

      const { cookie, status } = await loginAs(harness, account);
      expect(status).toBe('authenticated');

      // Antes da promocao, SUPPORT usa normalmente o que lhe cabe.
      const antes = await request(harness.app)
        .get('/api/tenant/context')
        .set('Cookie', cookie)
        .set('x-tenant-slug', slug);
      expect(antes.status).toBe(200);

      await grantMembership(harness.owner, { tenantId, userId: account.userId, role: 'OWNER' });

      // A promocao vale na requisicao SEGUINTE. Sem logout, sem espera.
      const depois = await request(harness.app)
        .get('/api/tenant/context')
        .set('Cookie', cookie)
        .set('x-tenant-slug', slug);
      expect(depois.status).toBe(403);
      expect(['MFA_REQUIRED', 'MFA_ENROLLMENT_REQUIRED']).toContain(depois.body.error.code);

      // E a rota privilegiada tambem, que era o caminho explorado.
      const auditoria = await request(harness.app)
        .get('/api/tenant/audit-events')
        .set('Cookie', cookie)
        .set('x-tenant-slug', slug);
      expect(auditoria.status).toBe(403);
    });

    it('depois de comprovar MFA de verdade, o OWNER promovido passa', async () => {
      const slug = unique('promo-ok-');
      const tenantId = await seedTenantWithSlug(harness.owner, slug);
      const account = await seedAccount(harness.owner);
      await grantMembership(harness.owner, { tenantId, userId: account.userId, role: 'SUPPORT' });

      const { cookie } = await loginAs(harness, account);
      await grantMembership(harness.owner, { tenantId, userId: account.userId, role: 'OWNER' });

      // Cadastra o fator e confirma — o unico caminho aberto a quem esta preso
      // na trava de RN12.
      const start = await request(harness.app).post('/api/auth/mfa/enroll').set('Cookie', cookie);
      expect(start.status).toBe(200);
      const confirmed = await confirmMfaEnrollment(
        harness,
        cookie,
        await currentCode(start.body.secret),
      );
      expect(confirmed.status).toBe(200);

      const liberado = await request(harness.app)
        .get('/api/tenant/audit-events')
        .set('Cookie', confirmed.cookie)
        .set('x-tenant-slug', slug);
      expect(liberado.status).toBe(200);
    });

    it('usuario comum que recebe Super Admin nao lista comunidades sem MFA', async () => {
      // O caso mais grave: a rota atravessa a fronteira da plataforma inteira.
      const account = await seedAccount(harness.owner);
      const { cookie } = await loginAs(harness, account);

      await grantPlatformRole(harness.owner, {
        userId: account.userId,
        role: 'PLATFORM_OPERATIONS',
      });

      const res = await request(harness.app).get('/api/platform/tenants').set('Cookie', cookie);
      expect(res.status).toBe(403);
      expect(['MFA_REQUIRED', 'MFA_ENROLLMENT_REQUIRED']).toContain(res.body.error.code);
      expect(res.body.tenants).toBeUndefined();
    });

    it('depois de comprovar MFA, o Super Admin recem-concedido passa', async () => {
      const account = await seedAccount(harness.owner);
      const { cookie } = await loginAs(harness, account);
      await grantPlatformRole(harness.owner, {
        userId: account.userId,
        role: 'PLATFORM_OPERATIONS',
      });

      const start = await request(harness.app).post('/api/auth/mfa/enroll').set('Cookie', cookie);
      const confirmed = await confirmMfaEnrollment(
        harness,
        cookie,
        await currentCode(start.body.secret),
      );
      expect(confirmed.status).toBe(200);

      const res = await request(harness.app)
        .get('/api/platform/tenants')
        .set('Cookie', confirmed.cookie);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.tenants)).toBe(true);
    });

    it('a sessao NASCE sem fator comprovado, mesmo para quem nao exige MFA', async () => {
      // `mfa_satisfied_at` significa "esta sessao apresentou um segundo fator".
      // Preenche-la no login por "nao precisava" foi a origem do contorno.
      const account = await seedAccount(harness.owner);
      const { cookie } = await loginAs(harness, account);

      const { rows } = await harness.owner.query<{ mfa_satisfied_at: string | null }>(
        'SELECT mfa_satisfied_at FROM sessions WHERE user_id = $1',
        [account.userId],
      );
      expect(rows[0]?.mfa_satisfied_at).toBeNull();

      const session = await request(harness.app).get('/api/auth/session').set('Cookie', cookie);
      expect(session.body.mfaSatisfied).toBe(false);
      expect(session.body.mfaRequired).toBe(false);
    });

    it('quem nao esta sob RN12 continua usando as rotas que lhe cabem', async () => {
      // A correcao nao pode transformar "nao precisa de MFA" em "bloqueado".
      for (const role of ['MARKETING', 'SUPPORT', 'OPERATOR']) {
        const slug = unique('semrn12-');
        const tenantId = await seedTenantWithSlug(harness.owner, slug);
        const account = await seedAccount(harness.owner);
        await grantMembership(harness.owner, { tenantId, userId: account.userId, role });

        const { cookie, status } = await loginAs(harness, account);
        expect(status, `${role} nao deveria ter pendencia de MFA`).toBe('authenticated');

        const contexto = await request(harness.app)
          .get('/api/tenant/context')
          .set('Cookie', cookie)
          .set('x-tenant-slug', slug);
        expect(contexto.status, `${role} deveria acessar o painel`).toBe(200);

        const sessao = await request(harness.app).get('/api/auth/session').set('Cookie', cookie);
        expect(sessao.status).toBe(200);
      }
    });

    it('revogar o papel que exigia MFA devolve o acesso comum', async () => {
      const slug = unique('desce-');
      const tenantId = await seedTenantWithSlug(harness.owner, slug);
      const account = await seedAccount(harness.owner);
      await grantMembership(harness.owner, { tenantId, userId: account.userId, role: 'SUPPORT' });
      await grantMembership(harness.owner, { tenantId, userId: account.userId, role: 'OWNER' });

      const { cookie } = await loginAs(harness, account);
      const preso = await request(harness.app)
        .get('/api/tenant/context')
        .set('Cookie', cookie)
        .set('x-tenant-slug', slug);
      expect(preso.status).toBe(403);

      await harness.owner.query(
        `UPDATE memberships SET revoked_at = now()
          WHERE tenant_id = $1 AND user_id = $2 AND role = 'OWNER'`,
        [tenantId, account.userId],
      );

      const livre = await request(harness.app)
        .get('/api/tenant/context')
        .set('Cookie', cookie)
        .set('x-tenant-slug', slug);
      expect(livre.status).toBe(200);
      expect(livre.body.roles).toEqual(['SUPPORT']);
    });
  });

  // -------------------------------------------------------------------------
  // RN12 · rotacao do token na elevacao da sessao
  // -------------------------------------------------------------------------
  describe('RN12 · rotacao do token apos o segundo fator', () => {
    it('o token anterior a verificacao deixa de valer', async () => {
      const slug = unique('rot-');
      const tenantId = await seedTenantWithSlug(harness.owner, slug);
      const account = await seedAccount(harness.owner);
      await grantMembership(harness.owner, { tenantId, userId: account.userId, role: 'OWNER' });
      const secret = await seedConfirmedTotp(harness.owner, account.userId);

      const login = await loginAs(harness, account);
      const verified = await verifyMfa(harness, login.cookie, await currentCode(secret));
      expect(verified.status).toBe(200);
      expect(verified.cookie).not.toBe(login.cookie);

      // Quem capturou o token ANTES da elevacao nao herda o privilegio.
      const antigo = await request(harness.app)
        .get('/api/tenant/audit-events')
        .set('Cookie', login.cookie)
        .set('x-tenant-slug', slug);
      expect(antigo.status).toBe(401);

      const novo = await request(harness.app)
        .get('/api/tenant/audit-events')
        .set('Cookie', verified.cookie)
        .set('x-tenant-slug', slug);
      expect(novo.status).toBe(200);
    });

    it('o token anterior ao CADASTRO do fator tambem deixa de valer', async () => {
      const slug = unique('rot2-');
      const tenantId = await seedTenantWithSlug(harness.owner, slug);
      const account = await seedAccount(harness.owner);
      await grantMembership(harness.owner, { tenantId, userId: account.userId, role: 'OWNER' });

      const { cookie } = await loginAs(harness, account);
      const start = await request(harness.app).post('/api/auth/mfa/enroll').set('Cookie', cookie);
      const confirmed = await confirmMfaEnrollment(
        harness,
        cookie,
        await currentCode(start.body.secret),
      );
      expect(confirmed.status).toBe(200);
      expect(confirmed.cookie).not.toBe(cookie);

      const antigo = await request(harness.app).get('/api/auth/session').set('Cookie', cookie);
      expect(antigo.status).toBe(401);
    });

    it('a rotacao preserva a MESMA sessao, nao abre outra', async () => {
      // O identificador da sessao liga a trilha de auditoria ao mesmo episodio
      // de acesso; o que roda e o segredo portador, nao o episodio.
      const account = await seedAccount(harness.owner);
      await grantPlatformRole(harness.owner, {
        userId: account.userId,
        role: 'PLATFORM_OPERATIONS',
      });
      const secret = await seedConfirmedTotp(harness.owner, account.userId);

      const login = await loginAs(harness, account);
      await verifyMfa(harness, login.cookie, await currentCode(secret));

      const { rows } = await harness.owner.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
        [account.userId],
      );
      expect(rows[0]?.count).toBe('1');
    });
  });

  // -------------------------------------------------------------------------
  // RN12 · o CADASTRO tem as mesmas defesas da verificacao
  // -------------------------------------------------------------------------
  describe('RN12 · defesas do cadastro do segundo fator', () => {
    async function ownerEmEnrollment() {
      const slug = unique('enr-');
      const tenantId = await seedTenantWithSlug(harness.owner, slug);
      const account = await seedAccount(harness.owner);
      await grantMembership(harness.owner, { tenantId, userId: account.userId, role: 'OWNER' });
      const { cookie } = await loginAs(harness, account);
      const start = await request(harness.app).post('/api/auth/mfa/enroll').set('Cookie', cookie);
      return { account, cookie, slug, secret: start.body.secret as string };
    }

    it('codigos errados no cadastro bloqueiam por tentativas', async () => {
      // O cadastro termina em sessao ELEVADA: sem limite aqui, o atacante com a
      // senha simplesmente escolheria este endpoint em vez do de verificacao.
      const { account, cookie } = await ownerEmEnrollment();

      for (let i = 0; i < harness.config.LOGIN_MAX_ATTEMPTS; i += 1) {
        const res = await confirmMfaEnrollment(harness, cookie, '000000');
        expect(res.status).toBe(401);
      }

      const blocked = await confirmMfaEnrollment(harness, cookie, '000000');
      expect(blocked.status).toBe(429);

      const { rows } = await harness.owner.query<{ mfa_failed_attempts: number }>(
        'SELECT mfa_failed_attempts FROM user_credentials WHERE user_id = $1',
        [account.userId],
      );
      expect(rows[0]!.mfa_failed_attempts).toBeGreaterThanOrEqual(
        harness.config.LOGIN_MAX_ATTEMPTS,
      );
    });

    it('o bloqueio do cadastro e o MESMO do de verificacao', async () => {
      // Dois contadores independentes dariam ao atacante o dobro de tentativas:
      // gastaria o limite num endpoint e recomecaria do zero no outro.
      const { cookie, secret } = await ownerEmEnrollment();
      for (let i = 0; i < harness.config.LOGIN_MAX_ATTEMPTS; i += 1) {
        await confirmMfaEnrollment(harness, cookie, '000000');
      }

      const verify = await verifyMfa(harness, cookie, await currentCode(secret));
      expect(verify.status).toBe(429);
    });

    it('acertar o cadastro zera o contador de tentativas', async () => {
      const { account, cookie, secret } = await ownerEmEnrollment();
      await confirmMfaEnrollment(harness, cookie, '000000');

      const ok = await confirmMfaEnrollment(harness, cookie, await currentCode(secret));
      expect(ok.status).toBe(200);

      const { rows } = await harness.owner.query<{
        mfa_failed_attempts: number;
        mfa_locked_until: string | null;
      }>(
        'SELECT mfa_failed_attempts, mfa_locked_until FROM user_credentials WHERE user_id = $1',
        [account.userId],
      );
      expect(rows[0]?.mfa_failed_attempts).toBe(0);
      expect(rows[0]?.mfa_locked_until).toBeNull();
    });

    it('o codigo usado no cadastro nao vale de novo na verificacao (replay)', async () => {
      // O passo aceito na confirmacao fica gravado em `last_used_step`, entao o
      // mesmo codigo de 6 digitos nao serve para elevar outra sessao dentro da
      // mesma janela de 30 s.
      const { account, cookie, secret } = await ownerEmEnrollment();
      const code = await currentCode(secret);

      const confirmed = await confirmMfaEnrollment(harness, cookie, code);
      expect(confirmed.status).toBe(200);

      const outra = await loginAs(harness, account);
      const replay = await verifyMfa(harness, outra.cookie, code);
      expect(replay.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // RN11 · trilha de identidade
  // -------------------------------------------------------------------------
  describe('RN11 · trilha de auditoria da identidade', () => {
    it('login bem-sucedido, logout e logout-all sao registrados', async () => {
      const account = await seedAccount(harness.owner);
      const { cookie } = await loginAs(harness, account);
      await request(harness.app).post('/api/auth/logout').set('Cookie', cookie);

      const segunda = await loginAs(harness, account);
      await request(harness.app).post('/api/auth/logout-all').set('Cookie', segunda.cookie);

      const actions = await identityAuditActions(harness.owner, account.userId);
      expect(actions).toContain('auth.login.succeeded');
      expect(actions).toContain('auth.logout');
      expect(actions).toContain('auth.logout_all');
    });

    it('tentativa recusada e bloqueio de conta sao registrados', async () => {
      const account = await seedAccount(harness.owner);
      for (let i = 0; i < harness.config.LOGIN_MAX_ATTEMPTS; i += 1) {
        await request(harness.app)
          .post('/api/auth/login')
          .send({ email: account.email, password: 'errada' });
      }

      const actions = await identityAuditActions(harness.owner, account.userId);
      expect(actions).toContain('auth.login.failed');
      expect(actions).toContain('auth.account_locked');
      // O bloqueio e registrado UMA vez, na transicao — nao a cada insistencia.
      expect(actions.filter((a) => a === 'auth.account_locked')).toHaveLength(1);
    });

    it('cadastro do segundo fator deixa trilha de inicio e de confirmacao', async () => {
      const account = await seedAccount(harness.owner);
      const { cookie } = await loginAs(harness, account);

      const start = await request(harness.app).post('/api/auth/mfa/enroll').set('Cookie', cookie);
      const confirmed = await confirmMfaEnrollment(
        harness,
        cookie,
        await currentCode(start.body.secret),
      );
      expect(confirmed.status).toBe(200);

      const actions = await identityAuditActions(harness.owner, account.userId);
      expect(actions).toContain('auth.mfa.enrollment_started');
      expect(actions).toContain('auth.mfa.enrollment_confirmed');
    });

    it('verificacao do segundo fator deixa trilha', async () => {
      // Conta com fator JA confirmado: evita depender do passo TOTP consumido
      // por um cadastro feito no mesmo instante.
      const account = await seedAccount(harness.owner);
      const secret = await seedConfirmedTotp(harness.owner, account.userId);

      const login = await loginAs(harness, account);
      const verified = await verifyMfa(harness, login.cookie, await currentCode(secret));
      expect(verified.status).toBe(200);

      const actions = await identityAuditActions(harness.owner, account.userId);
      expect(actions).toContain('auth.mfa.verified');
    });

    it('a trilha de identidade NAO carrega segredo algum', async () => {
      const account = await seedAccount(harness.owner);
      const { cookie } = await loginAs(harness, account);
      const start = await request(harness.app).post('/api/auth/mfa/enroll').set('Cookie', cookie);
      await confirmMfaEnrollment(harness, cookie, await currentCode(start.body.secret));

      const { rows } = await harness.owner.query<{ after: unknown }>(
        `SELECT after FROM audit_events
          WHERE actor_user_id = $1 AND action LIKE 'auth.%'`,
        [account.userId],
      );
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(start.body.secret);
      expect(dump).not.toMatch(/senha|password|token|secret/i);
    });

    it('a trilha de identidade nao aparece na trilha da COMUNIDADE', async () => {
      // Evento de identidade tem tenant_id nulo; a listagem da comunidade so
      // enxerga o proprio tenant. Um vazamento aqui exporia o IP de quem loga.
      const slug = unique('trilha-');
      const tenantId = await seedTenantWithSlug(harness.owner, slug);
      const account = await seedAccount(harness.owner);
      await grantMembership(harness.owner, { tenantId, userId: account.userId, role: 'OWNER' });

      const { cookie } = await loginAs(harness, account);
      const start = await request(harness.app).post('/api/auth/mfa/enroll').set('Cookie', cookie);
      const confirmed = await confirmMfaEnrollment(
        harness,
        cookie,
        await currentCode(start.body.secret),
      );

      const res = await request(harness.app)
        .get('/api/tenant/audit-events')
        .set('Cookie', confirmed.cookie)
        .set('x-tenant-slug', slug);
      expect(res.status).toBe(200);
      for (const evento of res.body.events as { action: string }[]) {
        expect(evento.action.startsWith('auth.')).toBe(false);
      }
    });

    it('a trilha de identidade e imutavel como o resto (RN11)', async () => {
      const account = await seedAccount(harness.owner);
      await loginAs(harness, account);

      const { rows } = await harness.owner.query<{ id: string }>(
        `SELECT id FROM audit_events WHERE actor_user_id = $1 AND action = 'auth.login.succeeded'`,
        [account.userId],
      );
      expect(rows.length).toBeGreaterThan(0);

      await expect(
        harness.owner.query('UPDATE audit_events SET action = $2 WHERE id = $1', [
          rows[0]!.id,
          'auth.adulterado',
        ]),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Diagnostico
  // -------------------------------------------------------------------------
  it('a rota de saude responde sem sessao', async () => {
    const res = await request(harness.app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database).toBe('up');
  });
});
