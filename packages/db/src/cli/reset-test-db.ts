import pg from 'pg';
import { loadRootEnv } from '../loadEnv.js';

const { Client } = pg;

/**
 * Recria o banco de TESTE do zero e aplica as migrations.
 *
 * Por que existe: `schema_migrations` guarda o checksum de cada migration
 * aplicada, e o runner recusa rodar quando um arquivo ja aplicado muda
 * (prevencao do erro E6 — coluna e CHECK criadas por patch manual). Essa
 * guarda e correta, mas trava o banco quando a migration mudou legitimamente
 * durante o desenvolvimento, antes de existir producao.
 *
 * A saida certa NAO e afrouxar a guarda nem editar `schema_migrations` na mao:
 * e reconstruir o banco a partir do repositorio, que e a fonte da verdade.
 *
 * QUAL BANCO E RECONSTRUIDO: o nome sai de `TEST_MIGRATION_DATABASE_URL`, a
 * mesma URL que a suite usa para migrar. Ler o nome de uma variavel separada
 * permitiria apagar um banco e migrar outro — exatamente o tipo de descuido
 * que este script existe para evitar.
 *
 * SEGURANCA: recusa qualquer banco cujo nome nao termine em `_test`. Este
 * script APAGA o banco inteiro.
 *
 * Uso:
 *   npm run db:reset-test
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  }
  return value;
}

function databaseNameFrom(connectionString: string, varName: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(`${varName} nao e uma URL de conexao valida.`);
  }
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (name === '') {
    throw new Error(`${varName} nao indica um banco de dados no caminho da URL.`);
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Nome de banco invalido em ${varName}: ${name}`);
  }
  return name;
}

async function main(): Promise<void> {
  await loadRootEnv();

  const adminUrl = requireEnv('ADMIN_DATABASE_URL');
  const testMigrationUrl = requireEnv('TEST_MIGRATION_DATABASE_URL');
  const databaseName = databaseNameFrom(testMigrationUrl, 'TEST_MIGRATION_DATABASE_URL');

  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Recusado: "${databaseName}" nao termina em "_test". ` +
        'Este script apaga o banco inteiro e so opera sobre bancos de teste.',
    );
  }

  // O admin nao pode estar conectado ao banco que sera derrubado.
  if (databaseNameFrom(adminUrl, 'ADMIN_DATABASE_URL') === databaseName) {
    throw new Error(
      `ADMIN_DATABASE_URL aponta para "${databaseName}", que sera derrubado. ` +
        'Use uma conexao administrativa a outro banco (por exemplo, "postgres").',
    );
  }

  const admin = new Client({ connectionString: adminUrl, application_name: 'campaigns-reset-test' });
  await admin.connect();
  try {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [databaseName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    console.log(`banco removido: ${databaseName}`);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    console.log(`banco recriado: ${databaseName}`);

    for (const role of ['app_user', 'app_worker']) {
      const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (exists.rowCount === 0) {
        throw new Error(`Papel "${role}" nao existe. Rode primeiro: npm run db:bootstrap`);
      }
      await admin.query(`GRANT CONNECT ON DATABASE "${databaseName}" TO ${role}`);
    }
  } finally {
    await admin.end();
  }

  const { migrate } = await import('../migrator.js');
  const result = await migrate(testMigrationUrl);

  console.log(`\nmigrations aplicadas (${result.applied.length}):`);
  for (const filename of result.applied) console.log(`  + ${filename}`);

  // Mostra o registro final, para conferencia do checksum de cada versao.
  const check = new Client({ connectionString: testMigrationUrl });
  await check.connect();
  try {
    const { rows } = await check.query<{ version: string; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    );
    console.log('\nschema_migrations:');
    for (const row of rows) {
      console.log(`  ${row.version}  ${row.name.padEnd(28)}  ${row.checksum.slice(0, 16)}…`);
    }
  } finally {
    await check.end();
  }

  console.log('\nbanco de teste pronto. Rode: npm test');
}

main().catch((error: unknown) => {
  console.error('reset falhou:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
