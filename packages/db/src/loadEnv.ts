import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Carrega o `.env` da RAIZ do monorepo.
 *
 * Os CLIs rodam a partir de `packages/db`, entao um `dotenv/config` simples
 * procuraria o arquivo na pasta errada e falharia em silencio — que e pior do
 * que falhar alto: a variavel ficaria ausente e o comando culparia o usuario.
 *
 * Variavel ja definida no ambiente TEM PRECEDENCIA sobre o arquivo: no CI as
 * credenciais vem do ambiente, e o `.env` nem existe.
 */
export async function loadRootEnv(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const rootEnv = resolve(here, '..', '..', '..', '.env');

  if (!existsSync(rootEnv)) return;

  const { config } = await import('dotenv');
  config({ path: rootEnv, override: false });
}
