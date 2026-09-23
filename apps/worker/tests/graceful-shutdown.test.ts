import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrate, type DbPool } from '@campaigns/db';
import { startRelayLoop } from '../src/outbox/relayLoop.js';
import { startWorker } from '../src/worker.js';
import { installQueue } from '../src/queue.js';
import { loadWorkerConfig } from '../src/config.js';

/**
 * Encerramento gracioso do worker.
 *
 * POR QUE ISTO EXISTE. Em staging o worker roda no Linux e recebe `SIGTERM` a
 * cada deploy. O que precisa ser garantido nao e o SINAL — o Node entrega
 * sinal sozinho — e sim a ORDEM do desligamento e o fato de ele ESPERAR:
 *
 *   relay para e a rodada corrente TERMINA
 *   -> fila para, esperando os consumidores
 *   -> pool fecha
 *
 * Inverter isso derruba uma transacao aberta e produz um evento entregue a fila
 * sem `published_at` — trabalho repetido na proxima subida.
 *
 * Os testes exercitam o ciclo de vida diretamente, sem depender de o sistema
 * operacional entregar um sinal: a entrega do sinal e responsabilidade do Node,
 * e e verificada no ambiente Linux real.
 */

const OWNER_URL = process.env['TEST_MIGRATION_DATABASE_URL'] ?? '';
const WORKER_URL = process.env['TEST_WORKER_DATABASE_URL'] ?? '';
const hasDb = OWNER_URL !== '' && WORKER_URL !== '';

const skipReason =
  'PULADO: defina TEST_MIGRATION_DATABASE_URL e TEST_WORKER_DATABASE_URL para o teste de encerramento.';

/** Schema proprio, para nao disputar a fila com as outras suites. */
const QUEUE_SCHEMA = 'pgboss_shutdown_test';

/** Papel dono do schema da fila, o mesmo usado pelo instalador. */
const OWNER_ROLE = 'app_worker';

/**
 * Descarta o schema da fila assumindo o papel DONO.
 *
 * O instalador transfere a posse do schema para `app_worker`, entao quem
 * limpa precisa ser ele. Num PostgreSQL proprio isso passa despercebido — o
 * administrador e superusuario e descarta qualquer coisa. Num provedor
 * gerenciado ele NAO e, e a limpeza falha com `must be owner of schema`.
 */
async function dropQueueSchema(owner: DbPool, schema: string): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query(`SET ROLE ${OWNER_ROLE}`).catch(() => undefined);
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await client.query('RESET ROLE').catch(() => undefined);
    client.release();
  }
}

function unique(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Promessa que o teste resolve de fora, para controlar o instante do sinal. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe.skipIf(!hasDb)(`RN21 · encerramento gracioso ${hasDb ? '' : skipReason}`, () => {
  let owner: DbPool;
  let worker: DbPool;

  beforeAll(async () => {
    await migrate(OWNER_URL);
    owner = createPool({ connectionString: OWNER_URL, applicationName: 'test-shutdown-owner' });
    worker = createPool({ connectionString: WORKER_URL, applicationName: 'test-shutdown-worker' });

    await dropQueueSchema(owner, QUEUE_SCHEMA);
    await installQueue({
      adminConnectionString: OWNER_URL,
      schema: QUEUE_SCHEMA,
      ownerRole: 'app_worker',
    });
  }, 120_000);

  afterAll(async () => {
    await dropQueueSchema(owner, QUEUE_SCHEMA).catch(() => undefined);
    await owner?.end();
    await worker?.end();
  });

  /** Evento pendente na outbox, para que a rodada do relay tenha o que fazer. */
  async function seedEvent(): Promise<string> {
    const slug = unique('shut-');
    const { rows: autor } = await owner.query<{ id: string }>(
      'INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id',
      [`${slug}@example.com`, 'Autor'],
    );
    const { rows: tenant } = await owner.query<{ id: string }>(
      'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
      [slug, `Comunidade ${slug}`],
    );
    const { rows: evento } = await owner.query<{ id: string }>(
      `INSERT INTO outbox (tenant_id, event_type, payload)
       VALUES (NULL, 'tenant.created', $1::jsonb) RETURNING id`,
      [
        JSON.stringify({
          tenantId: tenant[0]!.id,
          slug,
          name: `Comunidade ${slug}`,
          createdByUserId: autor[0]!.id,
        }),
      ],
    );
    return evento[0]!.id;
  }

  describe('laco do relay', () => {
    it('stop() ESPERA a rodada corrente terminar', async () => {
      // O caso que importa: o sinal chega no meio de uma publicacao. Se `stop()`
      // devolvesse o controle antes do fim, quem chamou fecharia o pool sobre
      // uma transacao aberta.
      const eventId = await seedEvent();

      const publicacaoComecou = deferred();
      const podeTerminar = deferred();
      let publicacaoConcluida = false;

      const loop = startRelayLoop(
        worker,
        async () => {
          publicacaoComecou.resolve();
          await podeTerminar.promise;
          publicacaoConcluida = true;
        },
        {
          batchSize: 50,
          maxAttempts: 3,
          retryBaseSeconds: 1,
          pollIntervalMs: 50,
          log: () => undefined,
        },
      );

      await publicacaoComecou.promise;

      // Encerra com a publicacao presa no meio.
      const parando = loop.stop();
      let jaRetornou = false;
      void parando.then(() => {
        jaRetornou = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(jaRetornou, 'stop() nao pode retornar com a rodada em andamento').toBe(false);
      expect(publicacaoConcluida).toBe(false);

      podeTerminar.resolve();
      await parando;

      expect(publicacaoConcluida).toBe(true);

      // E a rodada COMPLETOU: o evento ficou marcado como publicado. Encerrar no
      // meio teria deixado o commit para tras.
      const { rows } = await owner.query<{ published_at: string | null }>(
        'SELECT published_at FROM outbox WHERE id = $1',
        [eventId],
      );
      expect(rows[0]?.published_at).not.toBeNull();
    }, 30_000);

    it('depois de stop() nenhuma rodada nova acontece', async () => {
      const loop = startRelayLoop(worker, async () => undefined, {
        batchSize: 10,
        maxAttempts: 3,
        retryBaseSeconds: 1,
        pollIntervalMs: 10,
        log: () => undefined,
      });

      await new Promise((resolve) => setTimeout(resolve, 80));
      await loop.stop();
      const rodadasNoFim = loop.rounds;

      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(loop.rounds).toBe(rodadasNoFim);
    }, 30_000);

    it('stop() chamado duas vezes e seguro', async () => {
      const loop = startRelayLoop(worker, async () => undefined, {
        batchSize: 10,
        maxAttempts: 3,
        retryBaseSeconds: 1,
        pollIntervalMs: 50,
        log: () => undefined,
      });
      await loop.stop();
      await expect(loop.stop()).resolves.toBeUndefined();
    }, 30_000);
  });

  describe('processo completo', () => {
    function configDeTeste() {
      return loadWorkerConfig({
        NODE_ENV: 'test',
        WORKER_DATABASE_URL: WORKER_URL,
        QUEUE_DATABASE_URL: WORKER_URL,
        QUEUE_SCHEMA,
        // Varredura longa: a suite nao quer o relay disputando eventos das
        // outras suites enquanto testa o ciclo de vida.
        OUTBOX_POLL_INTERVAL_MS: '600000',
      });
    }

    it('sobe e encerra liberando TODAS as conexoes', async () => {
      const runtime = await startWorker(configDeTeste());

      // O pool do `pg` e preguicoso: so abre conexao no primeiro uso. Uma
      // consulta garante que ha o que fechar — sem ela o teste passaria por
      // nunca ter havido conexao, e nao por ela ter sido encerrada.
      await runtime.pool.query('SELECT 1');

      const durante = await owner.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity
          WHERE application_name = 'campaigns-worker'`,
      );
      expect(Number(durante.rows[0]!.n)).toBeGreaterThan(0);

      await runtime.stop('teste');

      /**
       * Conexao abandonada e o defeito classico de um desligamento apressado:
       * o processo some e o PostgreSQL segue com sessoes penduradas.
       *
       * A verificacao espera ate 15s em vez de olhar uma vez so. O que importa
       * e que as conexoes SEJAM liberadas — nao que o backend do servidor
       * desapareca no mesmo instante em que `stop()` retorna. Contra um banco
       * remoto ha um intervalo entre o cliente desconectar e o servidor
       * reciclar o processo, e exigir zero imediato mediria a latencia da rede,
       * nao o encerramento.
       *
       * Uma conexao de fato vazada nunca cai, entao a janela nao esconde o
       * defeito que o teste persegue: ela so deixa de reprova-lo por atraso.
       */
      let abertas = -1;
      for (let tentativa = 0; tentativa < 15; tentativa += 1) {
        const depois = await owner.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_stat_activity
            WHERE application_name = 'campaigns-worker'`,
        );
        abertas = Number(depois.rows[0]!.n);
        if (abertas === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      expect(abertas, 'o worker deixou conexoes penduradas').toBe(0);
    }, 120_000);

    it('encerrar duas vezes e seguro e nao lanca', async () => {
      // O orquestrador pode mandar SIGTERM e, em seguida, SIGINT.
      const runtime = await startWorker(configDeTeste());
      await runtime.stop('primeiro');
      await expect(runtime.stop('segundo')).resolves.toBeUndefined();
    }, 60_000);

    it('o pool esta REALMENTE fechado depois do encerramento', async () => {
      const runtime = await startWorker(configDeTeste());
      await runtime.stop('teste');

      // Um pool fechado recusa consulta nova. Se ainda aceitasse, o
      // encerramento teria deixado recurso vivo.
      await expect(runtime.pool.query('SELECT 1')).rejects.toThrow();
    }, 60_000);
  });
});
