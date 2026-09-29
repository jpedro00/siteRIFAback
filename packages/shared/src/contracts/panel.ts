import { z } from 'zod';
import { MEMBERSHIP_ROLES } from '../permissions/roles.js';
import { DRAW_STATUSES } from '../states/drawStatus.js';

/**
 * Contratos do painel do organizador e do console: equipe, convites, dashboard e
 * a lista de pedidos de um sorteio.
 */

// ---------------------------------------------------------------------------
// Equipe e convites (P9 · RN11)
// ---------------------------------------------------------------------------

const roleSchema = z.enum(MEMBERSHIP_ROLES);

export const teamMemberSchema = z.object({
  membershipId: z.string().uuid(),
  userId: z.string().uuid(),
  email: z.string(),
  displayName: z.string(),
  role: roleSchema,
  acceptedAt: z.string().nullable(),
  /** E a pessoa logada. Ela nao muda o proprio papel nem se remove: evita trancar-se para fora. */
  isSelf: z.boolean(),
});
export type TeamMember = z.infer<typeof teamMemberSchema>;

export const teamInvitationSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  role: roleSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
  expired: z.boolean(),
});
export type TeamInvitation = z.infer<typeof teamInvitationSchema>;

export const teamResponseSchema = z.object({
  members: z.array(teamMemberSchema),
  invitations: z.array(teamInvitationSchema),
});
export type TeamResponse = z.infer<typeof teamResponseSchema>;

export const inviteMemberRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  role: roleSchema,
});
export type InviteMemberRequest = z.infer<typeof inviteMemberRequestSchema>;

/**
 * O `token` aparece UMA vez, aqui. So o hash fica no banco: quem o perde precisa
 * reenviar o convite, que revoga o anterior e gera outro.
 */
export const inviteMemberResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  role: roleSchema,
  expiresAt: z.string(),
  token: z.string(),
});
export type InviteMemberResponse = z.infer<typeof inviteMemberResponseSchema>;

export const changeMemberRoleRequestSchema = z.object({ role: roleSchema });
export type ChangeMemberRoleRequest = z.infer<typeof changeMemberRoleRequestSchema>;

export const invitationPreviewSchema = z.object({
  tenantName: z.string(),
  role: roleSchema,
  /** "m***@exemplo.com": o convite nao entrega o e-mail inteiro a quem so tem o link. */
  emailMasked: z.string(),
  expiresAt: z.string(),
  state: z.enum(['OPEN', 'ACCEPTED', 'REVOKED', 'EXPIRED']),
});
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

export const acceptInvitationResponseSchema = z.object({
  tenantSlug: z.string(),
  tenantName: z.string(),
  role: roleSchema,
});
export type AcceptInvitationResponse = z.infer<typeof acceptInvitationResponseSchema>;

// ---------------------------------------------------------------------------
// Dashboard do organizador
// ---------------------------------------------------------------------------

export const dashboardSalesDaySchema = z.object({
  /** Dia no fuso America/Sao_Paulo, AAAA-MM-DD. */
  date: z.string(),
  paidNumbers: z.number().int().nonnegative(),
  /** Nulo para quem nao tem `payment:read:full`. */
  revenueCents: z.number().int().nonnegative().nullable(),
});

export const dashboardResponseSchema = z.object({
  generatedAt: z.string(),
  drawsByStatus: z.record(z.enum(DRAW_STATUSES), z.number().int().nonnegative()),
  /** RN18: so PAGO conta como vendido. */
  soldNumbers: z.number().int().nonnegative(),
  /** So PAGO. Nulo sem `payment:read:full`. */
  revenueCents: z.number().int().nonnegative().nullable(),
  /** Numeros com reserva ainda valida. */
  activeReservations: z.number().int().nonnegative(),
  /** Pedidos com PIX gerado e ainda nao pago. */
  pendingPix: z.number().int().nonnegative(),
  /** Pagamentos aprovados que precisam de devolucao manual. Nulo sem `payment:read:full`. */
  manualRefunds: z.number().int().nonnegative().nullable(),
  /** Ultimos 30 dias, sem buracos: dia sem venda aparece com zero. */
  salesByDay: z.array(dashboardSalesDaySchema),
});
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;

// ---------------------------------------------------------------------------
// Pedidos de um sorteio (organizador)
// ---------------------------------------------------------------------------

export const drawOrderSchema = z.object({
  orderId: z.string().uuid(),
  status: z.enum(['PENDENTE', 'PAGO', 'CANCELADO']),
  createdAt: z.string(),
  paidAt: z.string().nullable(),
  quantity: z.number().int().positive(),
  totalCents: z.number().int().positive(),
  numbers: z.array(z.number().int().nonnegative()),
  /**
   * Nome do comprador. INTEIRO so com `buyer:read:full`; senao vem mascarado
   * ("M*** S***"). Ler o pedido nao e o mesmo direito que ler dado pessoal.
   */
  buyerName: z.string(),
  buyerPhone: z.string().nullable(),
  buyerEmail: z.string().nullable(),
  paymentStatus: z.enum(['PENDENTE', 'APROVADO', 'EXPIRADO', 'CANCELADO', 'ESTORNADO']).nullable(),
  needsManualRefund: z.boolean(),
});
export type DrawOrder = z.infer<typeof drawOrderSchema>;

export const drawOrdersResponseSchema = z.object({
  orders: z.array(drawOrderSchema),
  nextCursor: z.string().nullable(),
  /** Os campos de contato vieram preenchidos? Falso para quem so tem `payment:read:status`. */
  contactVisible: z.boolean(),
});
export type DrawOrdersResponse = z.infer<typeof drawOrdersResponseSchema>;

/** CSV pronto para baixar. So `buyer:read:full`: o arquivo carrega dado pessoal. */
export const exportOrdersResponseSchema = z.object({
  filename: z.string(),
  content: z.string(),
});
export type ExportOrdersResponse = z.infer<typeof exportOrdersResponseSchema>;
