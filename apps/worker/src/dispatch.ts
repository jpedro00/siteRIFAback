import type { DbPool } from '@campaigns/db';
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

    default:
      // Evento desconhecido nao e descartado silenciosamente: falhar faz a
      // fila tentar de novo e deixa o problema visivel.
      console.error(`${marca} sem consumidor registrado`);
      throw new Error(`Evento sem consumidor: ${message.eventType}`);
  }
}
