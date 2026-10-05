import { z } from 'zod';
import { PAST_DUE_GRACE_DAYS_RANGE } from '../constants/billing.js';
import type { ApiErrorCode } from './errors.js';
import {
  BILLING_ADJUSTMENT_KINDS,
  BILLING_STATES,
  ENTITLEMENT_REASONS,
  INVOICE_STATUSES,
  PAYMENT_ACCOUNT_STATUSES,
  PAYMENT_AUTHORIZATION_STATUSES,
  PAYMENT_ENVIRONMENTS,
  PAYMENT_PROVIDERS,
  PLAN_INTERVALS,
  PLAN_STATUSES,
  STRIPE_EVENT_STATUSES,
  SUBSCRIPTION_STATUSES,
} from '../states/billing.js';

/**
 * Contratos da Fase 7: assinaturas da PLATAFORMA (Stripe) e recebimentos por
 * comunidade. Ainda SEM rotas em `ROUTE_CONTRACTS`: esta versao (0.9.0) fixa os
 * FORMATOS; as rotas entram junto de cada implementacao.
 *
 * Duas regras de desenho:
 *  1. NADA SECRETO atravessa a API. Nenhum schema aqui carrega token, segredo de
 *     webhook ou credencial — nem de resposta, nem de requisicao. A conexao de
 *     recebimentos usa a autorizacao oficial do provedor; o organizador nunca digita
 *     token.
 *  2. O PRECO NUNCA VEM DO NAVEGADOR. O pedido de contratacao leva so `planId`; quem
 *     decide o Price da Stripe e o servidor, a partir do catalogo.
 */

const isoDate = z.string().datetime({ offset: true });
const uuid = z.string().uuid();

// ---------------------------------------------------------------------------
// Planos (catalogo global, administrado pelo Super Admin)
// ---------------------------------------------------------------------------

/** Funcionalidades habilitadas por plano: identificadores curtos e estaveis. */
const featureKey = z
  .string()
  .regex(/^[a-z][a-z0-9_.:-]{1,49}$/, 'Use letras minúsculas, números e . _ : -');

const planLimits = {
  /** `null` = ilimitado. */
  maxActiveDraws: z.number().int().min(0).nullable(),
  maxTeamMembers: z.number().int().min(1).nullable(),
};

/** Como o plano aparece para quem escolhe (e para a comunidade que o contratou). */
export const planSchema = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  interval: z.enum(PLAN_INTERVALS),
  priceCents: z.number().int().min(0),
  currency: z.string().length(3),
  ...planLimits,
  features: z.array(featureKey).max(50),
  status: z.enum(PLAN_STATUSES),
});
export type Plan = z.infer<typeof planSchema>;

/** Visao do Super Admin: inclui os identificadores da Stripe. */
export const platformPlanSchema = planSchema.extend({
  stripeProductId: z.string().nullable(),
  stripePriceId: z.string().nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type PlatformPlan = z.infer<typeof platformPlanSchema>;

/**
 * Criar plano. O servidor cria o Product e o Price na Stripe; o preco daqui e o que
 * ele vai pedir la — nao existe caminho para editar preco so no banco.
 */
export const createPlanRequestSchema = z.object({
  code: z.string().regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/).min(3).max(40),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  interval: z.enum(PLAN_INTERVALS),
  priceCents: z.number().int().min(0),
  currency: z.string().length(3).toLowerCase().default('brl'),
  ...planLimits,
  features: z.array(featureKey).max(50).default([]),
});
export type CreatePlanRequest = z.input<typeof createPlanRequestSchema>;

/**
 * Editar plano. Preco, periodicidade e moeda NAO estao aqui de proposito: o Price da
 * Stripe e imutavel e o banco recusa a troca (`plans_price_immutable`). Preco novo =
 * plano novo.
 */
export const updatePlanRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).nullable(),
    ...planLimits,
    features: z.array(featureKey).max(50),
    status: z.enum(PLAN_STATUSES),
  })
  .partial();
export type UpdatePlanRequest = z.infer<typeof updatePlanRequestSchema>;

export const planListResponseSchema = z.object({ plans: z.array(planSchema) });
export type PlanListResponse = z.infer<typeof planListResponseSchema>;

export const platformPlanListResponseSchema = z.object({ plans: z.array(platformPlanSchema) });
export type PlatformPlanListResponse = z.infer<typeof platformPlanListResponseSchema>;

// ---------------------------------------------------------------------------
// Configuracao de cobranca (Super Admin)
// ---------------------------------------------------------------------------

export const billingSettingsSchema = z.object({
  pastDueGraceDays: z
    .number()
    .int()
    .min(PAST_DUE_GRACE_DAYS_RANGE.min)
    .max(PAST_DUE_GRACE_DAYS_RANGE.max),
  /** Enquanto falso, nenhum limite nem estado de assinatura barra operacao alguma. */
  enforcementEnabled: z.boolean(),
  updatedAt: isoDate,
});
export type BillingSettings = z.infer<typeof billingSettingsSchema>;

export const updateBillingSettingsRequestSchema = billingSettingsSchema
  .pick({ pastDueGraceDays: true, enforcementEnabled: true })
  .partial();
export type UpdateBillingSettingsRequest = z.infer<typeof updateBillingSettingsRequestSchema>;

// ---------------------------------------------------------------------------
// Assinatura da comunidade
// ---------------------------------------------------------------------------

export const subscriptionSchema = z.object({
  id: uuid,
  plan: planSchema,
  /** Estado bruto da Stripe. */
  status: z.enum(SUBSCRIPTION_STATUSES),
  currentPeriodStart: isoDate.nullable(),
  currentPeriodEnd: isoDate.nullable(),
  cancelAtPeriodEnd: z.boolean(),
  canceledAt: isoDate.nullable(),
  trialEnd: isoDate.nullable(),
  /** Desde quando esta em atraso. Ancora da tolerancia; nulo fora de `past_due`. */
  pastDueSince: isoDate.nullable(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

export const billingInvoiceSchema = z.object({
  id: uuid,
  status: z.enum(INVOICE_STATUSES),
  currency: z.string().length(3),
  amountDueCents: z.number().int().min(0),
  amountPaidCents: z.number().int().min(0),
  amountRemainingCents: z.number().int().min(0),
  attemptCount: z.number().int().min(0),
  periodStart: isoDate.nullable(),
  periodEnd: isoDate.nullable(),
  paidAt: isoDate.nullable(),
  /** Pagina de fatura da Stripe, quando existe. */
  hostedInvoiceUrl: z.string().url().nullable(),
  createdAt: isoDate,
});
export type BillingInvoice = z.infer<typeof billingInvoiceSchema>;

/** "Minha assinatura": o que a comunidade ve. */
export const mySubscriptionResponseSchema = z.object({
  state: z.enum(BILLING_STATES),
  subscription: subscriptionSchema.nullable(),
  invoices: z.array(billingInvoiceSchema),
  nextCursor: z.string().nullable(),
});
export type MySubscriptionResponse = z.infer<typeof mySubscriptionResponseSchema>;

/**
 * Limites do plano e consumo. `max*` nulo = ilimitado. Sem `enforcementEnabled` a
 * tela mostra o consumo mas nenhuma operacao e barrada.
 */
export const entitlementsResponseSchema = z.object({
  state: z.enum(BILLING_STATES),
  enforcementEnabled: z.boolean(),
  planCode: z.string().nullable(),
  features: z.array(featureKey),
  activeDraws: z.object({ used: z.number().int().min(0), max: z.number().int().min(0).nullable() }),
  teamMembers: z.object({ used: z.number().int().min(0), max: z.number().int().min(1).nullable() }),
  /** Ate quando dura a tolerancia de `past_due`; nulo fora desse estado. */
  graceEndsAt: isoDate.nullable(),
  canSubmitDraws: z.boolean(),
  reason: z.enum(ENTITLEMENT_REASONS),
});
export type EntitlementsResponse = z.infer<typeof entitlementsResponseSchema>;

/** Resultado de uma checagem de limite (o que as funcoes `check_*` devolvem). */
export const entitlementCheckSchema = z.object({
  allowed: z.boolean(),
  reason: z.enum(ENTITLEMENT_REASONS),
  used: z.number().int().min(0),
  maxAllowed: z.number().int().min(0).nullable(),
});
export type EntitlementCheck = z.infer<typeof entitlementCheckSchema>;

/**
 * O codigo de erro da API para um motivo de entitlement: a interface decide a tela pelo
 * codigo, nunca pelo texto.
 */
export function apiErrorCodeForEntitlement(reason: (typeof ENTITLEMENT_REASONS)[number]): ApiErrorCode {
  switch (reason) {
    case 'DRAW_LIMIT_REACHED':
    case 'MEMBER_LIMIT_REACHED':
      return 'PLAN_LIMIT_REACHED';
    case 'FEATURE_NOT_IN_PLAN':
      return 'FEATURE_NOT_IN_PLAN';
    case 'FORBIDDEN':
      return 'TENANT_ACCESS_DENIED';
    default:
      return 'SUBSCRIPTION_REQUIRED';
  }
}

// ---------------------------------------------------------------------------
// Contratacao e portal (Stripe)
// ---------------------------------------------------------------------------

/** So `planId`. Preco, Price ID e comunidade saem do servidor, nunca do navegador. */
export const createCheckoutSessionRequestSchema = z.object({ planId: uuid });
export type CreateCheckoutSessionRequest = z.infer<typeof createCheckoutSessionRequestSchema>;

/** Voltar da Stripe NAO libera nada: o estado vem do webhook. */
export const redirectResponseSchema = z.object({ url: z.string().url() });
export type RedirectResponse = z.infer<typeof redirectResponseSchema>;

// ---------------------------------------------------------------------------
// Console Super Admin: assinaturas e falhas
// ---------------------------------------------------------------------------

export const platformSubscriptionItemSchema = z.object({
  id: uuid,
  tenantId: uuid,
  tenantSlug: z.string(),
  tenantName: z.string(),
  planCode: z.string(),
  planName: z.string(),
  status: z.enum(SUBSCRIPTION_STATUSES),
  /** Leitura de negocio (ja com a tolerancia de `past_due` aplicada). */
  state: z.enum(BILLING_STATES),
  currentPeriodEnd: isoDate.nullable(),
  pastDueSince: isoDate.nullable(),
  /** Fim da tolerancia; nulo fora de `past_due`. */
  graceEndsAt: isoDate.nullable(),
  cancelAtPeriodEnd: z.boolean(),
});
export type PlatformSubscriptionItem = z.infer<typeof platformSubscriptionItemSchema>;

/**
 * Filtros da consulta de assinaturas (Super Admin): por estado de negocio e por comunidade
 * (nome ou slug). Somente leitura: o estado financeiro vem da Stripe.
 */
export const platformSubscriptionQuerySchema = z.object({
  state: z.enum(BILLING_STATES).optional(),
  q: z.string().trim().min(1).max(80).optional(),
});
export type PlatformSubscriptionQuery = z.infer<typeof platformSubscriptionQuerySchema>;

export const platformSubscriptionListResponseSchema = z.object({
  subscriptions: z.array(platformSubscriptionItemSchema),
  nextCursor: z.string().nullable(),
});
export type PlatformSubscriptionListResponse = z.infer<typeof platformSubscriptionListResponseSchema>;

/** Evento da Stripe que nao foi processado — fila de inspecao. Sem o payload cru. */
export const stripeEventFailureSchema = z.object({
  eventId: z.string(),
  eventType: z.string(),
  status: z.enum(STRIPE_EVENT_STATUSES),
  attempts: z.number().int().min(0),
  lastError: z.string().nullable(),
  receivedAt: isoDate,
});
export type StripeEventFailure = z.infer<typeof stripeEventFailureSchema>;

export const billingAdjustmentSchema = z.object({
  id: uuid,
  kind: z.enum(BILLING_ADJUSTMENT_KINDS),
  amountCents: z.number().int().min(0),
  currency: z.string().length(3),
  status: z.string(),
  reason: z.string().nullable(),
});
export type BillingAdjustment = z.infer<typeof billingAdjustmentSchema>;

// ---------------------------------------------------------------------------
// Recebimentos por comunidade (FLUXO B) · Mercado Pago por OAuth
// ---------------------------------------------------------------------------

/**
 * Como uma conta de recebimento aparece. NADA de credencial: nem access token, nem refresh
 * token, nem `code`, `state`, `code_verifier` ou segredo do cliente OAuth.
 */
export const paymentAccountSchema = z.object({
  id: uuid,
  provider: z.enum(PAYMENT_PROVIDERS),
  environment: z.enum(PAYMENT_ENVIRONMENTS),
  status: z.enum(PAYMENT_ACCOUNT_STATUSES),
  /** ID da conta do vendedor no provedor (nao e segredo). */
  providerAccountId: z.string(),
  /** Estado da autorizacao (compartilhada quando o mesmo vendedor serve varias comunidades). */
  authorizationStatus: z.enum(PAYMENT_AUTHORIZATION_STATUSES),
  tokenExpiresAt: isoDate.nullable(),
  lastVerifiedAt: isoDate.nullable(),
  /** Motivo curto da ultima falha, sem segredo. */
  lastError: z.string().nullable(),
  connectedAt: isoDate,
  disconnectRequestedAt: isoDate.nullable(),
  /** Esta conta aceita pagamentos NOVOS agora? */
  canReceivePayments: z.boolean(),
  /** Pagamentos que ainda dependem da credencial (uma desconexao espera por eles). */
  openObligations: z.number().int().min(0),
});
export type PaymentAccount = z.infer<typeof paymentAccountSchema>;

/**
 * "Recebimentos". `enabled` = o modulo esta configurado e autorizado neste ambiente. Falso
 * enquanto nao existir aplicacao OAuth cadastrada: a tela mostra a pendencia em vez de um
 * botao que nao funcionaria.
 */
export const paymentAccountsResponseSchema = z.object({
  enabled: z.boolean(),
  accounts: z.array(paymentAccountSchema),
  /** O checkout pago esta disponivel para esta comunidade? */
  checkoutAvailable: z.boolean(),
});
export type PaymentAccountsResponse = z.infer<typeof paymentAccountsResponseSchema>;

/**
 * Iniciar a conexao: so o provedor. O ambiente e decidido pelo servidor e nao existe campo
 * para token — a autorizacao e sempre a oficial do provedor (OAuth).
 */
export const connectPaymentAccountRequestSchema = z.object({
  provider: z.enum(PAYMENT_PROVIDERS),
});
export type ConnectPaymentAccountRequest = z.infer<typeof connectPaymentAccountRequestSchema>;
