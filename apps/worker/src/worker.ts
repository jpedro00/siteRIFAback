import { pathToFileURL } from 'node:url';
import { createPool, loadRootEnv, type DbPool } from '@clubedarifa/db';
import type PgBoss from 'pg-boss';
import { createPaymentAccountsRuntime } from '@clubedarifa/payment-accounts';
import { StripeBillingGateway } from '@clubedarifa/billing';
import { loadWorkerConfig, type WorkerConfig } from './config.js';
import { buildPublisher, FOUNDATION_QUEUE, startQueue, type QueueMessage } from './queue.js';
import { startRelayLoop, type RelayLoop } from './outbox/relayLoop.js';
import { handleMessage } from './dispatch.js';
import { registerJobs } from './jobs/schedule.js';
import { log } from './lib/log.js';

/**
 * Processo do worker.
 *
 * Duas engrenagens separadas:
 *   RELAY      le a outbox e entrega a fila. So isso.
 *   CONSUMIDOR tira da fila e executa, de forma idempotente.
 *
 * Nenhuma cobranca e nenhum envio comercial acontecem aqui: a fundacao nao
 * implementa pagamento nem mensagem. O unico consumidor da fase provisiona a
 * marca padrao de uma comunidade recem-criada.
 */

export interface WorkerRuntime {
  readonly boss: PgBoss;
  readonly pool: DbPool;
  readonly relay: RelayLoop;
  /** Encerramento gracioso. Idempotente: chamar duas vezes e seguro. */
  stop(reason?: string): Promise<void>;
}

async function startConsumer(boss: PgBoss, pool: DbPool): Promise<void> {
  await boss.work<QueueMessage>(FOUNDATION_QUEUE, { batchSize: 10 }, async (jobs) => {
    for (const job of jobs) {
      await handleMessage(pool, job.data);
    }
  });
}

/**
 * Sobe o worker e devolve um controle de ciclo de vida.
 *
 * Separado de `main()` de proposito: com o encerramento preso dentro do
 * manipulador de sinal, a unica forma de verifica-lo seria matar um processo de
 * verdade — que e justamente o que nao da para fazer de dentro da suite em
 * algumas plataformas. Aqui a ORDEM do desligamento pode ser exercitada
 * diretamente.
 */
export async function startWorker(config: WorkerConfig): Promise<WorkerRuntime> {
  const pool = createPool({
    connectionString: config.WORKER_DATABASE_URL,
    applicationName: 'clubedarifa-worker',
    ssl: config.DATABASE_SSL,
  });

  const boss = await startQueue(config);
  console.log(`[fila] pronta no schema "${config.QUEUE_SCHEMA}"`);

  await startConsumer(boss, pool);

  // Jobs agendados (expirar reservas e PIX, fechar sorteios, conciliar, limpar).
  // O PSP e opcional: sem ele, os jobs de PIX avisam e nao liberam nada.
  const billing =
    config.BILLING_PROVIDER === 'stripe'
      ? new StripeBillingGateway({
          secretKey: config.STRIPE_SECRET_KEY!,
          webhookSecret: config.STRIPE_WEBHOOK_SECRET!,
          allowLive: config.NODE_ENV === 'production',
        })
      : null;
  // Recebimentos por comunidade: so ligado com PSP_PROVIDER=mercadopago e o aplicativo OAuth.
  // Nao existe credencial global: sem runtime, os jobs de PIX avisam e nao liberam nada.
  const paymentAccounts =
    config.PSP_PROVIDER === 'mercadopago'
      ? createPaymentAccountsRuntime(pool, {
          clientId: config.MERCADOPAGO_OAUTH_CLIENT_ID!,
          clientSecret: config.MERCADOPAGO_OAUTH_CLIENT_SECRET!,
          credentialsKey: config.PAYMENT_CREDENTIALS_KEY!,
          redirectUri: `${config.PUBLIC_API_BASE_URL!}/api/payment-accounts/oauth/callback`,
          webhookSecret: config.MERCADOPAGO_WEBHOOK_SECRET!,
          environment: config.NODE_ENV === 'production' ? 'PRODUCTION' : 'SANDBOX',
          fallbackPayerEmail: config.MERCADOPAGO_FALLBACK_PAYER_EMAIL,
          log,
        })
      : null;
  await registerJobs(boss, { pool, log, paymentAccounts, billing });

  const relay = startRelayLoop(pool, buildPublisher(boss), {
    batchSize: config.OUTBOX_BATCH_SIZE,
    maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
    retryBaseSeconds: config.OUTBOX_RETRY_BASE_SECONDS,
    pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
  });

  let stopping: Promise<void> | null = null;

  /**
   * ORDEM DO DESLIGAMENTO, e o motivo de cada passo:
   *
   *   1. RELAY primeiro. Para de reclamar linhas novas da outbox e ESPERA a
   *      rodada corrente terminar. Fechar o pool antes disso derrubaria uma
   *      transacao aberta, deixando um evento entregue a fila sem
   *      `published_at` — que viraria trabalho repetido na proxima subida.
   *
   *   2. FILA em seguida, com `graceful: true`. O pg-boss para de entregar
   *      trabalho novo e espera os consumidores em execucao terminarem. Um job
   *      interrompido no meio voltaria para a fila e seria reentregue; o
   *      consumidor e idempotente, mas produzir reentrega de proposito num
   *      desligamento planejado e desperdicio.
   *
   *   3. POOL por ultimo. So depois que ninguem mais tem transacao aberta.
   *      Fechar antes deixaria conexoes abandonadas do lado do PostgreSQL.
   */
  async function stop(reason = 'desconhecido'): Promise<void> {
    if (stopping) return stopping;

    stopping = (async () => {
      console.log(`[worker] encerrando (${reason})...`);

      await relay.stop();
      console.log('[worker] relay parado; nenhuma rodada em andamento');

      await boss.stop({ graceful: true }).catch((error: unknown) => {
        console.error('[worker] falha ao parar a fila:', error);
      });
      console.log('[worker] fila parada');

      await pool.end().catch((error: unknown) => {
        console.error('[worker] falha ao fechar o pool:', error);
      });
      console.log('[worker] pool fechado; encerramento concluido');
    })();

    return stopping;
  }

  return { boss, pool, relay, stop };
}

async function main(): Promise<void> {
  // Mesmo comportamento da API: arquivo local opcional; ambiente do Render vence.
  await loadRootEnv();
  const config = loadWorkerConfig();
  const runtime = await startWorker(config);

  console.log(
    `[worker] no ar (${config.NODE_ENV}); fila "${FOUNDATION_QUEUE}"; ` +
      `varredura a cada ${config.OUTBOX_POLL_INTERVAL_MS}ms`,
  );

  /**
   * SIGTERM e o sinal que o Render envia em todo deploy e reinicio; SIGINT e o
   * Ctrl+C do desenvolvimento. Os dois levam ao mesmo encerramento.
   *
   * O temporizador de seguranca existe porque "gracioso" nao pode virar "nunca
   * termina": se um consumidor travar, o orquestrador mataria o processo de
   * qualquer forma, e sair com codigo proprio deixa registro do que aconteceu.
   * `unref()` impede que o proprio temporizador segure o processo de pe.
   */
  let encerrando = false;
  const shutdown = (signal: string): void => {
    if (encerrando) {
      console.log(`[worker] ${signal} recebido durante o encerramento; ignorado`);
      return;
    }
    encerrando = true;

    const prazo = setTimeout(() => {
      console.error('[worker] encerramento excedeu 20s; saindo a forca');
      process.exit(1);
    }, 20_000);
    prazo.unref();

    void runtime
      .stop(signal)
      .then(() => {
        clearTimeout(prazo);
        process.exit(0);
      })
      .catch((error: unknown) => {
        console.error('[worker] encerramento falhou:', error);
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/**
 * Executa somente quando este arquivo E o processo — nao quando e importado por
 * um teste. Sem esta guarda, importar `startWorker` subiria um worker inteiro
 * como efeito colateral do import, e `loadWorkerConfig()` derrubaria a suite por
 * falta de variavel de ambiente.
 *
 * `pathToFileURL` normaliza a comparacao: `process.argv[1]` e um caminho do
 * sistema operacional (com `\` no Windows) e `import.meta.url` e uma URL.
 */
const executadoDiretamente =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (executadoDiretamente) {
  main().catch((error: unknown) => {
    console.error('[worker] falhou ao subir:', error);
    process.exitCode = 1;
  });
}
