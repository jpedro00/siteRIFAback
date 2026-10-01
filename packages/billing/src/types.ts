import type { InvoiceStatus, SubscriptionStatus } from '@clubedarifa/shared';

/**
 * Tipos NEUTROS da cobranca da plataforma. Nada aqui e do SDK da Stripe: o resto do
 * sistema fala com esta interface, e a Stripe fica atras de `StripeBillingGateway`.
 * Isso deixa o cliente INJETAVEL — os testes usam um gateway em memoria, sem rede.
 */

export interface SubscriptionSnapshot {
  readonly id: string;
  readonly customerId: string;
  /** Price do primeiro item. Nulo = assinatura sem item (anomalia). */
  readonly priceId: string | null;
  readonly status: SubscriptionStatus;
  readonly currentPeriodStart: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly cancelAt: Date | null;
  readonly canceledAt: Date | null;
  readonly trialEnd: Date | null;
}

export interface InvoiceSnapshot {
  readonly id: string;
  readonly customerId: string;
  readonly subscriptionId: string | null;
  readonly status: InvoiceStatus;
  readonly currency: string;
  readonly amountDueCents: number;
  readonly amountPaidCents: number;
  readonly amountRemainingCents: number;
  readonly attemptCount: number;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  readonly paidAt: Date | null;
  readonly hostedInvoiceUrl: string | null;
  readonly createdAt: Date | null;
}

/** O que sobra de um evento da Stripe depois de tirar TUDO que nao e necessario. */
export interface EventEnvelope {
  readonly id: string;
  readonly type: string;
  readonly livemode: boolean;
  /** Informativo. NUNCA ordena: dois eventos podem dividir o mesmo segundo. */
  readonly created: Date;
  readonly objectType: string | null;
  readonly objectId: string | null;
  readonly customerId: string | null;
  /**
   * Resumo MINIMO (ids e estado). Sem e-mail, nome, endereco nem cartao — e limitado a
   * 4 KB pelo banco. Serve para rotear e reprocessar; o estado verdadeiro sempre vem
   * de uma consulta a Stripe.
   */
  readonly summary: Readonly<Record<string, string | number | boolean | null>>;
}

export interface CreateCustomerInput {
  readonly tenantId: string;
  readonly tenantName: string;
  /** Chave de idempotencia da Stripe: repetir a chamada devolve o MESMO cliente. */
  readonly idempotencyKey: string;
}

export interface CreateCheckoutInput {
  readonly customerId: string;
  /** Price ID do PLANO NO BANCO. Nunca vem do navegador. */
  readonly priceId: string;
  readonly tenantId: string;
  readonly planId: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly expiresAt: Date;
  readonly idempotencyKey: string;
}

export interface CheckoutSession {
  readonly id: string;
  readonly url: string;
  readonly expiresAt: Date;
}

export interface CreateProductInput {
  readonly planId: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  /** Chave de idempotencia: repetir a chamada devolve o MESMO Product. */
  readonly idempotencyKey: string;
}

export interface CreatePriceInput {
  readonly productId: string;
  readonly planId: string;
  readonly unitAmountCents: number;
  readonly currency: string;
  readonly interval: 'month' | 'year';
  readonly idempotencyKey: string;
}

export interface BillingGateway {
  /** A chave e de teste ou de producao? Decide se eventos `livemode` sao aceitos. */
  readonly livemode: boolean;
  /** Catalogo (Super Admin): o preco so nasce aqui, vindo do servidor. */
  createProduct(input: CreateProductInput): Promise<{ id: string }>;
  createPrice(input: CreatePriceInput): Promise<{ id: string }>;
  createCustomer(input: CreateCustomerInput): Promise<{ id: string }>;
  createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutSession>;
  expireCheckoutSession(sessionId: string): Promise<void>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  retrieveSubscription(id: string): Promise<SubscriptionSnapshot>;
  retrieveInvoice(id: string): Promise<InvoiceSnapshot>;
  /**
   * Confere a ASSINATURA do webhook sobre o corpo BRUTO e devolve o envelope minimo.
   * Lanca `InvalidWebhookSignatureError` se o corpo nao foi assinado com o segredo.
   */
  verifyWebhook(input: { rawBody: Buffer; signature: string | undefined }): EventEnvelope;
}

export class InvalidWebhookSignatureError extends Error {
  constructor(message = 'Assinatura do webhook invalida.') {
    super(message);
    this.name = 'InvalidWebhookSignatureError';
  }
}

/** A Stripe (ou a rede) falhou. `transient` = vale tentar de novo. */
export class BillingGatewayError extends Error {
  readonly transient: boolean;
  constructor(message: string, transient: boolean, cause?: unknown) {
    super(message);
    this.name = 'BillingGatewayError';
    this.transient = transient;
    this.cause = cause;
  }
}
