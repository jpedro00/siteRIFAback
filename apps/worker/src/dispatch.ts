import type { DbPool } from '@clubedarifa/db';
import type { QueueMessage } from './queue.js';
import { provisionTenantBranding } from './consumers/provisionTenantBranding.js';
import {
  consumeDrawActivated,
  consumeOrderPaid,
  consumeResultPublished,
  consumeSalesClosed,
} from './consumers/drawEvents.js';
import { log as logRaiz } from './lib/log.js';

/**
 * Roteamento da mensagem para o consumidor correspondente.
 *
 * Fica num modulo proprio para que os testes exercitem o consumo real sem
 * subir o processo do worker, abrir a fila ou tocar a rede.
 *
 * Toda linha de log leva `event_id`, `event_type` e `tenant_id`: e assim que a
 * linha do worker se liga a da API que gravou o evento.
 */
export async function handleMessage(pool: DbPool, message: QueueMessage): Promise<void> {
  const inicio = Date.now();
  const log = logRaiz.child({
    event_id: message.outboxEventId,
    event_type: message.eventType,
    tenant_id: message.tenantId,
  });

  /** Executa o consumidor, com log de inicio, fim (e motivo) e erro. */
  async function executar(
    consumidor: () => Promise<{ applied: boolean; reason?: string }>,
  ): Promise<void> {
    log.info('evento iniciado');
    try {
      const resultado = await consumidor();
      // O motivo importa no diagnostico: "ja consumido" e sucesso da
      // idempotencia, nao trabalho perdido.
      log.info('evento concluido', {
        duration_ms: Date.now() - inicio,
        outcome: resultado.applied ? 'efeito aplicado' : (resultado.reason ?? 'sem efeito'),
      });
    } catch (error) {
      log.error('evento FALHOU', {
        duration_ms: Date.now() - inicio,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  const entrada = { eventId: message.outboxEventId, payload: message.payload };

  switch (message.eventType) {
    case 'tenant.created':
      await executar(() => provisionTenantBranding(pool, entrada));
      return;

    case 'order.paid':
      await executar(() => consumeOrderPaid(pool, entrada));
      return;

    case 'draw.activated':
      await executar(() => consumeDrawActivated(pool, entrada));
      return;

    case 'draw.result_published':
      await executar(() => consumeResultPublished(pool, entrada));
      return;

    case 'draw.sales_closed':
      await executar(() => consumeSalesClosed(pool, log, entrada));
      return;

    case 'membership.granted':
    case 'membership.revoked':
    case 'draw.submitted':
    case 'draw.approved':
    case 'draw.rejected':
    case 'draw.paused':
    case 'draw.resumed':
    case 'draw.apuration_started':
    case 'draw.result_corrected':
    case 'payment.refund_required':
      // Gravados na outbox, mas sem consumidor nesta fase. Um evento CONHECIDO sem
      // consumidor e log, nao erro: falhar faria a fila reentregar, ate a
      // dead-letter, algo que nao tem o que executar.
      log.info('reconhecido sem consumidor nesta fase');
      return;

    default:
      // Evento desconhecido nao e descartado silenciosamente: falhar faz a
      // fila tentar de novo e deixa o problema visivel.
      log.error('sem consumidor registrado');
      throw new Error(`Evento sem consumidor: ${message.eventType}`);
  }
}
