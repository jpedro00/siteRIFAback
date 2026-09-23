import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig } from './ssl.js';

const { Client } = pg;

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

const FILENAME_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/**
 * Checksum do CONTEUDO da migration, insensivel a fim de linha.
 *
 * POR QUE NORMALIZAR ANTES DE HASHEAR. A guarda de checksum existe para pegar
 * migration EDITADA depois de aplicada (erro E6). Hashear os bytes crus faz ela
 * disparar tambem quando nada mudou no SQL: basta o Git materializar o arquivo
 * com CRLF em vez de LF, o que ele faz por padrao no Windows (`core.autocrlf`).
 *
 * O sintoma e desconcertante e caro: o CI em Linux aplica as migrations, um
 * desenvolvedor em Windows clona o mesmo commit e o migrador recusa rodar
 * dizendo que `0001` "mudou depois de aplicada" — apontando para um arquivo que
 * ninguem tocou. Pior: a suspeita natural e de que o banco foi adulterado.
 *
 * `\r\n` -> `\n` faz o checksum descrever o SQL, nao a plataforma que o
 * escreveu. Bancos ja migrados continuam validos: arquivos gravados com LF
 * produzem exatamente o mesmo hash de antes.
 */
function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const files = entries.filter((entry) => entry.endsWith('.sql')).sort();

  const migrations: MigrationFile[] = [];
  for (const filename of files) {
    const match = FILENAME_RE.exec(filename);
    if (!match) {
      throw new Error(
        `Migration com nome fora do padrao: ${filename}. Use NNNN_nome_em_snake_case.sql`,
      );
    }
    const sql = await readFile(join(dir, filename), 'utf8');
    migrations.push({
      version: match[1]!,
      name: match[2]!,
      filename,
      sql,
      checksum: checksumOf(sql),
    });
  }

  const versions = new Set<string>();
  for (const migration of migrations) {
    if (versions.has(migration.version)) {
      throw new Error(`Duas migrations com a versao ${migration.version}.`);
    }
    versions.add(migration.version);
  }

  return migrations;
}

const CREATE_TRACKING_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     text PRIMARY KEY,
    name        text NOT NULL,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  );
`;

export interface MigrateResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Aplica as migrations pendentes, cada uma na PROPRIA transacao.
 *
 * Uma migration ja aplicada tem o checksum conferido: editar um arquivo
 * versionado depois de aplicado e erro, nao atualizacao silenciosa (erros E3 e
 * E6). Coluna ou restricao criada por patch manual, fora do arquivo
 * versionado, produz bancos que divergem em silencio entre ambientes.
 */
export async function migrate(connectionString: string, dir?: string): Promise<MigrateResult> {
  const migrations = await loadMigrations(dir);
  const client = new Client({
    ...pgConnectionConfig(connectionString),
    application_name: 'campaigns-migrator',
  });
  await client.connect();

  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await client.query(CREATE_TRACKING_TABLE);

    const { rows } = await client.query<{ version: string; checksum: string; name: string }>(
      'SELECT version, checksum, name FROM schema_migrations',
    );
    const alreadyApplied = new Map(rows.map((row) => [row.version, row]));

    for (const migration of migrations) {
      const previous = alreadyApplied.get(migration.version);

      if (previous) {
        if (previous.checksum !== migration.checksum) {
          throw new Error(
            `Migration ${migration.filename} mudou depois de aplicada.\n` +
              `  checksum no banco: ${previous.checksum}\n` +
              `  checksum no arquivo: ${migration.checksum}\n` +
              'Crie uma migration nova em vez de editar uma ja aplicada.',
          );
        }
        skipped.push(migration.filename);
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.name, migration.checksum],
        );
        await client.query('COMMIT');
        applied.push(migration.filename);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Falha na migration ${migration.filename}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
    }
  } finally {
    await client.end();
  }

  return { applied, skipped };
}
