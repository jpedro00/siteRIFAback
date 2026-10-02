import type { JobContext, JobDefinition } from './types.js';

/**
 * Executa UM ciclo de um job, com log de inicio e fim, duracao e contagem, e
 * grava o heartbeat — inclusive quando falha.
 *
 * O heartbeat e o que a API le para dizer "o worker esta vivo": se o processo
 * cair, nenhum ciclo novo e registrado e o atraso aparece. Gravar tambem a
 * FALHA (`last_error`, `consecutive_failures`) distingue "parado" de "rodando e
 * quebrando".
 *
 * Um erro do job nao e engolido: sobe para a fila, que o registra. Falha ao
 * gravar o proprio heartbeat, por outro lado, nunca derruba o job — saude nao
 * pode ser motivo para nao trabalhar.
 */
export async function runJob(def: JobDefinition, ctx: JobContext): Promise<number> {
  const log = ctx.log.child({ job: def.name });
  const inicio = new Date();
  log.info('job iniciado');

  let contagem = 0;
  let erro: unknown = null;
  try {
    contagem = await def.run({ ...ctx, log });
  } catch (error) {
    erro = error;
  }

  const fim = new Date();
  const duracaoMs = fim.getTime() - inicio.getTime();

  if (erro === null) {
    log.info('job concluido', { duration_ms: duracaoMs, count: contagem });
  } else {
    log.error('job falhou', {
      duration_ms: duracaoMs,
      error: erro instanceof Error ? erro.message : String(erro),
    });
  }

  try {
    await ctx.pool.query('SELECT app.worker_record_job_run($1, $2, $3, $4, $5, $6)', [
      def.name,
      def.intervalSeconds,
      inicio.toISOString(),
      fim.toISOString(),
      contagem,
      erro === null ? null : erro instanceof Error ? erro.message : String(erro),
    ]);
  } catch (error) {
    log.warn('nao foi possivel gravar o heartbeat', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (erro !== null) throw erro;
  return contagem;
}
