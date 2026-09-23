import { readFileSync } from 'node:fs';

/**
 * Falha se a suite pulou algum teste.
 *
 * POR QUE ISTO EXISTE: os testes de RLS, auditoria, outbox e fila se AUTO-PULAM
 * quando as TEST_*_DATABASE_URL nao estao no ambiente. Esse comportamento e
 * correto na maquina de quem ainda nao subiu um PostgreSQL — mas no CI ele
 * transformaria "o banco nao foi configurado" em "tudo passou". Um verde sem os
 * testes de isolamento e pior do que um vermelho: ele afirma uma garantia que
 * ninguem verificou.
 *
 * Le o relatorio JSON da MESMA execucao que ja rodou, em vez de rodar a suite
 * outra vez.
 */
const REPORT = '.vitest-report.json';

let report;
try {
  report = JSON.parse(readFileSync(REPORT, 'utf8'));
} catch (error) {
  console.error(
    `FALHA: nao foi possivel ler ${REPORT}. ` +
      'O passo de testes precisa rodar com --reporter=json --outputFile=' +
      `${REPORT}.`,
  );
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const total = report.numTotalTests ?? 0;
const skipped = report.numPendingTests ?? 0;
const todo = report.numTodoTests ?? 0;
const failed = report.numFailedTests ?? 0;

if (total === 0) {
  console.error('FALHA: a suite nao coletou nenhum teste.');
  process.exit(1);
}

if (skipped > 0 || todo > 0) {
  console.error(
    `FALHA: ${skipped + todo} teste(s) pulado(s). ` +
      'Os testes de banco e de fila precisam rodar no CI.',
  );
  for (const file of report.testResults ?? []) {
    for (const test of file.assertionResults ?? []) {
      if (test.status === 'pending' || test.status === 'todo') {
        console.error(`  - ${test.fullName}`);
      }
    }
  }
  process.exit(1);
}

if (failed > 0) {
  console.error(`FALHA: ${failed} teste(s) falharam.`);
  process.exit(1);
}

console.log(`Nenhum teste pulado. ${total} teste(s) executados.`);
