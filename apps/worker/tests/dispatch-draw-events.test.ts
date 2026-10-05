import { describe, expect, it, vi } from 'vitest';
import type { DbPool } from '@clubedarifa/db';
import { handleMessage } from '../src/dispatch.js';
import type { QueueMessage } from '../src/queue.js';

/**
 * Eventos CONHECIDOS que ainda nao tem consumidor. Os que tem (order.paid,
 * draw.activated, draw.sales_closed, draw.result_published) sao exercitados, com
 * banco, em consumers.test.ts.
 */
const EVENTOS_RECONHECIDOS = [
  'draw.submitted',
  'draw.approved',
  'draw.rejected',
  'draw.paused',
  'draw.resumed',
  'draw.apuration_started',
  'draw.archived',
  'draw.result_corrected',
  'payment.refund_required',
  'membership.granted',
  'membership.revoked',
] as const;

/**
 * Evento de sorteio conhecido e sem consumidor e LOG, nao erro. Falhar faria a
 * fila reentregar ate a dead-letter algo que nao tem o que executar.
 */
describe('dispatch · eventos do ciclo de vida do sorteio', () => {
  for (const eventType of EVENTOS_RECONHECIDOS) {
    it(`${eventType} e reconhecido sem consumidor e nao lanca`, async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const message = {
        outboxEventId: '11111111-1111-4111-8111-111111111111',
        eventType,
        payload: {},
      } as unknown as QueueMessage;

      await expect(handleMessage(null as unknown as DbPool, message)).resolves.toBeUndefined();

      expect(log).toHaveBeenCalledWith(expect.stringContaining('reconhecido sem consumidor'));
      log.mockRestore();
    });
  }

  it('evento desconhecido continua falhando (nao some em silencio)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const message = { outboxEventId: 'x', eventType: 'draw.inventado', payload: {} } as unknown as QueueMessage;
    await expect(handleMessage(null as unknown as DbPool, message)).rejects.toThrow(/sem consumidor/i);
    err.mockRestore();
  });
});
