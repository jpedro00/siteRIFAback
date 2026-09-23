import { migrate } from '../migrator.js';
import { loadRootEnv } from '../loadEnv.js';

/**
 * Aplica as migrations pendentes.
 *
 * Conecta com MIGRATION_DATABASE_URL (dono do schema), NAO com a credencial da
 * aplicacao: o papel app_user nao pode criar tabela nem alterar policy — e e
 * justamente por isso que a RLS vale para ele.
 */
async function main(): Promise<void> {
  await loadRootEnv();
  const url =
    process.env['MIGRATION_DATABASE_URL']?.trim() || process.env['DATABASE_URL']?.trim();

  if (!url) {
    throw new Error(
      'Defina MIGRATION_DATABASE_URL (preferencial) ou DATABASE_URL antes de rodar as migrations.',
    );
  }

  const result = await migrate(url);

  if (result.applied.length === 0) {
    console.log('nenhuma migration pendente.');
  } else {
    console.log(`migrations aplicadas (${result.applied.length}):`);
    for (const filename of result.applied) console.log(`  + ${filename}`);
  }
  if (result.skipped.length > 0) {
    console.log(`ja aplicadas (${result.skipped.length}).`);
  }
}

main().catch((error: unknown) => {
  console.error('migrate falhou:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
