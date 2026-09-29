import { z } from 'zod';
import { ALLOWED_GRID_SIZES } from '../constants/grid.js';
import { NO_WINNER_POLICIES, drawSnapshotInfoSchema } from './result.js';
import {
  DRAW_CLOSE_MODES,
  DRAW_RESULT_SOURCES,
  DRAW_STATUSES,
  PLATFORM_REVIEW_DECISIONS,
} from '../states/drawStatus.js';

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
  /**
   * Preco EFETIVO por numero: o promocional enquanto vigente, o cheio depois.
   * E o valor que o pedido copia. Calculado no servidor (RN15); o cliente nunca
   * decide qual preco vale.
   */
  unitPriceCents: z.number().int().positive(),
  /** Preco cheio, sem promocao. Mostrado riscado quando `promoActive`. */
  ticketPriceCents: z.number().int().positive(),
  /** Promocional VIGENTE; nulo quando nao ha promocao ou ela ja venceu. */
  promotionalPriceCents: z.number().int().positive().nullable(),
  promoUntil: z.string().nullable(),
  promoActive: z.boolean(),
  totalNumbers: z.number().int().positive(),
  /** RN13: 2 digitos na grade de 100; 3 nas de 500 e 1000. */
  labelDigits: z.union([z.literal(2), z.literal(3)]),
  /** A vitrine mostra o sorteio ate o resultado; rascunho e revisao nunca chegam aqui. */
  status: z.enum(DRAW_STATUSES),
  drawDate: z.string().nullable(),
  /** RN18: somente PAGO conta como vendido. Reservado NAO entra aqui. */
  paidCount: z.number().int().nonnegative(),
});
export type PublicDrawSummary = z.infer<typeof publicDrawSummarySchema>;

export const publicDrawListResponseSchema = z.object({
  /** Cursor para a proxima pagina; nulo no fim. */
  nextCursor: z.string().nullable(),
  draws: z.array(publicDrawSummarySchema),
});
export type PublicDrawListResponse = z.infer<typeof publicDrawListResponseSchema>;

export const prizeSchema = z.object({
  position: z.number().int().positive(),
  name: z.string(),
  description: z.string().nullable(),
  imageUrl: z.string().nullable(),
});
export type Prize = z.infer<typeof prizeSchema>;

export const publicDrawDetailSchema = publicDrawSummarySchema.extend({
  prizeDescription: z.string().nullable(),
  /** Todos os premios, em ordem de posicao. O primeiro e o "premio principal". */
  prizes: z.array(prizeSchema),
  closeMode: z.enum(DRAW_CLOSE_MODES),
  closeAt: z.string().nullable(),
  salesStartAt: z.string().nullable(),
  resultSource: z.enum(DRAW_RESULT_SOURCES),
  noWinnerPolicy: z.enum(NO_WINNER_POLICIES),
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
  /**
   * Consentimento para receber mensagens sobre o pedido. E OUTRA decisao, separada
   * do aceite do regulamento: nao e condicao para comprar. Ausente = nao consentiu.
   */
  messagingConsent: z.boolean().optional(),
});
export type CreateOrderRequest = z.infer<typeof createOrderRequestSchema>;

/**
 * Cobranca PIX de um pedido. `copyPaste` e o "copia e cola"; `qrCodeBase64` e a
 * imagem, quando o provedor a entrega. O prazo (`expiresAt`) nunca passa do fim
 * da reserva: o PIX morre antes de os numeros voltarem para a grade.
 */
/** Estados de uma cobranca. Identicos ao enum `payment_status` (0013); ha teste de paridade. */
export const PAYMENT_STATUSES = ['PENDENTE', 'APROVADO', 'EXPIRADO', 'CANCELADO', 'ESTORNADO'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const pixPaymentSchema = z.object({
  status: z.enum(PAYMENT_STATUSES),
  copyPaste: z.string().nullable(),
  qrCodeBase64: z.string().nullable(),
  expiresAt: z.string(),
  /** Pagamento aprovado depois de o numero ter outro dono: a devolucao e manual. */
  needsManualRefund: z.boolean(),
});
export type PixPayment = z.infer<typeof pixPaymentSchema>;

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
  /** Cobranca PIX mais recente. Nula ate ser gerada (ou se o PSP estiver fora). */
  payment: pixPaymentSchema.nullable(),
});
export type OrderResponse = z.infer<typeof orderResponseSchema>;

// ---------------------------------------------------------------------------
// Organizador
// ---------------------------------------------------------------------------

export const organizerDrawSchema = publicDrawDetailSchema.extend({
  /** O organizador enxerga o ciclo inteiro, inclusive REVISAO COMPLIANCE. */
  status: z.enum(DRAW_STATUSES),
  reservedCount: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
  /** RN18: arrecadacao conta somente o que foi PAGO. */
  revenueCents: z.number().int().nonnegative(),
  createdAt: z.string(),
  /** Limiares de aviso "faltam X". Padrao 25 e 10. */
  thresholds: z.array(z.number().int()),
  /** Promocao COMO CONFIGURADA, vigente ou nao — para o organizador editar. */
  configuredPromotionalPriceCents: z.number().int().nullable(),
  configuredPromoUntil: z.string().nullable(),
  /** Motivo da ultima reprovacao na revisao, ate a proxima decisao. */
  reviewNote: z.string().nullable(),
  /** Retrato congelado das vendas (RN20); nulo ate as vendas fecharem sem pendencia. */
  snapshot: drawSnapshotInfoSchema.nullable(),
});
export type OrganizerDraw = z.infer<typeof organizerDrawSchema>;

export const organizerDrawListResponseSchema = z.object({
  nextCursor: z.string().nullable(),
  draws: z.array(organizerDrawSchema),
});
export type OrganizerDrawListResponse = z.infer<typeof organizerDrawListResponseSchema>;

/** Link de imagem: so https (Suposicao temporaria S-IMG1, ate haver armazenamento). */
const httpsUrlSchema = z
  .string()
  .url()
  .max(2000)
  .refine((v) => v.toLowerCase().startsWith('https://'), {
    message: 'O link da imagem precisa começar com https://',
  });

export const prizeInputSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().max(4000).optional(),
  imageUrl: httpsUrlSchema.optional(),
});
export type PrizeInput = z.infer<typeof prizeInputSchema>;

/**
 * Regras entre campos de preco e cronograma. Funcao PURA, sem zod: a mesma
 * verificacao serve a criacao, a edicao (sobre o estado JA mesclado) e o
 * assistente do organizador, que a mostra enquanto a pessoa digita.
 *
 * Devolve a lista de problemas em portugues; vazia = valido. O banco tem as
 * mesmas regras como CHECK — esta lista existe para dar a mensagem certa antes.
 */
export interface DrawRulesInput {
  readonly ticketPriceCents?: number | null | undefined;
  readonly promotionalPriceCents?: number | null | undefined;
  readonly promoUntil?: string | null | undefined;
  readonly salesStartAt?: string | null | undefined;
  readonly closeAt?: string | null | undefined;
  readonly drawDate?: string | null | undefined;
}

export function validateDrawRules(d: DrawRulesInput): string[] {
  const problemas: string[] = [];
  const has = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined;

  if (has(d.promotionalPriceCents) !== has(d.promoUntil)) {
    problemas.push('O preço promocional e o prazo da promoção são informados juntos.');
  }
  if (
    has(d.promotionalPriceCents) &&
    has(d.ticketPriceCents) &&
    d.promotionalPriceCents >= d.ticketPriceCents
  ) {
    problemas.push('O preço promocional precisa ser menor que o preço cheio.');
  }

  const t = (v: string | null | undefined) => (has(v) ? Date.parse(v) : NaN);
  if (has(d.closeAt) && has(d.drawDate) && !(t(d.closeAt) < t(d.drawDate))) {
    problemas.push('O fechamento das vendas precisa ser anterior à data do sorteio.');
  }
  if (has(d.salesStartAt) && has(d.closeAt) && !(t(d.salesStartAt) < t(d.closeAt))) {
    problemas.push('O início das vendas precisa ser anterior ao fechamento.');
  }
  return problemas;
}

/**
 * O que falta para enviar o sorteio a revisao (checklist do passo final do
 * assistente, DOC-01 §4). `closeMode` diferente de AO_ESGOTAR exige `closeAt`:
 * isso NAO e CHECK do banco — o rascunho e salvo a cada passo — e por isso e
 * conferido AQUI, no envio.
 */
export interface DrawReadinessInput extends DrawRulesInput {
  readonly title?: string | null | undefined;
  readonly prizes?: readonly { readonly name: string }[] | undefined;
  readonly closeMode?: (typeof DRAW_CLOSE_MODES)[number] | null | undefined;
}

export function drawReadinessProblems(d: DrawReadinessInput): string[] {
  const problemas: string[] = [];
  if (!d.title || d.title.trim().length < 3) problemas.push('Informe o título do sorteio.');
  if (!d.prizes || d.prizes.length === 0 || d.prizes.some((p) => p.name.trim() === '')) {
    problemas.push('Cadastre ao menos um prêmio, com nome.');
  }
  if (!d.ticketPriceCents || d.ticketPriceCents <= 0) problemas.push('Defina o preço por número.');
  if (!d.drawDate) problemas.push('Defina a data do sorteio.');
  if (d.closeMode && d.closeMode !== 'AO_ESGOTAR' && !d.closeAt) {
    problemas.push('O modo de fechamento escolhido exige a data de fechamento das vendas.');
  }
  return [...problemas, ...validateDrawRules(d)];
}

const dateTimeSchema = z.string().datetime();

const drawEditableFields = {
  title: z.string().min(3).max(160),
  description: z.string().max(4000).optional(),
  /** Um ou mais premios; a ordem define a posicao (1 = principal). */
  prizes: z.array(prizeInputSchema).min(1).max(20),
  /** Preco cheio por numero, em centavos. */
  ticketPriceCents: z.number().int().positive().max(100_000_000),
  promotionalPriceCents: z.number().int().positive().max(100_000_000).optional(),
  promoUntil: dateTimeSchema.optional(),
  /** RN13: 100, 500 ou 1000. A lista vem da constante protegida. */
  totalNumbers: z.union([z.literal(100), z.literal(500), z.literal(1000)]),
  drawDate: dateTimeSchema.optional(),
  salesStartAt: dateTimeSchema.optional(),
  closeMode: z.enum(DRAW_CLOSE_MODES).optional(),
  closeAt: dateTimeSchema.optional(),
  /** Limiares "faltam X", em ordem decrescente. Padrao 25 e 10. */
  thresholds: z.array(z.number().int().min(1).max(99)).min(1).max(5).optional(),
  /** Se o numero apurado nao foi vendido (S5). Padrao: o proximo vendido acima. */
  noWinnerPolicy: z.enum(NO_WINNER_POLICIES).optional(),
} as const;

function refineDrawRules(
  v: DrawRulesInput & { thresholds?: number[] | undefined },
  ctx: z.RefinementCtx,
): void {
  for (const message of validateDrawRules(v)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  }
  const th = v.thresholds;
  if (th && th.some((x, i) => i > 0 && x >= th[i - 1]!)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Os limiares precisam estar em ordem decrescente.',
      path: ['thresholds'],
    });
  }
}

export const createDrawRequestSchema = z.object(drawEditableFields).superRefine(refineDrawRules);
export type CreateDrawRequest = z.infer<typeof createDrawRequestSchema>;

/**
 * Edicao do RASCUNHO: qualquer subconjunto dos campos. As regras entre campos
 * sao conferidas pelo servidor sobre o estado JA mesclado, porque um campo
 * isolado ("so o prazo da promocao") nao tem contra o que ser validado aqui.
 */
export const updateDrawRequestSchema = z
  .object(drawEditableFields)
  .partial()
  .extend({
    // `null` LIMPA o campo (tirar a promocao, o fechamento por data, a descricao).
    description: z.string().max(4000).nullable().optional(),
    promotionalPriceCents: z.number().int().positive().max(100_000_000).nullable().optional(),
    promoUntil: dateTimeSchema.nullable().optional(),
    drawDate: dateTimeSchema.nullable().optional(),
    salesStartAt: dateTimeSchema.nullable().optional(),
    closeAt: dateTimeSchema.nullable().optional(),
  });
export type UpdateDrawRequest = z.infer<typeof updateDrawRequestSchema>;

/**
 * Pedido de mudanca de estado do organizador. Aceita qualquer estado do ciclo:
 * quem decide o que e permitido e a API (ORGANIZER_DRAW_TRANSITIONS), com erro
 * claro. Limitar o enum aqui devolveria 400 generico para "CANCELADA", que
 * merece a explicacao de RN22.
 */
export const updateDrawStatusRequestSchema = z.object({
  status: z.enum(DRAW_STATUSES),
});
export type UpdateDrawStatusRequest = z.infer<typeof updateDrawStatusRequestSchema>;

/**
 * Decisao do Super Admin sobre um sorteio em REVISAO COMPLIANCE. RN02.
 * Reprovar (voltar a RASCUNHO) exige motivo: sem ele o organizador nao sabe o
 * que corrigir.
 */
export const reviewDrawRequestSchema = z
  .object({
    to: z.enum(PLATFORM_REVIEW_DECISIONS),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .refine((v) => v.to !== 'RASCUNHO' || (v.reason !== undefined && v.reason.length >= 3), {
    message: 'Informe o motivo da reprovação.',
    path: ['reason'],
  });
export type ReviewDrawRequest = z.infer<typeof reviewDrawRequestSchema>;

export const reviewQueueItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  prizeName: z.string(),
  unitPriceCents: z.number().int().positive(),
  totalNumbers: z.number().int().positive(),
  drawDate: z.string().nullable(),
  createdAt: z.string(),
  tenantId: z.string().uuid(),
  tenantSlug: z.string(),
  tenantName: z.string(),
});
export type ReviewQueueItem = z.infer<typeof reviewQueueItemSchema>;

export const reviewQueueResponseSchema = z.object({
  nextCursor: z.string().nullable(),
  draws: z.array(reviewQueueItemSchema),
});
export type ReviewQueueResponse = z.infer<typeof reviewQueueResponseSchema>;

/** Confirmacao de pagamento de DESENVOLVIMENTO. Recusada em producao. */
export const devConfirmPaymentResponseSchema = orderResponseSchema;

export const ALLOWED_GRID_SIZES_CONTRACT = ALLOWED_GRID_SIZES;
