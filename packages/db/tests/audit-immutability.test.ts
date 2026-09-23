import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withPlatform, withTenant } from '../src/context.js';
import type { DbPool } from '../src/pool.js';
import {
  appPool,
  describeSkipReason,
  ensureMigrated,
  hasTestDatabase,
  ownerPool,
  seedMembership,
  seedTenant,
  seedUser,
  unique,
} from './helpers/testDb.js';

/**
 * RN11 · trilha de auditoria imutavel.
 * Secao 8 do pedido, item 9.
 */
describe.skipIf(!hasTestDatabase)(`RN11 · auditoria somente insercao ${
  hasTestDatabase ? '' : describeSkipReason()
}`, () => {
  let owner: DbPool;
  let app: DbPool;
  let tenant: { tenantId: string };
  let user: { userId: string };
  let eventId: string;

  beforeAll(async () => {
    await ensureMigrated();
    owner = ownerPool();
    app = appPool();

    tenant = await seedTenant(owner, unique('audit-'), 'Auditoria');
    user = await seedUser(owner, `${unique('audit-')}@example.com`, 'Auditor');
    await seedMembership(owner, { tenantId: tenant.tenantId, userId: user.userId, role: 'OWNER' });

    eventId = await withTenant(app, { tenantId: tenant.tenantId, userId: user.userId }, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO audit_events (tenant_id, actor_user_id, action, target_type, target_id, before, after, ip)
         VALUES ($1, $2, 'membership.granted', 'membership', $3, $4::jsonb, $5::jsonb, $6::inet)
         RETURNING id`,
        [
          tenant.tenantId,
          user.userId,
          'alvo-1',
          JSON.stringify({ role: null }),
          JSON.stringify({ role: 'SUPPORT' }),
          '203.0.113.10',
        ],
      );
      return rows[0]!.id;
    });
  });

  afterAll(async () => {
    await app?.end();
    await owner?.end();
  });

  it('a aplicacao consegue INSERIR na trilha', async () => {
    expect(eventId).toBeTruthy();
  });

  it('a trilha grava ator, contexto, acao, alvo, instante, IP e alteracoes', async () => {
    const { rows } = await owner.query<Record<string, unknown>>(
      'SELECT tenant_id, actor_user_id, action, target_type, target_id, before, after, ip, occurred_at FROM audit_events WHERE id = $1',
      [eventId],
    );
    const row = rows[0]!;
    expect(row['tenant_id']).toBe(tenant.tenantId);
    expect(row['actor_user_id']).toBe(user.userId);
    expect(row['action']).toBe('membership.granted');
    expect(row['target_type']).toBe('membership');
    expect(row['target_id']).toBe('alvo-1');
    expect(row['before']).toEqual({ role: null });
    expect(row['after']).toEqual({ role: 'SUPPORT' });
    expect(row['ip']).toBe('203.0.113.10');
    expect(row['occurred_at']).toBeTruthy();
  });

  it('item 9 · a aplicacao NAO consegue ALTERAR a trilha', async () => {
    await expect(
      withTenant(app, { tenantId: tenant.tenantId, userId: user.userId }, async (client) => {
        await client.query('UPDATE audit_events SET action = $1 WHERE id = $2', ['adulterado', eventId]);
      }),
    ).rejects.toThrow(/permission denied|somente insercao|insufficient/i);

    const { rows } = await owner.query<{ action: string }>(
      'SELECT action FROM audit_events WHERE id = $1',
      [eventId],
    );
    expect(rows[0]?.action).toBe('membership.granted');
  });

  it('item 9 · a aplicacao NAO consegue EXCLUIR da trilha', async () => {
    await expect(
      withTenant(app, { tenantId: tenant.tenantId, userId: user.userId }, async (client) => {
        await client.query('DELETE FROM audit_events WHERE id = $1', [eventId]);
      }),
    ).rejects.toThrow(/permission denied|somente insercao|insufficient/i);

    const { rows } = await owner.query('SELECT 1 FROM audit_events WHERE id = $1', [eventId]);
    expect(rows).toHaveLength(1);
  });

  it('nem o DONO do schema consegue alterar a trilha (o trigger cobre)', async () => {
    // Defesa dupla: se um GRANT futuro for afrouxado por engano, o trigger
    // continua barrando.
    await expect(
      owner.query('UPDATE audit_events SET action = $1 WHERE id = $2', ['adulterado', eventId]),
    ).rejects.toThrow(/somente insercao/i);

    await expect(owner.query('DELETE FROM audit_events WHERE id = $1', [eventId])).rejects.toThrow(
      /somente insercao/i,
    );
  });

  it('TRUNCATE tambem e barrado', async () => {
    await expect(owner.query('TRUNCATE audit_events')).rejects.toThrow(/somente insercao/i);
  });

  it('a trilha recusa senha, token e segredo nos campos antes/depois', async () => {
    for (const payload of [
      { password: 'hunter2' },
      { token: 'abc' },
      { secret_encrypted: 'x' },
      { changes: { credentials: { client_secret: 'x' } } },
    ]) {
      await expect(
        withTenant(app, { tenantId: tenant.tenantId, userId: user.userId }, async (client) => {
          await client.query(
            `INSERT INTO audit_events (tenant_id, actor_user_id, action, after)
             VALUES ($1, $2, 'teste.segredo', $3::jsonb)`,
            [tenant.tenantId, user.userId, JSON.stringify(payload)],
          );
        }),
      ).rejects.toThrow(/campo sensivel/i);
    }
  });

  it('a trilha de uma comunidade nao e legivel por outra', async () => {
    const other = await seedTenant(owner, unique('audit-b-'), 'Auditoria B');
    const otherUser = await seedUser(owner, `${unique('audit-b-')}@example.com`, 'Outro');
    await seedMembership(owner, {
      tenantId: other.tenantId,
      userId: otherUser.userId,
      role: 'OWNER',
    });

    const rows = await withTenant(
      app,
      { tenantId: other.tenantId, userId: otherUser.userId },
      async (client) => (await client.query('SELECT id FROM audit_events WHERE id = $1', [eventId])).rows,
    );
    expect(rows).toHaveLength(0);
  });

  it('acao de plataforma grava trilha com tenant_id nulo', async () => {
    const platformUser = await seedUser(owner, `${unique('sa-')}@example.com`, 'Super Admin');
    await owner.query(
      "INSERT INTO platform_admins (user_id, role) VALUES ($1, 'PLATFORM_OPERATIONS')",
      [platformUser.userId],
    );

    const id = await withPlatform(app, { userId: platformUser.userId }, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO audit_events (tenant_id, actor_user_id, actor_type, action)
         VALUES (NULL, $1, 'PLATFORM', 'tenant.created') RETURNING id`,
        [platformUser.userId],
      );
      return rows[0]!.id;
    });
    expect(id).toBeTruthy();
  });

  it('sem contexto de comunidade, a aplicacao nao grava trilha de comunidade', async () => {
    await expect(
      withTenant(app, { tenantId: tenant.tenantId, userId: user.userId }, async (client) => {
        // tenant_id de outra comunidade dentro do contexto atual: recusado.
        await client.query(
          `INSERT INTO audit_events (tenant_id, actor_user_id, action)
           VALUES ($1, $2, 'teste.cruzado')`,
          ['00000000-0000-0000-0000-000000000000', user.userId],
        );
      }),
    ).rejects.toThrow();
  });
});
