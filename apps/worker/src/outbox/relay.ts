import type { DbPool, PoolClient } from '@campaigns/db';
import type { OutboxEventType } from '@campaigns/shared';

/**
 * Relay da outbox.
 *
 * FRONTEIRA DE RESPONSABILIDADE — o ponto mais facil de errar aqui:
 *
 *   A outbox e o REGISTRO do que aconteceu, gravado pela API na mesma
 *   transacao da mudanca. A fila (pg-boss) e quem EXECUTA.
 *
 *   O relay so faz uma coisa: levar o evento do registro ate a fila. Por isso
 *   `published_at` significa exatamente "entreguei a fila" — nada mais. NAO
 *   significa "o trabalho foi feito". A conclusao de cada consumidor fica em
 *   `event_consumptions`, que e outra tabela, com outra chave.
 *
 *   `published_at` so e gravado DEPOIS de a fila aceitar. Marcar antes
 *   produziria eventos silenciosamente perdidos: publicados no banco e nunca
 *   entregues.
 *
 * GARANTIA DE ENTREGA: AO MENOS UMA VEZ.
 *   Se a fila aceitar e o COMMIT que marca `published_at` falhar, o evento sera
 *   publicado outra vez na proxima rodada. Isso e esperado e nao ha como
 *   eliminar sem transacao distribuida. O que impede efeito duplicado e a
 *   idempotencia do CONSUMIDOR — nao ha promessa de "exatamente uma vez", e
 *   nenhuma constraint sozinha a produziria.
 *
 * ESGOTAMENTO (dead-letter): passado `maxAttempts`, o evento recebe
 * `dead_lettered_at` e sai do fluxo. Antes disso a rotina apenas empurrava
 * `available_at` uma hora para frente — e como o criterio de varredura e
 * "nao publicado e disponivel", o evento voltava a ser reclamado a cada hora,
 * para sempre. Isso nao e dead-letter: e um laco infinito lento, que mascara
 * o problema em vez de expo-lo. A linha continua na tabela, visivel; o que
 * cessa e a tentativa automatica.
 *
 * `FOR UPDATE SKIP LOCKED` permite varios relays em paralelo sem que dois
 * peguem a mesma linha.
 */

export interface OutboxRow {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
}

/** Publica um evento na fila. Deve rejeitar se a fila nao aceitar. */
export type Publisher = (event: {
  id: string;
  tenantId: string | null;
  eventType: OutboxEventType | string;
  payload: Record<string, unknown>;
}) => Promise<void>;

export interface RelayOptions {
  readonly batchSize: number;
  readonly maxAttempts: number;
  readonly retryBaseSeconds: number;
}

export interface RelayResult {
  readonly published: number;
  readonly failed: number;
  readonly exhausted: number;
}

async function claimBatch(client: PoolClient, batchSize: number): Promise<OutboxRow[]> {
  const { rows } = await client.query<OutboxRow>(
    `SELECT id, tenant_id, event_type, payload, attempts
       FROM outbox
      WHERE published_at IS NULL
        AND dead_lettered_at IS NULL
        AND available_at <= now()
      ORDER BY available_at, id
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [batchSize],
  );
  return rows;
}

/**
 * Uma rodada do relay.
 *
 * O worker conecta com `app_worker`, que tem policy propria na outbox: o relay
 * precisa enxergar eventos de TODAS as comunidades, senao nao teria como
 * drenar a fila. Esse papel nao recebe acesso as tabelas de negocio.
 */
export async function runRelayOnce(
  pool: DbPool,
  publish: Publisher,
  options: RelayOptions,
): Promise<RelayResult> {
  const client = await pool.connect();
  let published = 0;
  let failed = 0;
  let exhausted = 0;

  try {
    await client.query('BEGIN');
    const batch = await claimBatch(client, options.batchSize);

    for (const row of batch) {
      try {
        // A fila precisa aceitar ANTES de qualquer marcacao.
        await publish({
          id: row.id,
          tenantId: row.tenant_id,
          eventType: row.event_type,
          payload: row.payload,
        });

        await client.query(
          'UPDATE outbox SET published_at = now(), last_error = NULL WHERE id = $1',
          [row.id],
        );
        published += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const attempts = row.attempts + 1;

        if (attempts >= options.maxAttempts) {
          // Esgotou as tentativas. O evento NAO e descartado nem marcado como
          // publicado: fica parado, visivel, para inspecao. Descartar aqui
          // apagaria a unica prova de que algo precisava acontecer.
          //
          // `dead_lettered_at` e o que o tira do fluxo de verdade. Sem essa
          // marca, empurrar `available_at` apenas adia — o proximo
          // `claimBatch` reclamaria a mesma linha de novo, indefinidamente.
          await client.query(
            `UPDATE outbox
                SET attempts = $2,
                    last_error = $3,
                    dead_lettered_at = now()
              WHERE id = $1`,
            [row.id, attempts, message.slice(0, 2000)],
          );
          exhausted += 1;
        } else {
          // Recuo exponencial: 5s, 10s, 20s, 40s...
          const delaySeconds = options.retryBaseSeconds * 2 ** (attempts - 1);
          await client.query(
            `UPDATE outbox
                SET attempts = $2,
                    last_error = $3,
                    available_at = now() + make_interval(secs => $4)
              WHERE id = $1`,
            [row.id, attempts, message.slice(0, 2000), delaySeconds],
          );
          failed += 1;
        }
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.query('RESET ALL').catch(() => undefined);
    client.release();
  }

  return { published, failed, exhausted };
}
