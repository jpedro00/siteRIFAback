import type { DbPool } from '@campaigns/db';
import { runRelayOnce, type Publisher, type RelayOptions } from './relay.js';

/**
 * Laco do relay: uma rodada, espera, outra rodada.
 *
 * ENCERRAMENTO — a parte que importa e a que se erra.
 *
 * `stop()` e ASSINCRONO e espera a rodada CORRENTE terminar. Um `stop()` que
 * apenas marcasse a flag e limpasse o temporizador devolveria o controle com
 * uma transacao ainda aberta — e quem chamou seguiria para `pool.end()`,
 * derrubando a conexao no meio dela. O resultado seria o pior caso possivel
 * numa outbox: um evento entregue a fila **sem** `published_at` gravado, que
 * seria publicado de novo na proxima subida.
 *
 * A entrega e AO MENOS UMA VEZ e o consumidor e idempotente, entao a duplicata
 * nao corrompe nada — mas desligar produzindo trabalho repetido de proposito,
 * podendo simplesmente esperar a rodada acabar, e desleixo.
 *
 * Depois de `stop()` nenhuma rodada nova e agendada: se o sinal chegou durante
 * uma rodada, ela termina e o laco morre ali.
 */
export interface RelayLoop {
  /** Espera a rodada corrente e nao agenda outra. Idempotente. */
  stop(): Promise<void>;
  /** Rodadas concluidas desde a subida. Usado em diagnostico e em teste. */
  readonly rounds: number;
}

export interface RelayLoopOptions extends RelayOptions {
  readonly pollIntervalMs: number;
  /** Injetavel para teste; o padrao registra no console do processo. */
  readonly log?: (message: string) => void;
}

export function startRelayLoop(
  pool: DbPool,
  publish: Publisher,
  options: RelayLoopOptions,
): RelayLoop {
  const log = options.log ?? ((message: string) => console.log(message));

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let rounds = 0;

  /** Promessa da rodada corrente. `stop()` espera exatamente esta. */
  let current: Promise<void> = Promise.resolve();

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await runRelayOnce(pool, publish, options);
      rounds += 1;
      if (result.published > 0 || result.failed > 0) {
        log(
          `[relay] publicados=${result.published} falhas=${result.failed} ` +
            `esgotados=${result.exhausted}`,
        );
      }
      if (result.exhausted > 0) {
        // Nivel proprio: um evento esgotado nao volta sozinho. Se passar
        // despercebido no log, passa despercebido para sempre.
        log(
          `[relay] DEAD-LETTER: ${result.exhausted} evento(s) esgotaram as tentativas ` +
            'e sairam do fluxo; exigem inspecao manual',
        );
      }
    } catch (error) {
      // O relay nao pode morrer por uma rodada ruim: a proxima tenta de novo.
      log(`[relay] rodada falhou: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          current = tick();
        }, options.pollIntervalMs);
      }
    }
  };

  current = tick();

  return {
    get rounds() {
      return rounds;
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      // Um `catch` aqui e deliberado: a rodada ja tratou e registrou o proprio
      // erro; o que o encerramento precisa e que ela tenha TERMINADO.
      await current.catch(() => undefined);
    },
  };
}
