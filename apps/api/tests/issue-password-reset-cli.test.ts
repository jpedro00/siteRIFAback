import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  TEST_OWNER_URL,
  cleanup,
  createHarness,
  hasTestDatabase,
  seedAccount,
  skipReason,
  type Harness,
} from './helpers/apiHarness.js';

/**
 * Ferramenta de operador: emite o link de redefinicao quando nao ha provedor de e-mail. Nao define
 * senha; a pessoa escolhe a propria pelo fluxo normal.
 */
describe.skipIf(!hasTestDatabase)(`ferramenta de operador: link de redefinicao ${hasTestDatabase ? '' : skipReason}`, () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
    await cleanup(h.owner);
  }, 120_000);

  afterAll(async () => {
    await cleanup(h.owner);
    await h.pool.end();
  });

  function emitir(email: string) {
    return spawnSync('npx', ['tsx', 'packages/db/src/cli/issue-password-reset.ts', email], {
      cwd: process.cwd(),
      encoding: 'utf8',
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL: TEST_OWNER_URL,
        PASSWORD_RESET_URL: 'https://exemplo.test/redefinir-senha',
      },
    });
  }

  it('emite um link; a pessoa escolhe a propria senha e entra; o token vale uma vez; fica na auditoria sem o token', async () => {
    const conta = await seedAccount(h.owner);
    const r = emitir(conta.email);
    expect(r.status, r.stderr).toBe(0);
    const token = /#token=([A-Za-z0-9_-]{20,})/.exec(r.stdout)?.[1];
    expect(token).toBeDefined();
    expect(r.stdout).toContain('https://exemplo.test/redefinir-senha#token=');

    const nova = 'Senha-Escolhida-Pela-Pessoa-2026!';
    const reset = await request(h.app).post('/api/auth/password/reset').send({ token, password: nova, passwordConfirmation: nova });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    expect((await request(h.app).post('/api/auth/login').send({ email: conta.email, password: conta.password })).status).toBe(401);
    expect((await request(h.app).post('/api/auth/login').send({ email: conta.email, password: nova })).status).toBe(200);
    expect((await request(h.app).post('/api/auth/password/reset').send({ token, password: nova, passwordConfirmation: nova })).status).toBe(400);

    const { rows } = await h.owner.query<{ blob: string }>(
      "SELECT coalesce(after::text, '') AS blob FROM audit_events WHERE actor_user_id = $1 AND action = 'auth.password_reset.requested'",
      [conta.userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.blob).toContain('operator_cli');
    expect(rows[0]!.blob).not.toContain(token!);
    const guardado = await h.owner.query<{ t: string }>('SELECT password_reset_tokens::text AS t FROM password_reset_tokens WHERE user_id = $1', [conta.userId]);
    for (const linha of guardado.rows) expect(linha.t).not.toContain(token!);
  }, 90_000);

  it('conta inexistente ou inativa: nenhum token e saida de erro', async () => {
    const r = emitir('ninguem-aqui@example.com');
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('#token=');

    const inativa = await seedAccount(h.owner);
    await h.owner.query("UPDATE users SET status = 'DISABLED' WHERE id = $1", [inativa.userId]);
    const r2 = emitir(inativa.email);
    expect(r2.status).not.toBe(0);
    expect(r2.stdout).not.toContain('#token=');
  }, 90_000);

  it('e-mail invalido e recusado antes de conectar', () => {
    const r = emitir('nao-e-um-email');
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('#token=');
  }, 60_000);
});
