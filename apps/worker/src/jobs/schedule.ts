import type PgBoss from 'pg-boss';
import { JOBS } from './definitions.js';
import { runJob } from './runner.js';
import type { JobContext, JobDefinition } from './types.js';

/**
 * Agenda e liga os jobs no pg-boss.
 *
 * `boss.schedule` PERSISTE o agendamento no schema da fila: com dois workers no
 * ar, o pg-boss emite UM job por disparo (chave por janela de tempo), e nao dois.
 * Reiniciar o worker nao perde nem duplica o agendamento — chamar `schedule` de
 * novo com o mesmo nome apenas o atualiza.
 *
 * Cada job roda com concorrencia 1 e prazo de execucao proprio: um ciclo travado
 * nao segura o proximo para sempre.
 */
export const FUSO_DOS_JOBS = 'America/Sao_Paulo';

export async function registerJobs(
  boss: PgBoss,
  ctx: JobContext,
  jobs: readonly JobDefinition[] = JOBS,
): Promise<void> {
  for (const job of jobs) {
    await boss.createQueue(job.name);
    await boss.schedule(job.name, job.cron, {}, { tz: FUSO_DOS_JOBS });

    await boss.work(
      job.name,
      { batchSize: 1, pollingIntervalSeconds: 5 },
      async () => {
        await runJob(job, ctx);
      },
    );
    ctx.log.info('job agendado', { job: job.name, cron: job.cron, tz: FUSO_DOS_JOBS });
  }
}
