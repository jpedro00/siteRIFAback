import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import PgBoss from 'pg-boss';
import { createPool, type DbPool } from '@clubedarifa/db';
import { installQueue, startQueue } from '../src/queue.js';
import { JOBS } from '../src/jobs/definitions.js';
import { FUSO_DOS_JOBS, registerJobs } from '../src/jobs/schedule.js';
import { OWNER_URL, WORKER_URL, hasDb, silentLog, skipReason, unique } from './helpers/seed.js';

/**
 * Agendamento REAL no pg-boss, com o papel restrito do worker.
 *
 * O que se prova: os jobs ficam agendados com o cron certo e o fuso certo,
 * registrar de novo nao duplica, e um disparo de fato EXECUTA o job e deixa o
 * heartbeat. Se o modelo de privilegios do schema `pgboss` estivesse errado,
 * este teste falharia na subida.
 */
const QUEUE_SCHEMA = 'pgboss_sched_test';
const OWNER_ROLE = 'app_worker';

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

describe.skipIf(!hasDb)(`Agendamento dos jobs no pg-boss ${hasDb ? '' : skipReason}`, () => {
  let owner: DbPool;
  let worker: DbPool;
  let boss: PgBoss;

  beforeAll(async () => {
    owner = createPool({ connectionString: OWNER_URL, applicationName: 'test-sched-owner' });
    worker = createPool({ connectionString: WORKER_URL, applicationName: 'test-sched-worker' });
    await dropQueueSchema(owner, QUEUE_SCHEMA);
    await installQueue({ adminConnectionString: OWNER_URL, schema: QUEUE_SCHEMA, ownerRole: OWNER_ROLE });
    boss = await startQueue({ QUEUE_DATABASE_URL: WORKER_URL, QUEUE_SCHEMA, DATABASE_SSL: false });
  }, 120_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false }).catch(() => undefined);
    await dropQueueSchema(owner, QUEUE_SCHEMA).catch(() => undefined);
    await owner?.end();
    await worker?.end();
  });

  it('agenda TODOS os jobs com o cron e o fuso certos', async () => {
    await registerJobs(boss, { pool: worker, log: silentLog, paymentAccounts: null });

    const agendas = await boss.getSchedules();
    const porNome = new Map(agendas.map((a) => [a.name, a]));
    for (const job of JOBS) {
      const agenda = porNome.get(job.name);
      expect(agenda, `${job.name} agendado`).toBeDefined();
      expect(agenda!.cron).toBe(job.cron);
      // O tipo publicado do pg-boss nao declara `timezone`, mas a linha o traz.
      expect((agenda as unknown as { timezone: string }).timezone).toBe(FUSO_DOS_JOBS);
    }
  });

  it('registrar de novo (reinicio do worker) nao duplica o agendamento', async () => {
    await registerJobs(boss, { pool: worker, log: silentLog, paymentAccounts: null });
    await registerJobs(boss, { pool: worker, log: silentLog, paymentAccounts: null });
    const agendas = await boss.getSchedules();
    for (const job of JOBS) {
      expect(agendas.filter((a) => a.name === job.name)).toHaveLength(1);
    }
  });

  it('um disparo EXECUTA o job e grava o heartbeat', async () => {
    const job = JOBS.find((j) => j.name === 'expirar-reservas')!;
    await registerJobs(boss, { pool: worker, log: silentLog, paymentAccounts: null }, [job]);

    // Marca ANTES do disparo para provar que o heartbeat e deste ciclo.
    const antes = new Date().toISOString();
    await boss.send(job.name, {}, { singletonKey: unique('disparo-') });

    const inicio = Date.now();
    let heartbeat: { last_finished_at: string; last_error: string | null } | undefined;
    while (Date.now() - inicio < 30_000) {
      const { rows } = await owner.query<{ last_finished_at: string; last_error: string | null }>(
        'SELECT last_finished_at, last_error FROM job_heartbeats WHERE job_name = $1 AND last_finished_at >= $2',
        [job.name, antes],
      );
      heartbeat = rows[0];
      if (heartbeat) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    expect(heartbeat, 'o job rodou e gravou o heartbeat').toBeDefined();
    expect(heartbeat!.last_error).toBeNull();
  }, 60_000);
});
