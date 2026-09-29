import type { DbPool } from '@clubedarifa/db';
import type { Logger } from '@clubedarifa/logging';
import type { PspGateway } from '@clubedarifa/psp';

/**
 * Um job agendado.
 *
 * `run` recebe o contexto e devolve QUANTOS registros tratou — e esse numero vai
 * para o log e para o heartbeat. Todo job e IDEMPOTENTE: rodar duas vezes seguidas
 * (dois workers, um retry, um deploy no meio) nao pode produzir efeito duplicado.
 * A idempotencia mora nas funcoes do banco (`app.worker_*`), que conferem o estado
 * na transacao; o job so decide QUAIS registros olhar.
 */
export interface JobContext {
  readonly pool: DbPool;
  readonly log: Logger;
  /** Provedor de pagamento; `null` = nenhum ligado (staging por padrao). */
  readonly psp: PspGateway | null;
}

export interface JobDefinition {
  /** Nome estavel: e o nome da fila, do agendamento e do heartbeat. */
  readonly name: string;
  /** Cron de 5 campos, no fuso `America/Sao_Paulo`. */
  readonly cron: string;
  /** Intervalo nominal, em segundos. O heartbeat considera atraso apos 3x isto. */
  readonly intervalSeconds: number;
  run(ctx: JobContext): Promise<number>;
}
