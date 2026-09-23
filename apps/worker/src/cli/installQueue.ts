import { loadRootEnv } from '@campaigns/db';
import { installQueue } from '../queue.js';

/**
 * Instala o schema da fila (pg-boss). Etapa ADMINISTRATIVA, uma vez por banco.
 *
 * Roda no mesmo momento das migrations, com o mesmo papel: quem instala precisa
 * de privilegio de criacao no banco, e o worker — que roda continuamente — nao
 * deve te-lo. Ver o comentario de `installQueue` para o porque exato.
 *
 * Variaveis:
 *   QUEUE_ADMIN_DATABASE_URL  conexao administrativa. Se ausente, usa
 *                             MIGRATION_DATABASE_URL: e o mesmo papel que aplica
 *                             as migrations, e a fila e parte do mesmo esquema
 *                             de implantacao.
 *   QUEUE_SCHEMA              schema da fila (padrao: pgboss)
 *   QUEUE_OWNER_ROLE          papel que recebe a POSSE (padrao: app_worker)
 *   DATABASE_SSL              'true' em provedor gerenciado
 *
 * Uso:
 *   npm run queue:install -w @campaigns/worker
 */
async function main(): Promise<void> {
  await loadRootEnv();

  const adminUrl =
    process.env['QUEUE_ADMIN_DATABASE_URL']?.trim() ||
    process.env['MIGRATION_DATABASE_URL']?.trim();

  if (!adminUrl) {
    throw new Error(
      'Defina QUEUE_ADMIN_DATABASE_URL (ou MIGRATION_DATABASE_URL). ' +
        'A instalacao da fila cria objetos e exige papel administrativo.',
    );
  }

  const schema = process.env['QUEUE_SCHEMA']?.trim() || 'pgboss';
  const ownerRole = process.env['QUEUE_OWNER_ROLE']?.trim() || 'app_worker';

  const { created } = await installQueue({
    adminConnectionString: adminUrl,
    schema,
    ownerRole,
    ssl: process.env['DATABASE_SSL'] === 'true',
  });

  console.log(
    created
      ? `fila criada no schema "${schema}".`
      : `fila ja existia no schema "${schema}"; nada a criar.`,
  );
  console.log(`posse dos objetos confirmada para "${ownerRole}".`);
  console.log('O worker ja pode subir com o papel restrito.');
}

main().catch((error: unknown) => {
  console.error('instalacao da fila falhou:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
