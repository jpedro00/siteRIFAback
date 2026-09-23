import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/context.js';
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
 * RN21 · outbox transacional.
 * Secao 8 do pedido, item 10: rollback da operacao desfaz tambem o evento.
 */
describe.skipIf(!hasTestDatabase)(`RN21 · outbox na mesma transacao ${
  hasTestDatabase ? '' : describeSkipReason()
}`, () => {
  let owner: DbPool;
  let app: DbPool;
  let tenant: { tenantId: string };
  let user: { userId: string };

  beforeAll(async () => {
    await ensureMigrated();
    owner = ownerPool();
    app = appPool();
    tenant = await seedTenant(owner, unique('outbox-'), 'Outbox');
    user = await seedUser(owner, `${unique('outbox-')}@example.com`, 'Pessoa Outbox');
    await seedMembership(owner, { tenantId: tenant.tenantId, userId: user.userId, role: 'OWNER' });
  });

  afterAll(async () => {
    await app?.end();
    await owner?.end();
  });

  async function countEvents(eventType: string): Promise<number> {
    const { rows } = await owner.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM outbox WHERE tenant_id = $1 AND event_type = $2',
      [tenant.tenantId, eventType],
    );
    return Number(rows[0]!.count);
  }

  it('commit grava a mudanca E o evento', async () => {
    const membershipUser = await seedUser(owner, `${unique('ob-ok-')}@example.com`, 'Vinculo OK');

    await withTenant(app, { tenantId: tenant.tenantId, userId: user.userId }, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO memberships (tenant_id, user_id, role, accepted_at)
         VALUES ($1, $2, 'SUPPORT', now()) RETURNING id`,
        [tenant.tenantId, membershipUser.userId],
      );
      await client.query(
        `INSERT INTO outbox (tenant_id, event_type, payload)
         VALUES ($1, 'membership.granted', $2::jsonb)`,
        [
          tenant.tenantId,
          JSON.stringify({
            tenantId: tenant.tenantId,
            membershipId: rows[0]!.id,
            userId: membershipUser.userId,
            role: 'SUPPORT',
            grantedByUserId: user.userId,
          }),
        ],
      );
    });

    expect(await countEvents('membership.granted')).toBe(1);
    const { rows } = await owner.query('SELECT 1 FROM memberships WHERE user_id = $1', [
      membershipUser.userId,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('item 10 · rollback da operacao desfaz TAMBEM o evento na outbox', async () => {
    const membershipUser = await seedUser(owner, `${unique('ob-rb-')}@example.com`, 'Vinculo RB');
    const before = await countEvents('membership.revoked');

    await expect(
      withTenant(app, { tenantId: tenant.tenantId, userId: user.userId }, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO memberships (tenant_id, user_id, role, accepted_at)
           VALUES ($1, $2, 'MARKETING', now()) RETURNING id`,
          [tenant.tenantId, membershipUser.userId],
        );
        await client.query(
          `INSERT INTO outbox (tenant_id, event_type, payload)
           VALUES ($1, 'membership.revoked', $2::jsonb)`,
          [
            tenant.tenantId,
            JSON.stringify({
              tenantId: tenant.tenantId,
              membershipId: rows[0]!.id,
              userId: membershipUser.userId,
              revokedByUserId: user.userId,
            }),
          ],
        );
        // Falha DEPOIS de gravar mudanca e evento.
        throw new Error('falha depois de gravar evento');
      }),
    ).rejects.toThrow('falha depois de gravar evento');

    // Nem o vinculo nem o evento sobreviveram.
    const memberships = await owner.query('SELECT 1 FROM memberships WHERE user_id = $1', [
      membershipUser.userId,
    ]);
    expect(memberships.rows).toHaveLength(0);
    expect(await countEvents('membership.revoked')).toBe(before);
  });

  it('a API nao pode marcar um evento como publicado (isso e do worker)', async () => {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO outbox (tenant_id, event_type, payload)
       VALUES ($1, 'tenant.created', '{}'::jsonb) RETURNING id`,
      [tenant.tenantId],
    );
    const eventId = rows[0]!.id;

    await expect(
      withTenant(app, { tenantId: tenant.tenantId, userId: user.userId }, async (client) => {
        await client.query('UPDATE outbox SET published_at = now() WHERE id = $1', [eventId]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('evento de uma comunidade nao e visivel por outra', async () => {
    const other = await seedTenant(owner, unique('outbox-b-'), 'Outbox B');
    const otherUser = await seedUser(owner, `${unique('outbox-b-')}@example.com`, 'Pessoa B');
    await seedMembership(owner, { tenantId: other.tenantId, userId: otherUser.userId, role: 'OWNER' });

    const rows = await withTenant(
      app,
      { tenantId: other.tenantId, userId: otherUser.userId },
      async (client) =>
        (await client.query('SELECT id FROM outbox WHERE tenant_id = $1', [tenant.tenantId])).rows,
    );
    expect(rows).toHaveLength(0);
  });

  it('a outbox recusa segredo no payload', async () => {
    await expect(
      withTenant(app, { tenantId: tenant.tenantId, userId: user.userId }, async (client) => {
        await client.query(
          `INSERT INTO outbox (tenant_id, event_type, payload)
           VALUES ($1, 'tenant.created', $2::jsonb)`,
          [tenant.tenantId, JSON.stringify({ apiKey: 'x', nested: { password: 'y' } })],
        );
      }),
    ).rejects.toThrow(/campo sensivel/i);
  });
});
