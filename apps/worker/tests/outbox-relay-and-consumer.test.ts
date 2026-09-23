import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrate, type DbPool } from '@campaigns/db';
import { runRelayOnce, type Publisher } from '../src/outbox/relay.js';
import { handleMessage } from '../src/dispatch.js';
import {
  CONSUMER_NAME,
  provisionTenantBranding,
} from '../src/consumers/provisionTenantBranding.js';
import type { QueueMessage } from '../src/queue.js';

/**
 * Relay da outbox e idempotencia do consumidor.
 * Secao 8 do pedido, itens 10 e 11.
 *
 * A FILA NAO E MOCKADA POR CONVENIENCIA: o publisher e substituido por uma
 * funcao controlada para poder simular FALHA de publicacao, que e justamente o
 * que precisa ser exercitado. Todo o resto — outbox, consumidor, efeito e
 * marcacao de conclusao — roda contra PostgreSQL real, com o papel app_worker.
 */

const OWNER_URL = process.env['TEST_MIGRATION_DATABASE_URL'] ?? '';
const WORKER_URL = process.env['TEST_WORKER_DATABASE_URL'] ?? '';
const hasDb = OWNER_URL !== '' && WORKER_URL !== '';

const skipReason =
  'PULADO: defina TEST_MIGRATION_DATABASE_URL e TEST_WORKER_DATABASE_URL para os testes do worker.';

function unique(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

describe.skipIf(!hasDb)(`RN21 · relay e consumidor ${hasDb ? '' : skipReason}`, () => {
  let owner: DbPool;
  let worker: DbPool;

  const relayOptions = { batchSize: 50, maxAttempts: 3, retryBaseSeconds: 1 };

  beforeAll(async () => {
    await migrate(OWNER_URL);
    owner = createPool({ connectionString: OWNER_URL, applicationName: 'test-worker-owner' });
    worker = createPool({ connectionString: WORKER_URL, applicationName: 'test-worker' });
  });

  afterAll(async () => {
    await worker?.end();
    await owner?.end();
  });

  async function seedTenantAndEvent(): Promise<{ tenantId: string; eventId: string; name: string }> {
    const slug = unique('wk-');
    const name = `Comunidade ${slug}`;
    const { rows } = await owner.query<{ id: string }>(
      'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
      [slug, name],
    );
    const tenantId = rows[0]!.id;

    const event = await owner.query<{ id: string }>(
      `INSERT INTO outbox (tenant_id, event_type, payload)
       VALUES (NULL, 'tenant.created', $1::jsonb)
       RETURNING id`,
      [
        JSON.stringify({
          tenantId,
          slug,
          name,
          createdByUserId: '00000000-0000-0000-0000-000000000001',
        }),
      ],
    );
    return { tenantId, eventId: event.rows[0]!.id, name };
  }

  // -------------------------------------------------------------------------
  // Relay
  // -------------------------------------------------------------------------
  describe('relay · leva a outbox ate a fila', () => {
    it('o papel do worker nao tem BYPASSRLS', async () => {
      const { rows } = await worker.query<{ rolname: string; rolbypassrls: boolean }>(
        'SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      expect(rows[0]?.rolname).toBe('app_worker');
      expect(rows[0]?.rolbypassrls).toBe(false);
    });

    it('publica o evento e so entao marca published_at', async () => {
      const { eventId } = await seedTenantAndEvent();
      const publicados: string[] = [];

      const publish: Publisher = async (event) => {
        // No momento da publicacao, o evento AINDA nao pode estar marcado.
        const { rows } = await owner.query<{ published_at: string | null }>(
          'SELECT published_at FROM outbox WHERE id = $1',
          [event.id],
        );
        expect(rows[0]?.published_at).toBeNull();
        publicados.push(event.id);
      };

      const result = await runRelayOnce(worker, publish, relayOptions);
      expect(result.published).toBeGreaterThanOrEqual(1);
      expect(publicados).toContain(eventId);

      const { rows } = await owner.query<{ published_at: string | null }>(
        'SELECT published_at FROM outbox WHERE id = $1',
        [eventId],
      );
      expect(rows[0]?.published_at).not.toBeNull();
    });

    it('evento ja publicado nao e publicado de novo', async () => {
      const { eventId } = await seedTenantAndEvent();
      const publish: Publisher = async () => undefined;

      await runRelayOnce(worker, publish, relayOptions);

      const segundaRodada: string[] = [];
      await runRelayOnce(
        worker,
        async (event) => {
          segundaRodada.push(event.id);
        },
        relayOptions,
      );
      expect(segundaRodada).not.toContain(eventId);
    });

    it('item 10 · falha na publicacao NAO marca como publicado e agenda nova tentativa', async () => {
      const { eventId } = await seedTenantAndEvent();

      const result = await runRelayOnce(
        worker,
        async () => {
          throw new Error('fila indisponivel');
        },
        relayOptions,
      );
      expect(result.published).toBe(0);
      expect(result.failed).toBeGreaterThanOrEqual(1);

      const { rows } = await owner.query<{
        published_at: string | null;
        attempts: number;
        last_error: string | null;
      }>('SELECT published_at, attempts, last_error FROM outbox WHERE id = $1', [eventId]);

      expect(rows[0]?.published_at).toBeNull();
      expect(rows[0]?.attempts).toBeGreaterThanOrEqual(1);
      expect(rows[0]?.last_error).toContain('fila indisponivel');
    });

    it('a recuperacao funciona: o que falhou e publicado quando a fila volta', async () => {
      const { eventId } = await seedTenantAndEvent();

      await runRelayOnce(
        worker,
        async () => {
          throw new Error('fila fora do ar');
        },
        relayOptions,
      );

      // O recuo exponencial adia a proxima tentativa; antecipamos o relogio da
      // linha em vez de esperar de verdade.
      await owner.query('UPDATE outbox SET available_at = now() WHERE id = $1', [eventId]);

      const publicados: string[] = [];
      await runRelayOnce(
        worker,
        async (event) => {
          publicados.push(event.id);
        },
        relayOptions,
      );

      expect(publicados).toContain(eventId);
      const { rows } = await owner.query<{ published_at: string | null }>(
        'SELECT published_at FROM outbox WHERE id = $1',
        [eventId],
      );
      expect(rows[0]?.published_at).not.toBeNull();
    });

    /** Esgota as tentativas de um evento, forcando-o a ficar disponivel. */
    async function exhaust(eventId: string): Promise<void> {
      for (let i = 0; i < relayOptions.maxAttempts; i += 1) {
        await owner.query('UPDATE outbox SET available_at = now() WHERE id = $1', [eventId]);
        await runRelayOnce(
          worker,
          async () => {
            throw new Error('falha permanente');
          },
          relayOptions,
        );
      }
    }

    it('evento que esgota as tentativas fica parado e visivel, nao e descartado', async () => {
      const { eventId } = await seedTenantAndEvent();
      await exhaust(eventId);

      const { rows } = await owner.query<{
        published_at: string | null;
        attempts: number;
        dead_lettered_at: string | null;
        last_error: string | null;
      }>(
        'SELECT published_at, attempts, dead_lettered_at, last_error FROM outbox WHERE id = $1',
        [eventId],
      );
      // Continua existindo, nao publicado: a prova de que havia trabalho a
      // fazer nao pode desaparecer.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.published_at).toBeNull();
      expect(rows[0]?.attempts).toBeGreaterThanOrEqual(relayOptions.maxAttempts);
      // E marcado como esgotado, nao apenas adiado.
      expect(rows[0]?.dead_lettered_at).not.toBeNull();
      expect(rows[0]?.last_error).toContain('falha permanente');
    });

    it('evento esgotado NAO e reclamado de novo', async () => {
      // O defeito anterior: `available_at = now() + 1 hora` com
      // `published_at IS NULL` fazia o relay repescar a mesma linha para
      // sempre, uma vez por hora. Adiar nao e desistir.
      const { eventId } = await seedTenantAndEvent();
      await exhaust(eventId);

      const antes = await owner.query<{ attempts: number }>(
        'SELECT attempts FROM outbox WHERE id = $1',
        [eventId],
      );

      // Mesmo com a linha disponivel e o publisher agora funcionando, o relay
      // nao a toca: sair do esgotamento exige acao deliberada.
      await owner.query('UPDATE outbox SET available_at = now() WHERE id = $1', [eventId]);
      let publicados = 0;
      const result = await runRelayOnce(
        worker,
        async () => {
          publicados += 1;
        },
        relayOptions,
      );

      expect(publicados).toBe(0);
      expect(result.published).toBe(0);

      const depois = await owner.query<{ attempts: number; published_at: string | null }>(
        'SELECT attempts, published_at FROM outbox WHERE id = $1',
        [eventId],
      );
      expect(depois.rows[0]?.attempts).toBe(antes.rows[0]?.attempts);
      expect(depois.rows[0]?.published_at).toBeNull();
    });

    it('evento ABAIXO do limite continua elegivel para nova tentativa', async () => {
      const { eventId } = await seedTenantAndEvent();

      // Uma falha so: longe do limite.
      await runRelayOnce(
        worker,
        async () => {
          throw new Error('falha passageira');
        },
        relayOptions,
      );

      const parcial = await owner.query<{ attempts: number; dead_lettered_at: string | null }>(
        'SELECT attempts, dead_lettered_at FROM outbox WHERE id = $1',
        [eventId],
      );
      expect(parcial.rows[0]?.attempts).toBe(1);
      expect(parcial.rows[0]?.dead_lettered_at).toBeNull();

      await owner.query('UPDATE outbox SET available_at = now() WHERE id = $1', [eventId]);
      const result = await runRelayOnce(worker, async () => undefined, relayOptions);
      expect(result.published).toBe(1);
    });

    it('um evento esgotado nao pode ser marcado como publicado', async () => {
      // A CHECK do banco impede o estado contraditorio, independentemente do
      // que o codigo do relay venha a fazer no futuro.
      const { eventId } = await seedTenantAndEvent();
      await exhaust(eventId);

      await expect(
        owner.query('UPDATE outbox SET published_at = now() WHERE id = $1', [eventId]),
      ).rejects.toThrow();
    });

    it('publicar nao marca o evento como CONSUMIDO', async () => {
      const { eventId } = await seedTenantAndEvent();
      await runRelayOnce(worker, async () => undefined, relayOptions);

      // published_at e consumo sao coisas diferentes, em tabelas diferentes.
      const { rows } = await owner.query(
        'SELECT 1 FROM event_consumptions WHERE event_id = $1',
        [eventId],
      );
      expect(rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Item 11 · idempotencia do consumidor
  // -------------------------------------------------------------------------
  describe('item 11 · reprocessar nao duplica o efeito', () => {
    it('o consumidor provisiona a marca padrao uma vez', async () => {
      const { tenantId, eventId, name } = await seedTenantAndEvent();

      const first = await provisionTenantBranding(worker, {
        eventId,
        payload: {
          tenantId,
          slug: 'irrelevante',
          name,
          createdByUserId: '00000000-0000-0000-0000-000000000001',
        },
      });
      expect(first.applied).toBe(true);

      const { rows } = await owner.query<{ public_name: string; colors: Record<string, string> }>(
        'SELECT public_name, colors FROM tenant_branding WHERE tenant_id = $1',
        [tenantId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.public_name).toBe(name);
      expect(rows[0]?.colors['primary']).toBeTruthy();
    });

    it('item 11 · reprocessar o MESMO evento nao repete o efeito', async () => {
      const { tenantId, eventId, name } = await seedTenantAndEvent();
      const payload = {
        tenantId,
        slug: 'irrelevante',
        name,
        createdByUserId: '00000000-0000-0000-0000-000000000001',
      };

      const first = await provisionTenantBranding(worker, { eventId, payload });
      expect(first.applied).toBe(true);

      for (let i = 0; i < 3; i += 1) {
        const repeat = await provisionTenantBranding(worker, { eventId, payload });
        expect(repeat.applied).toBe(false);
        expect(repeat.reason).toBe('already_consumed');
      }

      // Uma marca, uma marca de consumo, um registro na trilha.
      const branding = await owner.query(
        'SELECT 1 FROM tenant_branding WHERE tenant_id = $1',
        [tenantId],
      );
      expect(branding.rows).toHaveLength(1);

      const consumptions = await owner.query(
        'SELECT 1 FROM event_consumptions WHERE event_id = $1 AND consumer = $2',
        [eventId, CONSUMER_NAME],
      );
      expect(consumptions.rows).toHaveLength(1);

      const audit = await owner.query(
        "SELECT 1 FROM audit_events WHERE tenant_id = $1 AND action = 'tenant.branding_provisioned'",
        [tenantId],
      );
      expect(audit.rows).toHaveLength(1);
    });

    it('o reprocessamento NAO sobrescreve a marca ja personalizada', async () => {
      const { tenantId, eventId, name } = await seedTenantAndEvent();
      const payload = {
        tenantId,
        slug: 'irrelevante',
        name,
        createdByUserId: '00000000-0000-0000-0000-000000000001',
      };

      await provisionTenantBranding(worker, { eventId, payload });

      await owner.query(
        `UPDATE tenant_branding
            SET public_name = 'Nome escolhido pela comunidade',
                colors = '{"primary":"#FF0000"}'::jsonb
          WHERE tenant_id = $1`,
        [tenantId],
      );

      await provisionTenantBranding(worker, { eventId, payload });

      const { rows } = await owner.query<{ public_name: string; colors: Record<string, string> }>(
        'SELECT public_name, colors FROM tenant_branding WHERE tenant_id = $1',
        [tenantId],
      );
      expect(rows[0]?.public_name).toBe('Nome escolhido pela comunidade');
      expect(rows[0]?.colors['primary']).toBe('#FF0000');
    });

    it('a marca de conclusao e o efeito vivem na MESMA transacao', async () => {
      // Comunidade inexistente: o consumidor conclui sem efeito, e nao deixa
      // marca de conclusao sem ter decidido nada.
      const event = await owner.query<{ id: string }>(
        `INSERT INTO outbox (tenant_id, event_type, payload)
         VALUES (NULL, 'tenant.created', $1::jsonb) RETURNING id`,
        [
          JSON.stringify({
            tenantId: '00000000-0000-0000-0000-0000000000ff',
            slug: 'fantasma',
            name: 'Fantasma',
            createdByUserId: '00000000-0000-0000-0000-000000000001',
          }),
        ],
      );

      const result = await provisionTenantBranding(worker, {
        eventId: event.rows[0]!.id,
        payload: {
          tenantId: '00000000-0000-0000-0000-0000000000ff',
          slug: 'fantasma',
          name: 'Fantasma',
          createdByUserId: '00000000-0000-0000-0000-000000000001',
        },
      });

      expect(result.applied).toBe(false);
      expect(result.reason).toBe('tenant_missing');

      const branding = await owner.query('SELECT 1 FROM tenant_branding WHERE tenant_id = $1', [
        '00000000-0000-0000-0000-0000000000ff',
      ]);
      expect(branding.rows).toHaveLength(0);
    });

    it('payload invalido e recusado antes de qualquer efeito', async () => {
      const event = await owner.query<{ id: string }>(
        `INSERT INTO outbox (tenant_id, event_type, payload)
         VALUES (NULL, 'tenant.created', '{"faltando":"tudo"}'::jsonb) RETURNING id`,
      );

      await expect(
        provisionTenantBranding(worker, {
          eventId: event.rows[0]!.id,
          payload: { faltando: 'tudo' },
        }),
      ).rejects.toThrow();

      const consumptions = await owner.query(
        'SELECT 1 FROM event_consumptions WHERE event_id = $1',
        [event.rows[0]!.id],
      );
      expect(consumptions.rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Roteamento
  // -------------------------------------------------------------------------
  describe('roteamento de eventos', () => {
    it('tenant.created chega ao consumidor', async () => {
      const { tenantId, eventId, name } = await seedTenantAndEvent();
      const message: QueueMessage = {
        outboxEventId: eventId,
        tenantId: null,
        eventType: 'tenant.created',
        payload: {
          tenantId,
          slug: 'irrelevante',
          name,
          createdByUserId: '00000000-0000-0000-0000-000000000001',
        },
      };

      await handleMessage(worker, message);

      const { rows } = await owner.query('SELECT 1 FROM tenant_branding WHERE tenant_id = $1', [
        tenantId,
      ]);
      expect(rows).toHaveLength(1);
    });

    it('evento sem consumidor FALHA em vez de sumir', async () => {
      await expect(
        handleMessage(worker, {
          outboxEventId: '00000000-0000-0000-0000-000000000002',
          tenantId: null,
          eventType: 'evento.inexistente',
          payload: {},
        }),
      ).rejects.toThrow(/sem consumidor/i);
    });

    it('eventos de vinculo sao reconhecidos sem efeito nesta fase', async () => {
      await expect(
        handleMessage(worker, {
          outboxEventId: '00000000-0000-0000-0000-000000000003',
          tenantId: null,
          eventType: 'membership.granted',
          payload: {},
        }),
      ).resolves.toBeUndefined();
    });
  });
});
