import pg from 'pg';
import { createPool, type DbPool } from '../../src/pool.js';
import { pgConnectionConfig } from '../../src/ssl.js';
import { migrate } from '../../src/migrator.js';

const { Client } = pg;

/**
 * Infraestrutura dos testes de banco.
 *
 * Tres conexoes, de proposito:
 *   OWNER  · roda migrations e semeia dados. E dono do schema e NAO sofre RLS.
 *   APP    · papel app_user, o MESMO que a API usa em producao.
 *   WORKER · papel app_worker, o mesmo que o worker usa.
 *
 * Todo teste de isolamento roda pela conexao APP. Testar RLS como dono ou como
 * superusuario nao prova nada: o dono ignora as policies.
 */

export const TEST_OWNER_URL = process.env['TEST_MIGRATION_DATABASE_URL'] ?? '';
export const TEST_APP_URL = process.env['TEST_APP_DATABASE_URL'] ?? '';
export const TEST_WORKER_URL = process.env['TEST_WORKER_DATABASE_URL'] ?? '';

/**
 * Sem banco configurado os testes de banco sao PULADOS, nunca substituidos por
 * mock. Um mock de RLS provaria apenas que o mock funciona.
 */
export const hasTestDatabase =
  TEST_OWNER_URL !== '' && TEST_APP_URL !== '' && TEST_WORKER_URL !== '';

export function describeSkipReason(): string {
  return (
    'PULADO: defina TEST_MIGRATION_DATABASE_URL, TEST_APP_DATABASE_URL e ' +
    'TEST_WORKER_DATABASE_URL para rodar os testes de banco.'
  );
}

let migrated = false;

/** Aplica as migrations uma unica vez por processo de teste. */
export async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  await migrate(TEST_OWNER_URL);
  migrated = true;
}

export function ownerPool(): DbPool {
  return createPool({ connectionString: TEST_OWNER_URL, applicationName: 'test-owner', max: 4 });
}

export function appPool(): DbPool {
  return createPool({ connectionString: TEST_APP_URL, applicationName: 'test-app', max: 4 });
}

export function workerPool(): DbPool {
  return createPool({ connectionString: TEST_WORKER_URL, applicationName: 'test-worker', max: 4 });
}

/**
 * Limpa as tabelas da fundacao entre suites.
 *
 * `audit_events` NAO pode ser truncada nem deletada — nem pelo dono: o trigger
 * de 0004 barra UPDATE, DELETE e TRUNCATE. Isso e o comportamento correto
 * (RN11) e a limpeza abaixo o respeita: os testes que leem a trilha filtram
 * pelos proprios identificadores em vez de supor tabela vazia.
 */
export async function resetFoundationTables(): Promise<void> {
  const client = new Client(pgConnectionConfig(TEST_OWNER_URL));
  await client.connect();
  try {
    // A ordem respeita as chaves estrangeiras. `tenants` cascateia para
    // branding, dominios e memberships.
    await client.query('DELETE FROM event_consumptions');
    await client.query('DELETE FROM outbox');
    await client.query('DELETE FROM sessions');
    await client.query('DELETE FROM user_mfa_factors');
    await client.query('DELETE FROM user_credentials');
    await client.query('DELETE FROM platform_admins');
    await client.query('DELETE FROM memberships');
    // ---------------------------------------------------------------------
    // Fase 2 · sorteios, reservas e pedidos.
    //
    // Precisa vir ANTES da limpeza de comunidades: `orders` e `draws`
    // referenciam a comunidade, e a remocao falharia na chave estrangeira.
    //
    // O gatilho `draw_numbers_protect_paid` (RN18) recusa DELETE de numero
    // PAGO — inclusive para o dono da tabela. E o comportamento correto: um
    // numero vendido nao some. Aqui ele e SUSPENSO por um instante, porque
    // limpar a base entre suites nao e a operacao que a regra protege.
    //
    // Isto nao enfraquece a RN18 em producao: desligar gatilho exige ser dono
    // da tabela, e nem `app_user` nem `app_worker` sao. A regra continua de pe
    // para todo caminho que a aplicacao percorre.
    // ---------------------------------------------------------------------
    await client.query('ALTER TABLE draw_numbers DISABLE TRIGGER draw_numbers_protect_paid');
    try {
      await client.query('DELETE FROM order_items');
      await client.query('DELETE FROM draw_numbers');
      await client.query('DELETE FROM orders');
      await client.query('DELETE FROM reservations');
      await client.query('DELETE FROM buyers');
      await client.query('DELETE FROM draws');
    } finally {
      await client.query('ALTER TABLE draw_numbers ENABLE TRIGGER draw_numbers_protect_paid');
    }
    // audit_events referencia tenants e users com ON DELETE RESTRICT, entao
    // qualquer linha remanescente impediria a limpeza. Os testes usam tenants
    // proprios; aqui removemos apenas o que nao esta amarrado a trilha.
    await client.query(`
      DELETE FROM tenants t
      WHERE NOT EXISTS (SELECT 1 FROM audit_events a WHERE a.tenant_id = t.id)
    `);
    await client.query(`
      DELETE FROM users u
      WHERE NOT EXISTS (SELECT 1 FROM audit_events a WHERE a.actor_user_id = u.id)
    `);
  } finally {
    await client.end();
  }
}

export interface SeededTenant {
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
}

export interface SeededUser {
  readonly userId: string;
  readonly email: string;
}

/**
 * Semeia uma comunidade pela conexao OWNER.
 * Semear como dono e legitimo: o que precisa ser provado sob RLS e a LEITURA e
 * a ESCRITA da aplicacao, nao a criacao do cenario.
 */
export async function seedTenant(pool: DbPool, slug: string, name: string): Promise<SeededTenant> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
    [slug, name],
  );
  const tenantId = rows[0]!.id;
  await pool.query('INSERT INTO tenant_branding (tenant_id, public_name) VALUES ($1, $2)', [
    tenantId,
    name,
  ]);
  return { tenantId, slug, name };
}

export async function seedUser(pool: DbPool, email: string, displayName: string): Promise<SeededUser> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id',
    [email.toLowerCase(), displayName],
  );
  return { userId: rows[0]!.id, email: email.toLowerCase() };
}

export async function seedMembership(
  pool: DbPool,
  input: { tenantId: string; userId: string; role: string; accepted?: boolean },
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO memberships (tenant_id, user_id, role, accepted_at)
     VALUES ($1, $2, $3::membership_role, CASE WHEN $4 THEN now() ELSE NULL END)
     RETURNING id`,
    [input.tenantId, input.userId, input.role, input.accepted ?? true],
  );
  return rows[0]!.id;
}

export async function seedDomain(
  pool: DbPool,
  input: { tenantId: string; domain: string; verified?: boolean; isPrimary?: boolean },
): Promise<void> {
  await pool.query(
    `INSERT INTO tenant_domains (tenant_id, domain, is_primary, verified_at)
     VALUES ($1, $2, $3, CASE WHEN $4 THEN now() ELSE NULL END)`,
    [input.tenantId, input.domain.toLowerCase(), input.isPrimary ?? false, input.verified ?? true],
  );
}

/** Sufixo unico para evitar colisao de slug/e-mail entre arquivos de teste. */
export function unique(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
