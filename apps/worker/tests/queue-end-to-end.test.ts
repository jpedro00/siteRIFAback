import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import PgBoss from 'pg-boss';
import { createPool, migrate, type DbPool } from '@campaigns/db';
import { runRelayOnce } from '../src/outbox/relay.js';
import { handleMessage } from '../src/dispatch.js';
import {
  buildPublisher,
  FOUNDATION_QUEUE,
  installQueue,
  startQueue,
  type QueueMessage,
} from '../src/queue.js';
import { CONSUMER_NAME } from '../src/consumers/provisionTenantBranding.js';

/**
 * RN21 · o caminho INTEIRO, com pg-boss de verdade.
 *
 * As outras suites do worker substituem o publisher por uma funcao controlada,
 * porque precisam simular FALHA de publicacao — e uma fila real nao falha sob
 * demanda. Isso deixava um vao: nada provava que o relay e a fila conversam.
 * `boss.send` podia recusar, o schema podia nao existir, o papel podia nao ter
 * privilegio, o formato da mensagem podia nao sobreviver a ida e volta pelo
 * jsonb — e todos esses casos passariam despercebidos.
 *
 * Aqui nada e mockado:
 *
 *   transacao -> outbox -> relay -> pg-boss -> consumidor -> efeito
 *
 * A fila roda com o MESMO papel restrito do worker (`app_worker`), dentro do
 * schema `pgboss` que a migration lhe deu. Se o modelo de privilegios estiver
 * errado, este teste falha na subida — que e exatamente o que se quer dele.
 */

const OWNER_URL = process.env['TEST_MIGRATION_DATABASE_URL'] ?? '';
const WORKER_URL = process.env['TEST_WORKER_DATABASE_URL'] ?? '';
const hasDb = OWNER_URL !== '' && WORKER_URL !== '';

const skipReason =
  'PULADO: defina TEST_MIGRATION_DATABASE_URL e TEST_WORKER_DATABASE_URL para o teste da fila.';

/** Schema proprio para esta suite, para nao brigar com o do desenvolvimento. */
const QUEUE_SCHEMA = 'pgboss_test';

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

describe.skipIf(!hasDb)(`RN21 · outbox -> pg-boss -> consumidor ${hasDb ? '' : skipReason}`, () => {
  let owner: DbPool;
  let worker: DbPool;
  let boss: PgBoss;

  const relayOptions = { batchSize: 50, maxAttempts: 3, retryBaseSeconds: 1 };

  beforeAll(async () => {
    await migrate(OWNER_URL);
    owner = createPool({ connectionString: OWNER_URL, applicationName: 'test-queue-owner' });
    worker = createPool({ connectionString: WORKER_URL, applicationName: 'test-queue-worker' });

    await dropQueueSchema(owner, QUEUE_SCHEMA);

    // ETAPA ADMINISTRATIVA, uma vez — o mesmo caminho de producao
    // (`npm run queue:install`). Cria os objetos e passa a POSSE ao app_worker.
    await installQueue({
      adminConnectionString: OWNER_URL,
      schema: QUEUE_SCHEMA,
      ownerRole: 'app_worker',
    });

    // RUNTIME — papel restrito, sem privilegio de criacao no banco.
    boss = await startQueue({
      QUEUE_DATABASE_URL: WORKER_URL,
      QUEUE_SCHEMA,
      DATABASE_SSL: false,
    });
  }, 120_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false }).catch(() => undefined);
    await dropQueueSchema(owner, QUEUE_SCHEMA).catch(() => undefined);
    await owner?.end();
    await worker?.end();
  });

  /**
   * Grava comunidade e evento na MESMA transacao, como a API faz.
   * A marca padrao NAO e criada aqui: quem a provisiona e o consumidor.
   */
  async function seedTenantAndEvent(): Promise<{
    tenantId: string;
    eventId: string;
    name: string;
    createdByUserId: string;
  }> {
    const slug = unique('fila-');
    const name = `Comunidade ${slug}`;
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      const autor = await client.query<{ id: string }>(
        'INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id',
        [`${slug}@example.com`, 'Super Admin de Teste'],
      );
      const createdByUserId = autor.rows[0]!.id;

      const tenant = await client.query<{ id: string }>(
        'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
        [slug, name],
      );
      const tenantId = tenant.rows[0]!.id;

      // Mesmo payload que a API grava em `platformCreateTenant`.
      const event = await client.query<{ id: string }>(
        `INSERT INTO outbox (tenant_id, event_type, payload)
         VALUES (NULL, 'tenant.created', $1::jsonb)
         RETURNING id`,
        [JSON.stringify({ tenantId, slug, name, createdByUserId })],
      );
      await client.query('COMMIT');
      return { tenantId, eventId: event.rows[0]!.id, name, createdByUserId };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Tira as mensagens da fila e as entrega ao consumidor, como o worker faz.
   *
   * `apenas` limita o despacho aos eventos desta suite. A tabela `outbox` e
   * compartilhada com as outras suites do worker, e o relay — corretamente —
   * reclama tudo o que estiver pendente; sem o filtro, esta suite processaria
   * eventos alheios e passaria a depender da ordem dos arquivos de teste.
   * Os demais jobs sao concluidos sem despacho: nao pertencem a este cenario.
   */
  async function drain(apenas?: ReadonlySet<string>): Promise<number> {
    const jobs = await boss.fetch<QueueMessage>(FOUNDATION_QUEUE, { batchSize: 50 });
    let despachados = 0;
    for (const job of jobs) {
      if (!apenas || apenas.has(job.data.outboxEventId)) {
        await handleMessage(worker, job.data);
        despachados += 1;
      }
      await boss.complete(FOUNDATION_QUEUE, job.id);
    }
    return despachados;
  }

  it('a fila sobe com o papel RESTRITO do worker, sem superusuario', async () => {
    const { rows } = await worker.query<{
      current_user: string;
      superuser: boolean;
      bypassrls: boolean;
    }>(
      `SELECT current_user,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls`,
    );
    expect(rows[0]?.current_user).toBe('app_worker');
    expect(rows[0]?.superuser).toBe(false);
    expect(rows[0]?.bypassrls).toBe(false);

    // A fila realmente criou as proprias tabelas nesse schema...
    const tabelas = await owner.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM pg_tables WHERE schemaname = $1',
      [QUEUE_SCHEMA],
    );
    expect(Number(tabelas.rows[0]!.count)).toBeGreaterThan(0);

    // ...e a POSSE ficou com o worker, nao com o papel administrativo. E isso
    // que o dispensa de GRANTs avulsos e o deixa aplicar as migrations de
    // versao do pg-boss sem privilegio de criacao no banco.
    const donos = await owner.query<{ tableowner: string }>(
      'SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = $1',
      [QUEUE_SCHEMA],
    );
    expect(donos.rows.map((row) => row.tableowner)).toEqual(['app_worker']);
  });

  it('o worker NAO pode criar schema no banco', async () => {
    // O privilegio que a instalacao exige e exatamente o que o runtime nao tem.
    await expect(worker.query('CREATE SCHEMA tentativa_indevida')).rejects.toThrow(
      /permission denied|permissão negada/i,
    );
  });

  it('a fila nao instalada recusa subir com uma mensagem util', async () => {
    // Em vez de um "permission denied for database" cru, que esconde o que
    // falta fazer.
    await expect(
      startQueue({
        QUEUE_DATABASE_URL: WORKER_URL,
        QUEUE_SCHEMA: 'pgboss_inexistente',
        DATABASE_SSL: false,
      }),
    ).rejects.toThrow(/queue:install/);
  });

  it('o evento atravessa outbox, fila e consumidor ate o efeito', async () => {
    const { tenantId, eventId, name } = await seedTenantAndEvent();

    // 1. RELAY: outbox -> fila, com o publisher REAL do worker.
    const relay = await runRelayOnce(worker, buildPublisher(boss), relayOptions);
    expect(relay.published).toBeGreaterThanOrEqual(1);
    expect(relay.failed).toBe(0);

    // `published_at` significa "entreguei a fila", e so isso.
    const publicado = await owner.query<{ published_at: string | null }>(
      'SELECT published_at FROM outbox WHERE id = $1',
      [eventId],
    );
    expect(publicado.rows[0]?.published_at).not.toBeNull();

    // Entregue a fila NAO significa consumido: sao tabelas diferentes.
    const aindaNaoConsumido = await owner.query(
      'SELECT 1 FROM event_consumptions WHERE event_id = $1',
      [eventId],
    );
    expect(aindaNaoConsumido.rows).toHaveLength(0);

    // 2. CONSUMIDOR: fila -> efeito.
    expect(await drain(new Set([eventId]))).toBe(1);

    const branding = await owner.query<{ public_name: string; colors: Record<string, string> }>(
      'SELECT public_name, colors FROM tenant_branding WHERE tenant_id = $1',
      [tenantId],
    );
    expect(branding.rows).toHaveLength(1);
    expect(branding.rows[0]?.public_name).toBe(name);
    expect(branding.rows[0]?.colors['primary']).toBeDefined();

    // 3. CONCLUSAO registrada, com o nome do consumidor.
    const consumo = await owner.query<{ consumer: string }>(
      'SELECT consumer FROM event_consumptions WHERE event_id = $1',
      [eventId],
    );
    expect(consumo.rows.map((row) => row.consumer)).toContain(CONSUMER_NAME);
  });

  it('a mensagem sobrevive intacta a ida e volta pela fila', async () => {
    // O payload vira jsonb, volta como objeto e e validado pelo schema do
    // consumidor. Um campo perdido aqui so apareceria em producao.
    const { tenantId, eventId, name, createdByUserId } = await seedTenantAndEvent();
    await runRelayOnce(worker, buildPublisher(boss), relayOptions);

    const jobs = await boss.fetch<QueueMessage>(FOUNDATION_QUEUE, { batchSize: 50 });
    const mensagem = jobs.find((job) => job.data.payload['tenantId'] === tenantId);
    expect(mensagem, 'a mensagem daquele evento deveria estar na fila').toBeDefined();
    expect(mensagem!.data.eventType).toBe('tenant.created');
    expect(mensagem!.data.tenantId).toBeNull();
    expect(mensagem!.data.outboxEventId).toBe(eventId);
    // O payload inteiro, campo a campo: um perdido aqui so apareceria em
    // producao, como um consumidor recusando o proprio evento.
    expect(mensagem!.data.payload).toEqual({
      tenantId,
      slug: expect.any(String),
      name,
      createdByUserId,
    });

    for (const job of jobs) {
      if (job.data.payload['tenantId'] === tenantId) {
        await handleMessage(worker, job.data);
      }
      await boss.complete(FOUNDATION_QUEUE, job.id);
    }
  });

  it('entrega repetida pela fila NAO duplica o efeito', async () => {
    // A garantia e AO MENOS UMA VEZ. O que impede efeito duplicado e a
    // idempotencia do consumidor, nao a fila.
    const { tenantId, eventId, createdByUserId } = await seedTenantAndEvent();
    await runRelayOnce(worker, buildPublisher(boss), relayOptions);
    expect(await drain(new Set([eventId]))).toBe(1);

    const personalizado = 'Marca ja personalizada pela comunidade';
    await owner.query('UPDATE tenant_branding SET public_name = $2 WHERE tenant_id = $1', [
      tenantId,
      personalizado,
    ]);

    // Reentrega da MESMA mensagem, como aconteceria numa repeticao da fila.
    await handleMessage(worker, {
      outboxEventId: eventId,
      tenantId: null,
      eventType: 'tenant.created',
      payload: { tenantId, slug: unique('re-'), name: 'Nome Diferente', createdByUserId },
    });

    const branding = await owner.query<{ public_name: string }>(
      'SELECT public_name FROM tenant_branding WHERE tenant_id = $1',
      [tenantId],
    );
    expect(branding.rows[0]?.public_name).toBe(personalizado);

    const consumo = await owner.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM event_consumptions WHERE event_id = $1',
      [eventId],
    );
    expect(consumo.rows[0]?.count).toBe('1');
  });

  it('o relay so marca published_at DEPOIS de a fila aceitar', async () => {
    // Marcar antes produziria eventos perdidos em silencio: publicados no
    // banco e nunca entregues.
    const { eventId } = await seedTenantAndEvent();

    await expect(
      runRelayOnce(
        worker,
        async (event) => {
          const { rows } = await owner.query<{ published_at: string | null }>(
            'SELECT published_at FROM outbox WHERE id = $1',
            [event.id],
          );
          expect(rows[0]?.published_at).toBeNull();
          throw new Error('a fila recusou');
        },
        relayOptions,
      ),
    ).resolves.toMatchObject({ published: 0, failed: 1 });

    const depois = await owner.query<{ published_at: string | null; attempts: number }>(
      'SELECT published_at, attempts FROM outbox WHERE id = $1',
      [eventId],
    );
    expect(depois.rows[0]?.published_at).toBeNull();
    expect(depois.rows[0]?.attempts).toBe(1);

    // E a recuperacao funciona: com a fila de volta, o evento chega ao efeito.
    await owner.query('UPDATE outbox SET available_at = now() WHERE id = $1', [eventId]);
    const retomada = await runRelayOnce(worker, buildPublisher(boss), relayOptions);
    expect(retomada.published).toBeGreaterThanOrEqual(1);
    expect(await drain(new Set([eventId]))).toBe(1);
  });
});
