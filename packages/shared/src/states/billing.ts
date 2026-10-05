/**
 * Vocabularios da cobranca da PLATAFORMA (assinaturas SaaS) e dos recebimentos por
 * comunidade. Fase 7, migrations 0018 e 0019.
 *
 * Cada lista abaixo e o espelho de um tipo do banco, e um teste
 * (`packages/db/tests/billing-foundation.test.ts`) compara os dois — o mesmo
 * criterio de `draw_status`: nenhum vocabulario evolui sozinho em um dos lados.
 */

/** Estados da assinatura. Sao EXATAMENTE os da Stripe. */
export const SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * Estados em que a assinatura conta como VIVA (no maximo uma por comunidade).
 * `incomplete` fica de fora: a Stripe a expira sozinha e um Checkout abandonado nao
 * pode trancar a comunidade.
 */
export const LIVE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = Object.freeze([
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'paused',
]);

export const INVOICE_STATUSES = ['draft', 'open', 'paid', 'void', 'uncollectible'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PLAN_STATUSES = ['DRAFT', 'AVAILABLE', 'ARCHIVED'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_INTERVALS = ['month', 'year'] as const;
export type PlanInterval = (typeof PLAN_INTERVALS)[number];

/**
 * Ciclo de um evento do webhook: RECEIVED -> PROCESSING (lease) -> PROCESSED | IGNORED;
 * falha volta a FAILED (retry com recuo) e, esgotadas as tentativas ou em anomalia
 * de seguranca, DEAD (inspecao humana).
 */
export const STRIPE_EVENT_STATUSES = [
  'RECEIVED',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
  'IGNORED',
  'DEAD',
] as const;
export type StripeEventStatus = (typeof STRIPE_EVENT_STATUSES)[number];

export const BILLING_ADJUSTMENT_KINDS = ['REFUND', 'DISPUTE'] as const;
export type BillingAdjustmentKind = (typeof BILLING_ADJUSTMENT_KINDS)[number];

/**
 * O estado de cobranca da COMUNIDADE, como `app.tenant_billing_state` o devolve.
 * E a leitura de negocio da assinatura, ja com a tolerancia de `past_due` aplicada.
 */
export const BILLING_STATES = [
  'NO_SUBSCRIPTION',
  'PENDING',
  'TRIALING',
  'ACTIVE',
  'PAST_DUE_GRACE',
  'PAST_DUE_BLOCKED',
  'UNPAID',
  'PAUSED',
  'CANCELED',
] as const;
export type BillingState = (typeof BILLING_STATES)[number];

/** Estados em que a comunidade pode ENVIAR novos sorteios para revisao. */
export const BILLING_STATES_THAT_MAY_SUBMIT_DRAWS: readonly BillingState[] = Object.freeze([
  'ACTIVE',
  'TRIALING',
  'PAST_DUE_GRACE',
]);

/**
 * Sorteios que OCUPAM a franquia do plano. Rascunho nao consome: criar e editar
 * rascunho e livre; a checagem acontece no envio para revisao.
 */
export const DRAW_STATUSES_THAT_USE_PLAN_SLOT = Object.freeze([
  'REVISÃO COMPLIANCE',
  'AGENDADA',
  'ATIVA',
  'PAUSADA',
] as const);

/** Motivos que `check_draw_submission` / `check_team_member_addition` devolvem. */
export const ENTITLEMENT_REASONS = [
  'OK',
  'ENFORCEMENT_OFF',
  'FORBIDDEN',
  'NO_PLAN',
  'DRAW_LIMIT_REACHED',
  'MEMBER_LIMIT_REACHED',
  /** Funcionalidade fora do plano contratado. */
  'FEATURE_NOT_IN_PLAN',
  'SUBSCRIPTION_NO_SUBSCRIPTION',
  'SUBSCRIPTION_PENDING',
  'SUBSCRIPTION_PAST_DUE_BLOCKED',
  'SUBSCRIPTION_UNPAID',
  'SUBSCRIPTION_PAUSED',
  'SUBSCRIPTION_CANCELED',
] as const;
export type EntitlementReason = (typeof ENTITLEMENT_REASONS)[number];

/**
 * Mensagem para a pessoa, por motivo. So diz o que a comunidade precisa saber: nada de
 * detalhe da Stripe nem de informacao financeira de outra comunidade.
 */
export const ENTITLEMENT_REASON_MESSAGES: Readonly<Record<EntitlementReason, string>> = Object.freeze({
  OK: 'Permitido.',
  ENFORCEMENT_OFF: 'Permitido.',
  FORBIDDEN: 'Você não tem acesso a esta comunidade.',
  NO_PLAN: 'A comunidade não tem um plano vigente.',
  DRAW_LIMIT_REACHED: 'Sua comunidade atingiu o limite de sorteios ativos do plano. Conclua um sorteio ou contrate um plano maior.',
  MEMBER_LIMIT_REACHED: 'Sua comunidade atingiu o limite de membros da equipe do plano.',
  SUBSCRIPTION_NO_SUBSCRIPTION: 'Sua comunidade ainda não tem uma assinatura. Contrate um plano para enviar sorteios para revisão.',
  SUBSCRIPTION_PENDING: 'A contratação do plano ainda não foi confirmada. Assim que o pagamento for confirmado, o envio será liberado.',
  SUBSCRIPTION_PAST_DUE_BLOCKED: 'O pagamento da assinatura está em atraso. Regularize para enviar novos sorteios para revisão.',
  SUBSCRIPTION_UNPAID: 'A assinatura está sem pagamento. Regularize para enviar novos sorteios para revisão.',
  SUBSCRIPTION_PAUSED: 'A assinatura está pausada. Retome-a para enviar novos sorteios para revisão.',
  SUBSCRIPTION_CANCELED: 'A assinatura foi cancelada. Contrate um plano para enviar novos sorteios para revisão.',
  FEATURE_NOT_IN_PLAN: 'Esta funcionalidade não está incluída no plano da comunidade.',
});

/**
 * Funcionalidades que um plano pode habilitar. HOJE NENHUMA existe: o catalogo esta vazio
 * de proposito — nao se inventa funcionalidade comercial antes de ela existir. Quando uma
 * for criada, entra aqui (e o servidor a verifica em `tenant_feature_verdict`).
 */
export const PLAN_FEATURES: readonly string[] = Object.freeze([]);

// ---------------------------------------------------------------------------
// Recebimentos por comunidade (FLUXO B)
// ---------------------------------------------------------------------------

/** Provedores de recebimento. Cresce por migration; hoje so o Mercado Pago. */
export const PAYMENT_PROVIDERS = ['MERCADO_PAGO'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

export const PAYMENT_ENVIRONMENTS = ['SANDBOX', 'PRODUCTION'] as const;
export type PaymentEnvironment = (typeof PAYMENT_ENVIRONMENTS)[number];

/**
 * Estado do VINCULO de uma comunidade com uma conta de recebimento (migration 0019).
 *  CONNECTED     recebe pagamentos novos.
 *  DISCONNECTING nada novo; a credencial fica so para resolver o que ja existe (consulta,
 *                conciliacao, devolucao) e a conexao conclui quando nada mais pende.
 *  DISCONNECTED  encerrada.
 *  REVOKED       a autorizacao caiu (o vendedor revogou). ERROR: falha na renovacao.
 */
export const PAYMENT_ACCOUNT_STATUSES = [
  'CONNECTED',
  'DISCONNECTING',
  'DISCONNECTED',
  'REVOKED',
  'ERROR',
] as const;
export type PaymentAccountStatus = (typeof PAYMENT_ACCOUNT_STATUSES)[number];

/** Estado da AUTORIZACAO do provedor (a fonte das credenciais, compartilhada entre comunidades). */
export const PAYMENT_AUTHORIZATION_STATUSES = ['ACTIVE', 'EXPIRED', 'REVOKED', 'ERROR'] as const;
export type PaymentAuthorizationStatus = (typeof PAYMENT_AUTHORIZATION_STATUSES)[number];
