/**
 * Snapshot controlado dos contratos compartilhados.
 *
 * A separacao em dois repositorios cria um risco novo e especifico: as mesmas
 * definicoes passam a existir em dois lugares, e nada impede que uma delas seja
 * editada sozinha. Um `zod` que aceita um campo a mais de um lado e o recusa do
 * outro nao quebra nenhum typecheck — quebra o navegador de quem compra.
 *
 * Este script transforma essa divergencia em erro de CI. O backend e a FONTE:
 * aqui o manifesto e GERADO (`--write`). No frontend o mesmo arquivo e apenas
 * CONFERIDO. Se os hashes nao baterem, o build para e a diferenca e nomeada
 * arquivo a arquivo.
 *
 * O hash e calculado sobre o conteudo normalizado para LF. Sem isso, um clone
 * em Windows com `core.autocrlf=true` acusaria divergencia em cada arquivo —
 * o mesmo problema que o .gitattributes ja resolve para as migrations.
 *
 * Uso:
 *   node scripts/contracts-snapshot.mjs --write    (backend: regenera)
 *   node scripts/contracts-snapshot.mjs            (qualquer lado: confere)
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sharedRoot = join(repoRoot, 'packages', 'shared');
const manifestPath = join(sharedRoot, 'CONTRACTS_SNAPSHOT.json');

/**
 * As quatro arvores que os dois repositorios precisam enxergar identicas.
 * `src/frontend` e `styles/` ficam de fora de proposito: sao do frontend, e
 * evoluem sem pedir licenca ao backend.
 */
const TRACKED = ['src/contracts', 'src/states', 'src/permissions', 'src/constants'];

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function collect() {
  const files = {};
  for (const tracked of TRACKED) {
    for (const file of walk(join(sharedRoot, tracked)).sort()) {
      if (!file.endsWith('.ts')) continue;
      const normalized = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      // Chave sempre com '/': o manifesto precisa ser identico no Windows e no Linux.
      const key = relative(sharedRoot, file).split(sep).join('/');
      files[key] = createHash('sha256').update(normalized, 'utf8').digest('hex');
    }
  }
  return files;
}

const version = JSON.parse(readFileSync(join(sharedRoot, 'package.json'), 'utf8')).version;
const files = collect();
const digest = createHash('sha256')
  .update(Object.entries(files).map(([k, v]) => `${k} ${v}`).join('\n'), 'utf8')
  .digest('hex');

if (process.argv.includes('--write')) {
  const manifest = {
    _comment:
      'Gerado por scripts/contracts-snapshot.mjs no repositorio BACKEND, a fonte dos contratos. ' +
      'Nao editar a mao. O frontend carrega uma copia deste arquivo e apenas confere.',
    package: '@campaigns/shared',
    version,
    tracked: TRACKED,
    digest,
    files,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Manifesto gravado: ${relative(repoRoot, manifestPath)}`);
  console.log(`  versao ${version} · ${Object.keys(files).length} arquivos · digest ${digest.slice(0, 16)}...`);
  process.exit(0);
}

if (!existsSync(manifestPath)) {
  console.error(`Manifesto ausente: ${relative(repoRoot, manifestPath)}`);
  console.error('No backend, gere com: npm run contracts:snapshot');
  process.exit(1);
}

const expected = JSON.parse(readFileSync(manifestPath, 'utf8'));
const problems = [];

if (expected.version !== version) {
  problems.push(`versao do pacote ${version} != versao do manifesto ${expected.version}`);
}
for (const [file, hash] of Object.entries(expected.files ?? {})) {
  if (!(file in files)) problems.push(`ausente no disco: ${file}`);
  else if (files[file] !== hash) problems.push(`conteudo divergente: ${file}`);
}
for (const file of Object.keys(files)) {
  if (!(file in (expected.files ?? {}))) problems.push(`nao previsto no manifesto: ${file}`);
}

if (problems.length > 0) {
  console.error('Snapshot dos contratos DIVERGIU da fonte:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    '\nOs contratos sao versionados no repositorio BACKEND. Para atualizar:' +
      '\n  1. altere em tironirifa-backend/packages/shared' +
      '\n  2. rode `npm run contracts:snapshot` la, subindo a versao do pacote' +
      '\n  3. copie as arvores e o CONTRACTS_SNAPSHOT.json para este repositorio' +
      '\nNao editar os contratos diretamente aqui.',
  );
  process.exit(1);
}

console.log(`Snapshot dos contratos conferido: versao ${version} · ${Object.keys(files).length} arquivos · digest ${digest.slice(0, 16)}...`);
