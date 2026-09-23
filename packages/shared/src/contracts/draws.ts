import { z } from 'zod';
import { ALLOWED_GRID_SIZES } from '../constants/grid.js';
import { DRAW_STATUSES } from '../states/drawStatus.js';

/**
 * Contratos do nucleo de sorteios (Fase 2, primeira fatia).
 *
 * Os estados vem de `states/drawStatus.ts` e `states/numberStatus.ts`, que sao
 * constantes PROTEGIDAS por teste. Declarar aqui uma lista paralela em ingles
 * — `DRAFT`, `ACTIVE`, `SALES_CLOSED` — recriaria o erro E3 que a fundacao
 * existe para impedir: dois vocabularios para a mesma coisa, evoluindo em
 * separado ate uma CHECK desatualizada bloquear insercao em producao.
 */

/** Estados que esta fatia usa. Os demais pertencem a fases seguintes. */
export const DRAW_STATUSES_PHASE2 = [
  'RASCUNHO',
  'ATIVA',
  'PAUSADA',
  'VENDAS ENCERRADAS',
] as const satisfies readonly (typeof DRAW_STATUSES)[number][];

export type DrawStatusPhase2 = (typeof DRAW_STATUSES_PHASE2)[number];

/**
 * Estado de um numero, do ponto de vista de quem compra.
 *
 * `LIVRE` nao vem do banco: e a AUSENCIA de linha em `draw_numbers`. A vitrine
 * deriva o estado livre a partir do que NAO foi devolvido — e por isso a grade
 * de 1000 numeros trafega apenas os poucos que estao ocupados.
 */
export const PUBLIC_NUMBER_STATUSES = ['LIVRE', 'RESERVADO', 'PENDENTE', 'PAGO'] as const;
export type PublicNumberStatus = (typeof PUBLIC_NUMBER_STATUSES)[number];

// ---------------------------------------------------------------------------
// Vitrine
// ---------------------------------------------------------------------------

export const publicDrawSummarySchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  prizeName: z.string(),
  prizeImageUrl: z.string().nullable(),
  unitPriceCents: z.number().int().positive(),
  totalNumbers: z.number().int().positive(),
  status: z.enum(DRAW_STATUSES_PHASE2),
  drawDate: z.string().nullable(),
  /** RN18: somente PAGO conta como vendido. Reservado NAO entra aqui. */
  paidCount: z.number().int().nonnegative(),
});
export type PublicDrawSummary = z.infer<typeof publicDrawSummarySchema>;

export const publicDrawListResponseSchema = z.object({
  draws: z.array(publicDrawSummarySchema),
});
export type PublicDrawListResponse = z.infer<typeof publicDrawListResponseSchema>;

export const publicDrawDetailSchema = publicDrawSummarySchema.extend({
  prizeDescription: z.string().nullable(),
  /** Indisponiveis no momento: pagos, pendentes e reservas ainda no prazo. */
  takenCount: z.number().int().nonnegative(),
});
export type PublicDrawDetail = z.infer<typeof publicDrawDetailSchema>;

/**
 * Numeros OCUPADOS. Os livres nao viajam.
 *
 * Numa grade de 1000 com 40 vendidos, a resposta tem 40 itens em vez de 1000 —
 * diferenca que se sente no telefone do participante, que e onde a compra
 * acontece.
 */
export const drawNumbersResponseSchema = z.object({
  drawId: z.string().uuid(),
  totalNumbers: z.number().int().positive(),
  labelDigits: z.union([z.literal(2), z.literal(3)]),
  taken: z.array(
    z.object({
      number: z.number().int().nonnegative(),
      status: z.enum(['RESERVADO', 'PENDENTE', 'PAGO']),
    }),
  ),
});
export type DrawNumbersResponse = z.infer<typeof drawNumbersResponseSchema>;

// ---------------------------------------------------------------------------
// Reserva
// ---------------------------------------------------------------------------

export const createReservationRequestSchema = z.object({
  numbers: z.array(z.number().int().nonnegative()).min(1).max(100),
});
export type CreateReservationRequest = z.infer<typeof createReservationRequestSchema>;

export const reservationResponseSchema = z.object({
  reservationId: z.string().uuid(),
  drawId: z.string().uuid(),
  numbers: z.array(z.number().int().nonnegative()),
  expiresAt: z.string(),
  unitPriceCents: z.number().int().positive(),
  totalCents: z.number().int().positive(),
});
export type ReservationResponse = z.infer<typeof reservationResponseSchema>;

// ---------------------------------------------------------------------------
// Pedido
// ---------------------------------------------------------------------------

export const createOrderRequestSchema = z.object({
  reservationId: z.string().uuid(),
  buyer: z.object({
    name: z.string().min(2).max(160),
    phone: z.string().min(8).max(32),
    email: z.string().email().max(320).optional(),
  }),
  /**
   * Aceite explicito. Booleano que so aceita `true`: um valor ausente ou falso
   * e recusado na validacao, em vez de virar pedido sem aceite.
   */
  acceptedTerms: z.literal(true),
});
export type CreateOrderRequest = z.infer<typeof createOrderRequestSchema>;

export const orderResponseSchema = z.object({
  orderId: z.string().uuid(),
  status: z.enum(['PENDENTE', 'PAGO', 'CANCELADO']),
  drawId: z.string().uuid(),
  drawTitle: z.string(),
  numbers: z.array(z.number().int().nonnegative()),
  /**
   * Digitos do rotulo, vindos da grade do sorteio (RN13).
   *
   * Sem isto o comprovante nao teria como saber que o numero 5 de uma grade
   * de 1000 se escreve "005" — e o participante veria no recibo um numero
   * diferente do que escolheu na grade.
   */
  labelDigits: z.union([z.literal(2), z.literal(3)]),
  quantity: z.number().int().positive(),
  unitPriceCents: z.number().int().positive(),
  totalCents: z.number().int().positive(),
  buyerName: z.string(),
  createdAt: z.string(),
  paidAt: z.string().nullable(),
  /** Prazo restante da reserva. Nulo depois de pago. */
  expiresAt: z.string().nullable(),
});
export type OrderResponse = z.infer<typeof orderResponseSchema>;

// ---------------------------------------------------------------------------
// Organizador
// ---------------------------------------------------------------------------

export const organizerDrawSchema = publicDrawDetailSchema.extend({
  reservedCount: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
  /** RN18: arrecadacao conta somente o que foi PAGO. */
  revenueCents: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type OrganizerDraw = z.infer<typeof organizerDrawSchema>;

export const organizerDrawListResponseSchema = z.object({
  draws: z.array(organizerDrawSchema),
});
export type OrganizerDrawListResponse = z.infer<typeof organizerDrawListResponseSchema>;

export const createDrawRequestSchema = z.object({
  title: z.string().min(3).max(160),
  description: z.string().max(4000).optional(),
  prizeName: z.string().min(2).max(160),
  prizeDescription: z.string().max(4000).optional(),
  prizeImageUrl: z.string().url().max(2000).optional(),
  unitPriceCents: z.number().int().positive().max(100_000_000),
  /** RN13: 100, 500 ou 1000. A lista vem da constante protegida. */
  totalNumbers: z.union([z.literal(100), z.literal(500), z.literal(1000)]),
  drawDate: z.string().datetime().optional(),
});
export type CreateDrawRequest = z.infer<typeof createDrawRequestSchema>;

/** Transicoes permitidas nesta fatia. A maquina completa e do DOC-01 §7. */
export const updateDrawStatusRequestSchema = z.object({
  status: z.enum(['ATIVA', 'PAUSADA', 'VENDAS ENCERRADAS']),
});
export type UpdateDrawStatusRequest = z.infer<typeof updateDrawStatusRequestSchema>;

/** Confirmacao de pagamento de DESENVOLVIMENTO. Recusada em producao. */
export const devConfirmPaymentResponseSchema = orderResponseSchema;

export const ALLOWED_GRID_SIZES_CONTRACT = ALLOWED_GRID_SIZES;
