import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext, withTenant, withoutContext } from '../src/context.js';
import type { DbPool } from '../src/pool.js';
import {
  appPool,
  describeSkipReason,
  ensureMigrated,
  hasTestDatabase,
  ownerPool,
  resetFoundationTables,
  seedDomain,
  seedMembership,
  seedTenant,
  seedUser,
  unique,
} from './helpers/testDb.js';

/**
 * RN01 · Isolamento entre comunidades, verificado com o PAPEL REAL DA
 * APLICACAO (app_user), nao com o dono do schema.
 *
 * Secao 8 do pedido, itens 3 e 4.
 */
describe.skipIf(!hasTestDatabase)(`RN01 · isolamento entre comunidades ${
  hasTestDatabase ? '' : describeSkipReason()
}`, () => {
  let owner: DbPool;
  let app: DbPool;

  let tenantA: { tenantId: string; slug: string };
  let tenantB: { tenantId: string; slug: string };
  let userA: { userId: string };
  let userB: { userId: string };
  let outsider: { userId: string };

  beforeAll(async () => {
    await ensureMigrated();
    await resetFoundationTables();
    owner = ownerPool();
    app = appPool();

    tenantA = await seedTenant(owner, unique('tenant-a-'), 'Comunidade A');
    tenantB = await seedTenant(owner, unique('tenant-b-'), 'Comunidade B');
    userA = await seedUser(owner, `${unique('a-')}@example.com`, 'Pessoa A');
    userB = await seedUser(owner, `${unique('b-')}@example.com`, 'Pessoa B');
    outsider = await seedUser(owner, `${unique('out-')}@example.com`, 'Sem vinculo');

    await seedMembership(owner, { tenantId: tenantA.tenantId, userId: userA.userId, role: 'OWNER' });
    await seedMembership(owner, { tenantId: tenantB.tenantId, userId: userB.userId, role: 'OWNER' });
    await seedDomain(owner, { tenantId: tenantA.tenantId, domain: `${tenantA.slug}.example.com` });
  });

  afterAll(async () => {
    await app?.end();
    await owner?.end();
  });

  it('a conexao da aplicacao nao tem BYPASSRLS (senao o teste nao provaria nada)', async () => {
    const { rows } = await app.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
      'SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user',
    );
    expect(rows[0]?.rolname).toBe('app_user');
    expect(rows[0]?.rolbypassrls).toBe(false);
    expect(rows[0]?.rolsuper).toBe(false);
  });

  it('a aplicacao nao e dona das tabelas (dono ignora policy)', async () => {
    const { rows } = await app.query<{ tableowner: string }>(
      "SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'memberships'",
    );
    expect(rows[0]?.tableowner).not.toBe('app_user');
  });

  it('item 3 · tenant A nao LE vinculos privados de B', async () => {
    const visible = await withTenant(
      app,
      { tenantId: tenantA.tenantId, userId: userA.userId },
      async (client) => {
        const { rows } = await client.query<{ tenant_id: string }>(
          'SELECT tenant_id FROM memberships',
        );
        return rows;
      },
    );

    expect(visible.length).toBeGreaterThan(0);
    for (const row of visible) {
      expect(row.tenant_id).toBe(tenantA.tenantId);
    }
    expect(visible.some((row) => row.tenant_id === tenantB.tenantId)).toBe(false);
  });

  it('item 3 · tenant A nao LE a comunidade B nem pedindo pelo id dela', async () => {
    const rows = await withTenant(
      app,
      { tenantId: tenantA.tenantId, userId: userA.userId },
      async (client) => {
        const result = await client.query('SELECT id FROM tenants WHERE id = $1', [
          tenantB.tenantId,
        ]);
        return result.rows;
      },
    );
    expect(rows).toHaveLength(0);
  });

  it('item 3 · tenant A nao ALTERA dados de B', async () => {
    const updated = await withTenant(
      app,
      { tenantId: tenantA.tenantId, userId: userA.userId },
      async (client) => {
        const result = await client.query('UPDATE tenants SET name = $1 WHERE id = $2', [
          'invadido',
          tenantB.tenantId,
        ]);
        return result.rowCount;
      },
    );
    expect(updated).toBe(0);

    const { rows } = await owner.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [
      tenantB.tenantId,
    ]);
    expect(rows[0]?.name).toBe('Comunidade B');
  });

  it('item 3 · tenant A nao RELACIONA um vinculo ao tenant_id de B', async () => {
    // A policy de INSERT exige tenant_id = contexto. Escrever com o id de B
    // dentro do contexto de A tem de ser recusado pelo banco, nao apenas pela
    // aplicacao.
    await expect(
      withTenant(app, { tenantId: tenantA.tenantId, userId: userA.userId }, async (client) => {
        await client.query(
          `INSERT INTO memberships (tenant_id, user_id, role, accepted_at)
           VALUES ($1, $2, 'SUPPORT', now())`,
          [tenantB.tenantId, userA.userId],
        );
      }),
    ).rejects.toThrow(/row-level security|violates/i);

    const { rows } = await owner.query('SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2', [
      tenantB.tenantId,
      userA.userId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('item 3 · a marca da comunidade B nao vaza no contexto de A', async () => {
    const rows = await withTenant(
      app,
      { tenantId: tenantA.tenantId, userId: userA.userId },
      async (client) => {
        const result = await client.query('SELECT tenant_id FROM tenant_branding');
        return result.rows as { tenant_id: string }[];
      },
    );
    for (const row of rows) expect(row.tenant_id).toBe(tenantA.tenantId);
  });

  it('identidade global: no contexto de A, o usuario de B nao e legivel', async () => {
    const rows = await withTenant(
      app,
      { tenantId: tenantA.tenantId, userId: userA.userId },
      async (client) => {
        const result = await client.query('SELECT id FROM users WHERE id = $1', [userB.userId]);
        return result.rows;
      },
    );
    // `users` nao tem tenant_id, mas nao e publica: a policy limita a leitura
    // ao proprio usuario e a equipe da comunidade resolvida.
    expect(rows).toHaveLength(0);
  });

  it('identidade global: o proprio usuario continua legivel', async () => {
    const rows = await withTenant(
      app,
      { tenantId: tenantA.tenantId, userId: userA.userId },
      async (client) => {
        const result = await client.query('SELECT id FROM users WHERE id = $1', [userA.userId]);
        return result.rows;
      },
    );
    expect(rows).toHaveLength(1);
  });

  it('segredo de MFA de outra pessoa nunca e legivel, nem pelo dono da comunidade', async () => {
    await owner.query(
      "INSERT INTO user_mfa_factors (user_id, secret_encrypted, confirmed_at) VALUES ($1, '\\x00'::bytea, now())",
      [userB.userId],
    );
    const rows = await withTenant(
      app,
      { tenantId: tenantA.tenantId, userId: userA.userId },
      async (client) => {
        const result = await client.query('SELECT id FROM user_mfa_factors');
        return result.rows;
      },
    );
    expect(rows).toHaveLength(0);
  });

  it('SEM contexto de comunidade, nenhum dado de comunidade e devolvido', async () => {
    const result = await withoutContext(app, async (client) => {
      const tenants = await client.query('SELECT id FROM tenants');
      const memberships = await client.query('SELECT id FROM memberships');
      const branding = await client.query('SELECT tenant_id FROM tenant_branding');
      return {
        tenants: tenants.rowCount,
        memberships: memberships.rowCount,
        branding: branding.rowCount,
      };
    });
    expect(result).toEqual({ tenants: 0, memberships: 0, branding: 0 });
  });

  it('contexto malformado NEGA em vez de liberar', async () => {
    // Um valor invalido nao pode virar "sem filtro". O helper recusa antes do
    // banco; o banco tambem devolveria NULL e negaria.
    await expect(
      withTenant(app, { tenantId: 'nao-e-uuid', userId: userA.userId }, async () => undefined),
    ).rejects.toThrow(/UUID/i);
  });

  it('item 5 · usuario sem vinculo nao enxerga a comunidade', async () => {
    // Mesmo que alguem force o tenant_id no contexto, a checagem de vinculo
    // devolve zero papeis — e e ela que a API usa para decidir abrir o painel.
    const roles = await withContext(
      app,
      { userId: outsider.userId, tenantId: null, platformAccess: false },
      async (client) => {
        const result = await client.query('SELECT role FROM app.my_roles_in_tenant($1)', [
          tenantA.tenantId,
        ]);
        return result.rows;
      },
    );
    expect(roles).toHaveLength(0);
  });

  it('item 5 · usuario com vinculo revogado deixa de enxergar a comunidade', async () => {
    const revoked = await seedUser(owner, `${unique('rev-')}@example.com`, 'Revogado');
    const membershipId = await seedMembership(owner, {
      tenantId: tenantA.tenantId,
      userId: revoked.userId,
      role: 'SUPPORT',
    });

    const before = await withContext(
      app,
      { userId: revoked.userId, tenantId: null, platformAccess: false },
      async (client) =>
        (await client.query('SELECT role FROM app.my_roles_in_tenant($1)', [tenantA.tenantId]))
          .rows,
    );
    expect(before).toHaveLength(1);

    await owner.query('UPDATE memberships SET revoked_at = now() WHERE id = $1', [membershipId]);

    const after = await withContext(
      app,
      { userId: revoked.userId, tenantId: null, platformAccess: false },
      async (client) =>
        (await client.query('SELECT role FROM app.my_roles_in_tenant($1)', [tenantA.tenantId]))
          .rows,
    );
    expect(after).toHaveLength(0);
  });

  it('convite ainda nao aceito nao concede acesso', async () => {
    const invited = await seedUser(owner, `${unique('inv-')}@example.com`, 'Convidado');
    await seedMembership(owner, {
      tenantId: tenantA.tenantId,
      userId: invited.userId,
      role: 'MARKETING',
      accepted: false,
    });

    const roles = await withContext(
      app,
      { userId: invited.userId, tenantId: null, platformAccess: false },
      async (client) =>
        (await client.query('SELECT role FROM app.my_roles_in_tenant($1)', [tenantA.tenantId]))
          .rows,
    );
    expect(roles).toHaveLength(0);
  });
});

/**
 * Secao 8, item 4 · o contexto nao pode sobreviver numa conexao reutilizada.
 */
describe.skipIf(!hasTestDatabase)('RN01 · contexto nao vaza entre transacoes', () => {
  let owner: DbPool;
  let app: DbPool;
  let tenantA: { tenantId: string; slug: string };
  let tenantB: { tenantId: string; slug: string };
  let userA: { userId: string };

  beforeAll(async () => {
    await ensureMigrated();
    owner = ownerPool();
    // Pool de UMA conexao: a segunda transacao usa necessariamente a mesma
    // conexao fisica da primeira. Sem isso, o teste poderia passar por sorte.
    app = appPool();
    tenantA = await seedTenant(owner, unique('leak-a-'), 'Vazamento A');
    tenantB = await seedTenant(owner, unique('leak-b-'), 'Vazamento B');
    userA = await seedUser(owner, `${unique('leak-')}@example.com`, 'Pessoa A');
    await seedMembership(owner, { tenantId: tenantA.tenantId, userId: userA.userId, role: 'OWNER' });
  });

  afterAll(async () => {
    await app?.end();
    await owner?.end();
  });

  it('item 4 · depois de uma transacao com contexto, a conexao volta sem contexto', async () => {
    await withTenant(app, { tenantId: tenantA.tenantId, userId: userA.userId }, async (client) => {
      const { rows } = await client.query<{ tenant: string | null }>(
        "SELECT current_setting('app.tenant_id', true) AS tenant",
      );
      expect(rows[0]?.tenant).toBe(tenantA.tenantId);
    });

    // Nova transacao SEM contexto, muito provavelmente na mesma conexao.
    const leaked = await withoutContext(app, async (client) => {
      const setting = await client.query<{ tenant: string | null }>(
        "SELECT current_setting('app.tenant_id', true) AS tenant",
      );
      const tenants = await client.query('SELECT id FROM tenants');
      return { setting: setting.rows[0]?.tenant ?? null, visible: tenants.rowCount };
    });

    expect(leaked.setting === null || leaked.setting === '').toBe(true);
    expect(leaked.visible).toBe(0);
  });

  it('item 4 · trocar de comunidade na mesma conexao nao mistura dados', async () => {
    const a = await withTenant(
      app,
      { tenantId: tenantA.tenantId, userId: userA.userId },
      async (client) => (await client.query('SELECT id FROM tenants')).rows as { id: string }[],
    );
    expect(a.map((r) => r.id)).toEqual([tenantA.tenantId]);

    const b = await withTenant(
      app,
      { tenantId: tenantB.tenantId, userId: userA.userId },
      async (client) => (await client.query('SELECT id FROM tenants')).rows as { id: string }[],
    );
    expect(b.map((r) => r.id)).toEqual([tenantB.tenantId]);
  });

  it('item 4 · erro dentro da transacao tambem limpa o contexto', async () => {
    await expect(
      withTenant(app, { tenantId: tenantA.tenantId, userId: userA.userId }, async (client) => {
        await client.query('SELECT 1');
        throw new Error('falha proposital');
      }),
    ).rejects.toThrow('falha proposital');

    const after = await withoutContext(app, async (client) => {
      const result = await client.query('SELECT id FROM tenants');
      return result.rowCount;
    });
    expect(after).toBe(0);
  });
});

/**
 * Resolucao de comunidade: dominio desconhecido nao cai em comunidade padrao.
 */
describe.skipIf(!hasTestDatabase)('RN01 · resolucao de comunidade por dominio e slug', () => {
  let owner: DbPool;
  let app: DbPool;
  let tenant: { tenantId: string; slug: string };

  beforeAll(async () => {
    await ensureMigrated();
    owner = ownerPool();
    app = appPool();
    tenant = await seedTenant(owner, unique('res-'), 'Resolucao');
    await seedDomain(owner, { tenantId: tenant.tenantId, domain: `${tenant.slug}.com.br`, verified: true, isPrimary: true });
    await seedDomain(owner, { tenantId: tenant.tenantId, domain: `nao-verificado-${tenant.slug}.com.br`, verified: false });
  });

  afterAll(async () => {
    await app?.end();
    await owner?.end();
  });

  it('dominio verificado resolve a comunidade', async () => {
    const rows = await withoutContext(app, async (client) =>
      (
        await client.query('SELECT tenant_id FROM app.resolve_tenant_by_domain($1)', [
          `${tenant.slug}.com.br`,
        ])
      ).rows as { tenant_id: string }[],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBe(tenant.tenantId);
  });

  it('dominio DESCONHECIDO devolve vazio, nunca uma comunidade padrao', async () => {
    const rows = await withoutContext(app, async (client) =>
      (await client.query('SELECT tenant_id FROM app.resolve_tenant_by_domain($1)', ['dominio-inexistente.com'])).rows,
    );
    expect(rows).toHaveLength(0);
  });

  it('dominio registrado mas NAO verificado nao resolve', async () => {
    const rows = await withoutContext(app, async (client) =>
      (
        await client.query('SELECT tenant_id FROM app.resolve_tenant_by_domain($1)', [
          `nao-verificado-${tenant.slug}.com.br`,
        ])
      ).rows,
    );
    expect(rows).toHaveLength(0);
  });

  it('slug resolve a comunidade e slug desconhecido devolve vazio', async () => {
    const found = await withoutContext(app, async (client) =>
      (await client.query('SELECT tenant_id FROM app.resolve_tenant_by_slug($1)', [tenant.slug])).rows,
    );
    expect(found).toHaveLength(1);

    const missing = await withoutContext(app, async (client) =>
      (await client.query('SELECT tenant_id FROM app.resolve_tenant_by_slug($1)', ['nao-existe-xyz'])).rows,
    );
    expect(missing).toHaveLength(0);
  });

  it('a resolucao por dominio nao serve para listar comunidades', async () => {
    // A funcao e de projecao minima: recebe um dominio e devolve no maximo uma
    // linha. Nao existe caminho que devolva a lista inteira.
    const rows = await withoutContext(app, async (client) =>
      (await client.query('SELECT tenant_id FROM app.resolve_tenant_by_domain($1)', ['%'])).rows,
    );
    expect(rows).toHaveLength(0);
  });
});
