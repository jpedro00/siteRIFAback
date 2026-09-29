import { z } from 'zod';
import { DRAW_STATUSES, type DrawStatus } from '../states/drawStatus.js';

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
 * Fundacao e ciclo de vida do sorteio. Eventos de pagamento e notificacao
 * pertencem as fases seguintes.
 */
export const OUTBOX_EVENT_TYPES = [
  'tenant.created',
  'membership.granted',
  'membership.revoked',
  'draw.submitted',
  'draw.approved',
  'draw.rejected',
  'draw.activated',
  'draw.paused',
  'draw.resumed',
  'draw.sales_closed',
  'order.paid',
  'payment.refund_required',
  'draw.apuration_started',
  'draw.result_published',
  'draw.result_corrected',
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

/**
 * Eventos do ciclo de vida do sorteio. Todos compartilham o mesmo formato: o
 * que muda de um para outro e o TIPO, nao os dados. `draw.activated` e o
 * gatilho da Fase 8.
 */
export const drawLifecyclePayloadSchema = z.object({
  tenantId: z.string().uuid(),
  drawId: z.string().uuid(),
  from: z.enum(DRAW_STATUSES),
  to: z.enum(DRAW_STATUSES),
  actorUserId: z.string().uuid().nullable(),
  actorType: z.enum(['USER', 'PLATFORM', 'SYSTEM']),
  reason: z.string().nullable(),
});
export type DrawLifecyclePayload = z.infer<typeof drawLifecyclePayloadSchema>;

export const DRAW_EVENT_TYPES = [
  'draw.submitted',
  'draw.approved',
  'draw.rejected',
  'draw.activated',
  'draw.paused',
  'draw.resumed',
  'draw.sales_closed',
  'draw.apuration_started',
] as const satisfies readonly OutboxEventType[];
export type DrawEventType = (typeof DRAW_EVENT_TYPES)[number];

/**
 * Eventos publicados por uma transicao. Aprovar para ATIVA publica DOIS: a
 * aprovacao e a ativacao sao fatos distintos, e so o segundo dispara a Fase 8.
 * Transicao sem evento devolve lista vazia — a API a recusa antes de chegar aqui.
 */
export function drawTransitionEvents(from: DrawStatus, to: DrawStatus): DrawEventType[] {
  if (from === 'RASCUNHO' && to === 'REVISÃO COMPLIANCE') return ['draw.submitted'];
  if (from === 'REVISÃO COMPLIANCE' && to === 'ATIVA') return ['draw.approved', 'draw.activated'];
  if (from === 'REVISÃO COMPLIANCE' && to === 'AGENDADA') return ['draw.approved'];
  if (from === 'REVISÃO COMPLIANCE' && to === 'RASCUNHO') return ['draw.rejected'];
  if (from === 'AGENDADA' && to === 'ATIVA') return ['draw.activated'];
  if (from === 'ATIVA' && to === 'PAUSADA') return ['draw.paused'];
  if (from === 'PAUSADA' && to === 'ATIVA') return ['draw.resumed'];
  if ((from === 'ATIVA' || from === 'PAUSADA') && to === 'VENDAS ENCERRADAS') {
    return ['draw.sales_closed'];
  }
  if (from === 'VENDAS ENCERRADAS' && to === 'APURAÇÃO') return ['draw.apuration_started'];
  return [];
}

/**
 * `order.paid`: o PSP confirmou e a venda foi concluida (numeros PAGO). E o
 * gatilho de esgotamento e de limiares ("faltam X"). Idempotente por pedido:
 * publicado UMA vez, na transicao para PAGO.
 */
export const orderPaidPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  orderId: z.string().uuid(),
  drawId: z.string().uuid(),
  paymentId: z.string().uuid().nullable(),
  quantity: z.number().int().positive(),
  totalCents: z.number().int().positive(),
});
export type OrderPaidPayload = z.infer<typeof orderPaidPayloadSchema>;

/**
 * Pagamento aprovado cujo numero ja tem outro dono (Suposicao S4): a venda nao
 * se conclui e alguem precisa devolver o dinheiro. Estorno automatico fica para
 * depois; este evento existe para o painel avisar.
 */
export const paymentRefundRequiredPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  orderId: z.string().uuid(),
  drawId: z.string().uuid(),
  paymentId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  reason: z.string(),
});
export type PaymentRefundRequiredPayload = z.infer<typeof paymentRefundRequiredPayloadSchema>;

/**
 * Resultado publicado ou corrigido. `winningNumber` nulo = ninguem contemplado.
 * A publicacao e a correcao NAO saem de `drawTransitionEvents`: nascem no servico
 * de resultado, porque carregam a prova (hash) alem da mudanca de estado.
 */
export const drawResultPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  drawId: z.string().uuid(),
  resultId: z.string().uuid(),
  version: z.number().int().positive(),
  winningNumber: z.number().int().nonnegative().nullable(),
  proofSha256: z.string(),
});
export type DrawResultPayload = z.infer<typeof drawResultPayloadSchema>;

export const OUTBOX_PAYLOAD_SCHEMAS = {
  'tenant.created': tenantCreatedPayloadSchema,
  'membership.granted': membershipGrantedPayloadSchema,
  'membership.revoked': membershipRevokedPayloadSchema,
  'draw.submitted': drawLifecyclePayloadSchema,
  'draw.approved': drawLifecyclePayloadSchema,
  'draw.rejected': drawLifecyclePayloadSchema,
  'draw.activated': drawLifecyclePayloadSchema,
  'draw.paused': drawLifecyclePayloadSchema,
  'draw.resumed': drawLifecyclePayloadSchema,
  'draw.sales_closed': drawLifecyclePayloadSchema,
  'draw.apuration_started': drawLifecyclePayloadSchema,
  'draw.result_published': drawResultPayloadSchema,
  'draw.result_corrected': drawResultPayloadSchema,
  'order.paid': orderPaidPayloadSchema,
  'payment.refund_required': paymentRefundRequiredPayloadSchema,
} as const satisfies Record<OutboxEventType, z.ZodTypeAny>;
