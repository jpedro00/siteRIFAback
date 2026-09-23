import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { loadMigrations, migrate } from '../src/migrator.js';
import { pgConnectionConfig } from '../src/ssl.js';
import {
  TEST_OWNER_URL,
  describeSkipReason,
  hasTestDatabase,
} from './helpers/testDb.js';

const { Client } = pg;

/**
 * Secao 8 do pedido, item 1 · as migrations rodam num PostgreSQL VAZIO.
 *
 * O teste cria um banco novo, aplica tudo do zero e confere o schema
 * resultante. Rodar migrations sobre um banco que ja tem as tabelas nao prova
 * que elas nascem corretas: coluna e CHECK criadas por patch manual passariam
 * despercebidas (E6).
 */

function databaseUrlWith(base: string, databaseName: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

const tempDatabase = `campaigns_migtest_${Math.floor(Math.random() * 1e9).toString(36)}`;

describe.skipIf(!hasTestDatabase)(`migrations em banco vazio ${
  hasTestDatabase ? '' : describeSkipReason()
}`, () => {
  let created = false;
  let tempUrl = '';

  beforeAll(async () => {
    tempUrl = databaseUrlWith(TEST_OWNER_URL, tempDatabase);
    const admin = new Client(pgConnectionConfig(TEST_OWNER_URL));
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${tempDatabase}"`);
      created = true;
    } finally {
      await admin.end();
    }
  });

  afterAll(async () => {
    if (!created) return;
    const admin = new Client(pgConnectionConfig(TEST_OWNER_URL));
    await admin.connect();
    try {
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        [tempDatabase],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${tempDatabase}"`);
    } finally {
      await admin.end();
    }
  });

  it('item 1 · aplica todas as migrations do zero', async () => {
    const files = await loadMigrations();
    expect(files.length).toBeGreaterThan(0);

    const result = await migrate(tempUrl);
    expect(result.applied).toEqual(files.map((file) => file.filename));
    expect(result.skipped).toHaveLength(0);
  });

  it('item 1 · rodar de novo nao reaplica nada (idempotente)', async () => {
    const result = await migrate(tempUrl);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it('cria todas as tabelas exigidas pela fundacao', async () => {
    const client = new Client(pgConnectionConfig(tempUrl));
    await client.connect();
    try {
      const { rows } = await client.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
      );
      const tables = rows.map((row) => row.tablename);

      // Exigidas pelo pedido, secao 6.
      for (const required of [
        'tenants',
        'tenant_branding',
        'users',
        'memberships',
        'audit_events',
        'outbox',
      ]) {
        expect(tables).toContain(required);
      }

      // Auxiliares da autenticacao escolhida.
      for (const auxiliary of [
        'user_credentials',
        'user_mfa_factors',
        'sessions',
        'platform_admins',
        'tenant_domains',
        'event_consumptions',
      ]) {
        expect(tables).toContain(auxiliary);
      }
    } finally {
      await client.end();
    }
  });

  it('toda tabela de negocio por comunidade tem tenant_id e RLS ativa', async () => {
    const client = new Client(pgConnectionConfig(tempUrl));
    await client.connect();
    try {
      // A raiz da arvore. `tenants.id` E o tenant_id: exigir uma coluna
      // `tenant_id` apontando para si mesma nao faria sentido.
      const tenantRoot = ['tenants'];
      // Identidade global e a excecao DOCUMENTADA: users, credenciais, fator
      // MFA e sessoes nao tem tenant_id de proposito (ver 0003).
      const globalIdentity = ['users', 'user_credentials', 'user_mfa_factors', 'sessions', 'platform_admins'];
      // Tabelas de infraestrutura com tenant_id NULO permitido (evento e
      // trilha de plataforma).
      const nullableTenant = ['audit_events', 'outbox'];
      const internal = ['schema_migrations', 'event_consumptions'];

      const { rows: tableRows } = await client.query<{ tablename: string; rowsecurity: boolean }>(
        `SELECT c.relname AS tablename, c.relrowsecurity AS rowsecurity
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'
          ORDER BY c.relname`,
      );

      for (const table of tableRows) {
        if (internal.includes(table.tablename)) continue;

        // RLS ativa em tudo que a aplicacao acessa.
        expect(table.rowsecurity, `${table.tablename} deveria ter RLS ativa`).toBe(true);

        if (
          tenantRoot.includes(table.tablename) ||
          globalIdentity.includes(table.tablename) ||
          nullableTenant.includes(table.tablename)
        ) {
          continue;
        }

        const { rows: columns } = await client.query<{ column_name: string; is_nullable: string }>(
          `SELECT column_name, is_nullable
             FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'tenant_id'`,
          [table.tablename],
        );
        expect(columns, `${table.tablename} deveria ter tenant_id`).toHaveLength(1);
        expect(
          columns[0]?.is_nullable,
          `${table.tablename}.tenant_id deveria ser NOT NULL`,
        ).toBe('NO');
      }
    } finally {
      await client.end();
    }
  });

  it('a raiz `tenants` e identificada pela propria PK, e tem RLS', async () => {
    const client = new Client(pgConnectionConfig(tempUrl));
    await client.connect();
    try {
      const { rows } = await client.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'id'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.data_type).toBe('uuid');

      const rls = await client.query<{ relrowsecurity: boolean }>(
        "SELECT relrowsecurity FROM pg_class WHERE relname = 'tenants'",
      );
      expect(rls.rows[0]?.relrowsecurity).toBe(true);
    } finally {
      await client.end();
    }
  });

  it('editar uma migration ja aplicada e recusado', async () => {
    const client = new Client(pgConnectionConfig(tempUrl));
    await client.connect();
    try {
      await client.query("UPDATE schema_migrations SET checksum = 'alterado' WHERE version = '0001'");
    } finally {
      await client.end();
    }

    await expect(migrate(tempUrl)).rejects.toThrow(/mudou depois de aplicada/i);
  });
});
