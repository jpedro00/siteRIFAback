import { z } from 'zod';

/**
 * Tipos de evento gravados na tabela `outbox`.
 *
 * A outbox NAO e a fila de execucao. Ela e o registro transacional do que
 * aconteceu: o evento e gravado na MESMA transacao da alteracao que o
 * originou. Um relay separado (apps/worker) le a outbox e publica na fila
 * (pg-boss), que e quem executa. Isso da entrega AO MENOS UMA VEZ; a
 * ausencia de duplicidade depende do consumidor ser idempotente, nao de
 * nenhuma constraint sozinha.
 *
 * Esta fase declara apenas eventos da fundacao. Eventos de sorteio, pagamento
 * e notificacao pertencem as fases seguintes.
 */
export const OUTBOX_EVENT_TYPES = [
  'tenant.created',
  'membership.granted',
  'membership.revoked',
] as const;

export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

export function isOutboxEventType(value: unknown): value is OutboxEventType {
  return typeof value === 'string' && (OUTBOX_EVENT_TYPES as readonly string[]).includes(value);
}

export const tenantCreatedPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  createdByUserId: z.string().uuid(),
});
export type TenantCreatedPayload = z.infer<typeof tenantCreatedPayloadSchema>;

export const membershipGrantedPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  membershipId: z.string().uuid(),
  userId: z.string().uuid(),
  role: z.string(),
  grantedByUserId: z.string().uuid().nullable(),
});
export type MembershipGrantedPayload = z.infer<typeof membershipGrantedPayloadSchema>;

export const membershipRevokedPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  membershipId: z.string().uuid(),
  userId: z.string().uuid(),
  revokedByUserId: z.string().uuid().nullable(),
});
export type MembershipRevokedPayload = z.infer<typeof membershipRevokedPayloadSchema>;

export const OUTBOX_PAYLOAD_SCHEMAS = {
  'tenant.created': tenantCreatedPayloadSchema,
  'membership.granted': membershipGrantedPayloadSchema,
  'membership.revoked': membershipRevokedPayloadSchema,
} as const satisfies Record<OutboxEventType, z.ZodTypeAny>;
