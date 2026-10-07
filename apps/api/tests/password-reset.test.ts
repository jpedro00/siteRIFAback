import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  cleanup,
  createHarness,
  grantMembership,
  hasTestDatabase,
  loginAs,
  seedAccount,
  seedConfirmedTotp,
  seedTenantWithSlug,
  skipReason,
  unique,
  type Harness,
} from './helpers/apiHarness.js';
import type { PasswordResetMessage, PasswordResetNotifier } from '../src/lib/passwordResetNotifier.js';

/**
 * Recuperacao de senha. Identidade global: um fluxo para qualquer tipo de conta.
 * O notificador de teste captura a mensagem (o token so existe ali); a API nunca o devolve.
 */
describe.skipIf(!hasTestDatabase)(`recuperacao de senha ${hasTestDatabase ? '' : skipReason}`, () => {
  let h: Harness;
  const entregues: PasswordResetMessage[] = [];
  let falhaNaEntrega = false;
  const notifier: PasswordResetNotifier = {
    async send(m) {
      if (falhaNaEntrega) throw new Error('provedor fora do ar');
      entregues.push(m);
    },
  };

  beforeAll(async () => {
    h = await createHarness({ passwordResetNotifier: notifier });
    await cleanup(h.owner);
  }, 120_000);

  afterAll(async () => {
    await cleanup(h.owner);
    await h.pool.end();
  });

  const SENHA_NOVA = 'Outra-Senha-Forte-2026!';
  const pedir = (email: string) => request(h.app).post('/api/auth/password/forgot').send({ email });
  const redefinir = (token: string, password = SENHA_NOVA, passwordConfirmation = password) =>
    request(h.app).post('/api/auth/password/reset').send({ token, password, passwordConfirmation });
  const ultimaEntregaPara = (email: string) => [...entregues].reverse().find((m) => m.email === email);
  const entrar = (email: string, password: string) => request(h.app).post('/api/auth/login').send({ email, password });

  it('e-mail existente e inexistente recebem a MESMA resposta; so a conta existente recebe o token', async () => {
    const conta = await seedAccount(h.owner);
    const existente = await pedir(conta.email);
    const inexistente = await pedir(`${unique('nao-existe-')}@example.com`);

    expect(existente.status).toBe(202);
    expect(inexistente.status).toBe(202);
    expect(existente.body).toEqual(inexistente.body);
    expect(existente.body).toEqual({ accepted: true });
    expect(ultimaEntregaPara(conta.email)).toBeDefined();
    expect(JSON.stringify(existente.body)).not.toMatch(/token/i);
  });

  it('token valido redefine: a senha antiga deixa de valer e a nova passa a valer', async () => {
    const conta = await seedAccount(h.owner);
    await pedir(conta.email);
    const msg = ultimaEntregaPara(conta.email)!;
    expect(msg.resetUrl).toBeNull(); // PASSWORD_RESET_URL nao configurada na bancada

    const res = await redefinir(msg.token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reset: true });
    // Nao devolve cookie de sessao: quem redefine entra de novo com a senha nova.
    expect(String(res.headers['set-cookie'] ?? '')).not.toMatch(/=[A-Za-z0-9_-]{20,}/);

    expect((await entrar(conta.email, conta.password)).status).toBe(401);
    expect((await entrar(conta.email, SENHA_NOVA)).status).toBe(200);
  });

  it('o token nao pode ser reutilizado; token desconhecido e token usado respondem igual', async () => {
    const conta = await seedAccount(h.owner);
    await pedir(conta.email);
    const { token } = ultimaEntregaPara(conta.email)!;

    expect((await redefinir(token)).status).toBe(200);
    const reuso = await redefinir(token, 'Mais-Uma-Senha-Forte-2026!');
    const desconhecido = await redefinir('x'.repeat(43), 'Mais-Uma-Senha-Forte-2026!');
    expect(reuso.status).toBe(400);
    expect(desconhecido.status).toBe(400);
    expect(reuso.body).toEqual(desconhecido.body);
    // A senha continua sendo a da primeira redefinicao.
    expect((await entrar(conta.email, SENHA_NOVA)).status).toBe(200);
  });

  it('token vencido falha', async () => {
    const conta = await seedAccount(h.owner);
    await pedir(conta.email);
    const { token } = ultimaEntregaPara(conta.email)!;
    await h.owner.query(
      `UPDATE password_reset_tokens
          SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
        WHERE user_id = $1`,
      [conta.userId],
    );
    expect((await redefinir(token)).status).toBe(400);
    expect((await entrar(conta.email, conta.password)).status).toBe(200);
  });

  it('um segundo pedido invalida o primeiro token', async () => {
    const conta = await seedAccount(h.owner);
    await pedir(conta.email);
    const primeiro = ultimaEntregaPara(conta.email)!;
    await pedir(conta.email);
    const segundo = ultimaEntregaPara(conta.email)!;
    expect(segundo.token).not.toBe(primeiro.token);

    expect((await redefinir(primeiro.token)).status).toBe(400);
    expect((await redefinir(segundo.token)).status).toBe(200);
  });

  it('todas as sessoes anteriores da conta sao revogadas', async () => {
    const conta = await seedAccount(h.owner);
    const a = await loginAs(h, conta);
    const b = await loginAs(h, conta);
    expect((await request(h.app).get('/api/auth/session').set('Cookie', a.cookie)).status).toBe(200);

    await pedir(conta.email);
    expect((await redefinir(ultimaEntregaPara(conta.email)!.token)).status).toBe(200);

    expect((await request(h.app).get('/api/auth/session').set('Cookie', a.cookie)).status).toBe(401);
    expect((await request(h.app).get('/api/auth/session').set('Cookie', b.cookie)).status).toBe(401);
    const { rows } = await h.owner.query<{ n: string }>(
      "SELECT count(*) AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND revoked_reason IS DISTINCT FROM 'password_reset'",
      [conta.userId],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('zera tentativas e bloqueio: conta trancada volta a entrar com a senha nova', async () => {
    const conta = await seedAccount(h.owner);
    for (let i = 0; i < 5; i += 1) await entrar(conta.email, 'senha-errada-qualquer');
    const { rows } = await h.owner.query<{ locked: boolean }>(
      'SELECT (locked_until > now()) AS locked FROM user_credentials WHERE user_id = $1',
      [conta.userId],
    );
    expect(rows[0]!.locked).toBe(true);

    await pedir(conta.email);
    expect((await redefinir(ultimaEntregaPara(conta.email)!.token)).status).toBe(200);
    const apos = await h.owner.query<{ failed_attempts: number; locked_until: string | null }>(
      'SELECT failed_attempts, locked_until FROM user_credentials WHERE user_id = $1',
      [conta.userId],
    );
    expect(apos.rows[0]).toEqual({ failed_attempts: 0, locked_until: null });
    expect((await entrar(conta.email, SENHA_NOVA)).status).toBe(200);
  });

  it('a senha nova segue o contrato do cadastro: curta ou divergente e recusada e nao gasta o token', async () => {
    const conta = await seedAccount(h.owner);
    await pedir(conta.email);
    const { token } = ultimaEntregaPara(conta.email)!;

    expect((await redefinir(token, 'curta')).status).toBe(400);
    expect((await redefinir(token, SENHA_NOVA, 'Diferente-Da-Primeira-2026!')).status).toBe(400);
    expect((await redefinir(token)).status).toBe(200);
  });

  it('o hash gravado e scrypt (o mesmo do login) e o token nunca fica gravado em claro', async () => {
    const conta = await seedAccount(h.owner);
    await pedir(conta.email);
    const { token } = ultimaEntregaPara(conta.email)!;
    await redefinir(token);

    const cred = await h.owner.query<{ password_hash: string }>(
      'SELECT password_hash FROM user_credentials WHERE user_id = $1',
      [conta.userId],
    );
    expect(cred.rows[0]!.password_hash.split('$')).toHaveLength(6);
    expect(cred.rows[0]!.password_hash.startsWith('scrypt$')).toBe(true);

    const tabela = await h.owner.query<{ t: string }>('SELECT password_reset_tokens::text AS t FROM password_reset_tokens WHERE user_id = $1', [
      conta.userId,
    ]);
    expect(tabela.rows.length).toBeGreaterThan(0);
    for (const linha of tabela.rows) expect(linha.t).not.toContain(token);

    const auditoria = await h.owner.query<{ action: string; blob: string }>(
      "SELECT action, coalesce(before::text,'') || coalesce(after::text,'') AS blob FROM audit_events WHERE actor_user_id = $1 AND action LIKE 'auth.password_reset.%' ORDER BY occurred_at",
      [conta.userId],
    );
    expect(auditoria.rows.map((r) => r.action)).toEqual(['auth.password_reset.requested', 'auth.password_reset.completed']);
    for (const linha of auditoria.rows) {
      expect(linha.blob).not.toContain(token);
      expect(linha.blob).not.toContain(SENHA_NOVA);
    }
  });

  it('conta inativa e conta inexistente: mesma resposta e nenhuma entrega', async () => {
    const conta = await seedAccount(h.owner);
    await h.owner.query("UPDATE users SET status = 'SUSPENDED' WHERE id = $1", [conta.userId]).catch(async () => {
      await h.owner.query("UPDATE users SET status = 'DISABLED' WHERE id = $1", [conta.userId]);
    });
    const antes = entregues.length;
    const res = await pedir(conta.email);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });
    expect(entregues.length).toBe(antes);
  });

  it('falha do provedor de e-mail nao muda a resposta', async () => {
    const conta = await seedAccount(h.owner);
    falhaNaEntrega = true;
    try {
      const res = await pedir(conta.email);
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ accepted: true });
    } finally {
      falhaNaEntrega = false;
    }
  });

  it('o MFA continua obrigatorio depois da redefinicao (dono com fator confirmado)', async () => {
    const slug = unique('rec-');
    const tenantId = await seedTenantWithSlug(h.owner, slug, 'Comunidade da Recuperacao');
    const dono = await seedAccount(h.owner);
    await grantMembership(h.owner, { tenantId, userId: dono.userId, role: 'OWNER' });
    await seedConfirmedTotp(h.owner, dono.userId);

    await pedir(dono.email);
    expect((await redefinir(ultimaEntregaPara(dono.email)!.token)).status).toBe(200);

    const login = await entrar(dono.email, SENHA_NOVA);
    expect(login.status).toBe(200);
    expect(login.body.status).toBe('mfa_required');
  });

  it('o banco recusa acesso direto a tabela de tokens pelo papel da aplicacao', async () => {
    const { rows } = await h.owner.query<{ n: string }>(
      "SELECT count(*) AS n FROM information_schema.role_table_grants WHERE table_name = 'password_reset_tokens' AND grantee IN ('app_user','app_worker','PUBLIC')",
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe.skipIf(!hasTestDatabase)(`recuperacao de senha · limite por origem ${hasTestDatabase ? '' : skipReason}`, () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ originLimits: { windowMinutes: 15, maxFailures: 3, maxAccounts: 3 } });
  }, 120_000);
  afterAll(async () => {
    await h.pool.end();
  });

  it('muitos pedidos da mesma origem recebem 429, existam as contas ou nao', async () => {
    const status: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await request(h.app).post('/api/auth/password/forgot').send({ email: `${unique('lim-')}@example.com` });
      status.push(r.status);
    }
    expect(status.slice(0, 3)).toEqual([202, 202, 202]);
    expect(status.slice(-1)).toEqual([429]);
  });
});
