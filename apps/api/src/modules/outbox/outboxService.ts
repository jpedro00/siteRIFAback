import type { PoolClient } from '@campaigns/db';
import { OUTBOX_PAYLOAD_SCHEMAS, type OutboxEventType } from '@campaigns/shared';

/**
 * M12 · gravacao de evento na outbox.
 *
 * Recebe o CLIENT da transacao, nunca o pool. O evento e gravado na MESMA
 * transacao da mudanca que o originou: se a mudanca sofrer rollback, o evento
 * some junto. E isso que impede um evento de anunciar algo que nao aconteceu.
 *
 * A API NAO publica na fila e NAO marca o evento como publicado — nao tem
 * sequer GRANT de UPDATE na tabela. Publicar e responsabilidade do relay
 * (apps/worker), e executar e responsabilidade da fila.
 *
 * O payload e validado contra o schema compartilhado antes de entrar: um
 * evento gravado com formato errado so seria descoberto do outro lado, no
 * consumidor, depois do commit.
 */
export async function enqueueOutboxEvent<T extends OutboxEventType>(
  client: PoolClient,
  input: { tenantId: string | null; eventType: T; payload: unknown },
): Promise<string> {
  const schema = OUTBOX_PAYLOAD_SCHEMAS[input.eventType];
  const payload = schema.parse(input.payload);

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO outbox (tenant_id, event_type, payload)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id`,
    [input.tenantId, input.eventType, JSON.stringify(payload)],
  );
  return rows[0]!.id;
}
