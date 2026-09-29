import type { DbPool } from '@clubedarifa/db';
import type { QueueMessage } from './queue.js';
import { provisionTenantBranding } from './consumers/provisionTenantBranding.js';

/**
 * Roteamento da mensagem para o consumidor correspondente.
 *
 * Fica num modulo proprio para que os testes exercitem o consumo real sem
 * subir o processo do worker, abrir a fila ou tocar a rede.
 */
export async function handleMessage(pool: DbPool, message: QueueMessage): Promise<void> {
  const inicio = Date.now();
  const marca = `[job] ${message.eventType} evento=${message.outboxEventId}`;

  switch (message.eventType) {
    case 'tenant.created': {
      console.log(`${marca} iniciado`);
      try {
        const resultado = await provisionTenantBranding(pool, {
          eventId: message.outboxEventId,
          payload: message.payload,
        });
        // O motivo importa no diagnostico: "ja consumido" e sucesso da
        // idempotencia, nao trabalho perdido. Sem distinguir, toda reentrega
        // pareceria um problema.
        console.log(
          `${marca} concluido em ${Date.now() - inicio}ms ` +
            `(${resultado.applied ? 'efeito aplicado' : (resultado.reason ?? 'sem efeito')})`,
        );
      } catch (error) {
        console.error(
          `${marca} FALHOU em ${Date.now() - inicio}ms:`,
          error instanceof Error ? error.message : error,
        );
        throw error;
      }
      return;
    }

    case 'membership.granted':
    case 'membership.revoked':
      // Registrados no catalogo da fundacao e gravados na outbox, mas sem
      // consumidor nesta fase. Reconhecer sem agir e melhor do que inventar um
      // efeito que a especificacao nao pediu.
      console.log(`${marca} reconhecido sem consumidor nesta fase`);
      return;

    case 'draw.submitted':
    case 'draw.approved':
    case 'draw.rejected':
    case 'draw.activated':
    case 'draw.paused':
    case 'draw.resumed':
    case 'draw.sales_closed':
    case 'order.paid':
    case 'payment.refund_required':
      // Ciclo de vida do sorteio e pagamento: gravados na mesma transacao da
      // mudanca, ainda sem consumidor. `draw.activated` e o gatilho da Fase 8.
      // Um evento CONHECIDO sem consumidor e log, nao erro: falhar aqui faria a
      // fila reentregar, ate a dead-letter, algo que nao tem o que executar.
      console.log(`${marca} reconhecido sem consumidor nesta fase`);
      return;

    default:
      // Evento desconhecido nao e descartado silenciosamente: falhar faz a
      // fila tentar de novo e deixa o problema visivel.
      console.error(`${marca} sem consumidor registrado`);
      throw new Error(`Evento sem consumidor: ${message.eventType}`);
  }
}
