import { z } from 'zod';

/**
 * Super Admin · usuarios, criadores e metricas da plataforma.
 *
 * NADA aqui devolve segredo: nem hash de senha, nem segredo de MFA, nem token de sessao, nem
 * credencial de PSP. E-mail e nome aparecem porque o operador precisa localizar a conta; a
 * rota que os lista exige permissao propria (`platform:user:read`) e MFA.
 *
 * "Criador" nao e outro tipo de usuario: e a visao de uma comunidade com os seus donos.
 */

export const platformUserSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  email: z.string(),
  status: z.string(),
  createdAt: z.string(),
  /** Vinculos ativos com comunidades (qualquer papel). */
  membershipsCount: z.number().int().nonnegative(),
  /** Pedidos feitos com esta conta (compras como visitante nao entram). */
  ordersCount: z.number().int().nonnegative(),
  /** Papeis de plataforma vigentes, se for administrador. */
  platformRoles: z.array(z.string()),
});
export type PlatformUser = z.infer<typeof platformUserSchema>;

export const platformUserListResponseSchema = z.object({
  users: z.array(platformUserSchema),
  nextCursor: z.string().nullable(),
});
export type PlatformUserListResponse = z.infer<typeof platformUserListResponseSchema>;

export const platformCreatorOwnerSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string(),
  email: z.string(),
});

export const platformCreatorSchema = z.object({
  tenantId: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  status: z.string(),
  createdAt: z.string(),
  owners: z.array(platformCreatorOwnerSchema),
  /** Nome do plano da assinatura viva; nulo se nao houver assinatura. */
  planName: z.string().nullable(),
  subscriptionStatus: z.string().nullable(),
  /** Situacao da conta de recebimento (CONNECTED, DISCONNECTING...) ou nulo se nao conectou. */
  paymentAccountStatus: z.string().nullable(),
  publicDraws: z.number().int().nonnegative(),
  activeDraws: z.number().int().nonnegative(),
});
export type PlatformCreator = z.infer<typeof platformCreatorSchema>;

export const platformCreatorListResponseSchema = z.object({
  creators: z.array(platformCreatorSchema),
  nextCursor: z.string().nullable(),
});
export type PlatformCreatorListResponse = z.infer<typeof platformCreatorListResponseSchema>;

export const platformMetricsSchema = z.object({
  generatedAt: z.string(),
  users: z.object({ total: z.number().int(), active: z.number().int() }),
  communities: z.object({ total: z.number().int(), active: z.number().int() }),
  /** Comunidades ativas com pelo menos uma rifa publica (ativa, pausada, encerrada ou com resultado). */
  creatorsWithPublishedDraw: z.number().int(),
  drawsByStatus: z.record(z.string(), z.number().int()),
  subscriptionsByStatus: z.record(z.string(), z.number().int()),
  orders: z.object({
    paid: z.number().int(),
    /** Soma bruta dos pedidos PAGOS, so informativa. Nula para quem nao tem permissao financeira. */
    grossPaidCents: z.number().int().nullable(),
  }),
});
export type PlatformMetrics = z.infer<typeof platformMetricsSchema>;
