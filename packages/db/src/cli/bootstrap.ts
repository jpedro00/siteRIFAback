import pg from 'pg';
import { loadRootEnv } from '../loadEnv.js';
import { pgConnectionConfig } from '../ssl.js';

const { Client } = pg;

/**
 * Bootstrap do banco: cria o banco de dados e os DOIS papeis restritos que a
 * aplicacao usa.
 *
 * Fica fora das migrations de proposito. Criar papel exige privilegio
 * administrativo e envolve SENHA — e senha nao entra em arquivo versionado.
 *
 * Variaveis de ambiente:
 *   ADMIN_DATABASE_URL   conexao administrativa (ex.: postgres://postgres:...@localhost:5432/postgres)
 *   DATABASE_NAME        banco a criar (padrao: campaigns)
 *   APP_DB_PASSWORD      senha do papel app_user
 *   WORKER_DB_PASSWORD   senha do papel app_worker
 *
 * Uso:
 *   npm run db:bootstrap
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  }
  return value;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function main(): Promise<void> {
  await loadRootEnv();
  const adminUrl = requireEnv('ADMIN_DATABASE_URL');
  const databaseName = process.env['DATABASE_NAME']?.trim() || 'campaigns';
  const appPassword = requireEnv('APP_DB_PASSWORD');
  const workerPassword = requireEnv('WORKER_DB_PASSWORD');

  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(databaseName)) {
    throw new Error(`DATABASE_NAME invalido: ${databaseName}`);
  }

  const admin = new Client({
    ...pgConnectionConfig(adminUrl),
    application_name: 'campaigns-bootstrap',
  });
  await admin.connect();

  try {
    // ---- banco ----
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);
    if (existing.rowCount === 0) {
      // CREATE DATABASE nao aceita parametro e nao roda em transacao.
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      console.log(`banco criado: ${databaseName}`);
    } else {
      console.log(`banco ja existe: ${databaseName}`);
    }

    // ---- papeis ----
    // NOSUPERUSER / NOCREATEDB / NOCREATEROLE / NOBYPASSRLS sao explicitos:
    // um papel com BYPASSRLS tornaria toda a RLS decorativa, e o teste de
    // isolamento passaria sem provar nada.
    for (const [role, password] of [
      ['app_user', appPassword],
      ['app_worker', workerPassword],
    ] as const) {
      const atual = await admin.query<{
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolbypassrls: boolean;
        rolreplication: boolean;
      }>(
        `SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication
           FROM pg_roles WHERE rolname = $1`,
        [role],
      );

      if (atual.rowCount === 0) {
        await admin.query(
          `CREATE ROLE ${role} LOGIN PASSWORD ${quoteLiteral(password)} ` +
            'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
        );
        console.log(`papel criado: ${role}`);
      } else {
        await admin.query(`ALTER ROLE ${role} PASSWORD ${quoteLiteral(password)}`);

        /**
         * Atributos: VERIFICAR e corrigir apenas o que estiver errado.
         *
         * Reafirmar `NOSUPERUSER NOCREATEDB ...` de forma incondicional parece
         * inofensivo e nao e: num provedor gerenciado, quem roda o bootstrap
         * tem CREATEROLE mas NAO e superusuario, e o PostgreSQL recusa alterar
         * atributos que o proprio executor nao possui — mesmo para remove-los,
         * mesmo quando o papel ja esta exatamente como deveria. O comando
         * falhava com `permission denied to alter role` sem nada de errado
         * existir de fato.
         *
         * Verificar antes resolve os dois lados: nada a fazer quando o papel ja
         * esta correto, e falha ALTA E EXPLICITA quando esta errado e nao
         * podemos consertar — que e o unico caso em que seguir seria perigoso.
         */
        const errados: string[] = [];
        const linha = atual.rows[0]!;
        if (linha.rolsuper) errados.push('NOSUPERUSER');
        if (linha.rolcreatedb) errados.push('NOCREATEDB');
        if (linha.rolcreaterole) errados.push('NOCREATEROLE');
        if (linha.rolbypassrls) errados.push('NOBYPASSRLS');
        if (linha.rolreplication) errados.push('NOREPLICATION');

        if (errados.length === 0) {
          console.log(`papel ja existia com os atributos corretos: ${role}`);
        } else {
          try {
            await admin.query(`ALTER ROLE ${role} ${errados.join(' ')}`);
            console.log(`papel ja existia, atributos corrigidos (${errados.join(', ')}): ${role}`);
          } catch (error) {
            throw new Error(
              `O papel "${role}" tem atributos perigosos (${errados.join(', ')}) e a credencial ` +
                'administrativa nao tem privilegio para corrigi-los.\n' +
                'Um papel de aplicacao com SUPERUSER ou BYPASSRLS tornaria toda a RLS ' +
                'decorativa — o isolamento entre comunidades deixaria de valer.\n' +
                `Corrija com uma credencial privilegiada: ALTER ROLE ${role} ${errados.join(' ')};\n` +
                `Causa original: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
      await admin.query(`GRANT CONNECT ON DATABASE "${databaseName}" TO ${role}`);

      /**
       * O papel administrativo precisa conseguir `SET ROLE` para este papel.
       *
       * POR QUE ISTO NAO E OBVIO. Num PostgreSQL proprio, quem roda as
       * migrations e superusuario e pode assumir qualquer papel — a questao nem
       * aparece. Em provedor gerenciado (Supabase, por exemplo) o papel
       * administrativo NAO e superusuario: ele tem CREATEROLE, e no PostgreSQL
       * 16+ quem cria um papel recebe ADMIN sobre ele, mas NAO recebe `SET`.
       *
       * A diferenca e invisivel ate a migration 0007, que faz
       * `CREATE SCHEMA ... AUTHORIZATION app_worker` — atribuir a posse a outro
       * papel exige poder assumi-lo. Sem isto, a migration falha com
       * `must be able to SET ROLE "app_worker"`, e a mensagem nao diz onde
       * consertar.
       *
       * `WITH SET TRUE, INHERIT FALSE`: concede apenas o necessario. Sem
       * `INHERIT`, o papel administrativo nao passa a acumular em silencio os
       * privilegios dos papeis restritos — ele pode ASSUMI-los deliberadamente,
       * que e o que a atribuicao de posse requer, e nada alem disso.
       *
       * Idempotente e inofensivo quando o administrador ja e superusuario.
       */
      await admin.query(`GRANT ${role} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE`);
    }
  } finally {
    await admin.end();
  }

  console.log('\nbootstrap concluido. Proximo passo: npm run db:migrate');
}

main().catch((error: unknown) => {
  console.error('bootstrap falhou:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
