import Stripe from 'stripe';
import { INVOICE_STATUSES, SUBSCRIPTION_STATUSES } from '@clubedarifa/shared';
import { toEnvelope } from './envelope.js';
import {
  BillingGatewayError,
  InvalidWebhookSignatureError,
  type BillingGateway,
  type CheckoutSession,
  type CreateCheckoutInput,
  type CreateCustomerInput,
  type CreatePriceInput,
  type CreateProductInput,
  type EventEnvelope,
  type InvoiceSnapshot,
  type SubscriptionSnapshot,
} from './types.js';

/**
 * Gateway da Stripe. E o UNICO arquivo que conhece o SDK.
 *
 * - `client` e injetavel: por padrao cria `new Stripe(secretKey)`; um teste pode passar
 *   qualquer objeto com o mesmo formato.
 * - Nenhuma chamada carrega valor monetario: o preco vai como `price` (ID), resolvido
 *   pelo servidor a partir do plano gravado no banco.
 * - Chave `live` so e aceita com `allowLive` (a configuracao so o liga em producao).
 */
export interface StripeGatewayOptions {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly allowLive?: boolean;
  /** Para testes: substitui o SDK. */
  readonly client?: Stripe;
}

const REQUEST_TIMEOUT_MS = 10_000;

export function isLiveKey(secretKey: string): boolean {
  return secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_');
}

const secs = (n: unknown): Date | null => (typeof n === 'number' ? new Date(n * 1000) : null);

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function idOf(v: unknown): string | null {
  if (typeof v === 'string') return v === '' ? null : v;
  const id = asRecord(v)['id'];
  return typeof id === 'string' && id !== '' ? id : null;
}

/** Rede fora, limite de taxa e 5xx = tentar de novo; o resto (4xx) e definitivo. */
function classify(error: unknown): BillingGatewayError {
  if (error instanceof BillingGatewayError) return error;
  const e = asRecord(error);
  const type = String(e['type'] ?? '');
  const status = typeof e['statusCode'] === 'number' ? (e['statusCode'] as number) : 0;
  const transient =
    type === 'StripeConnectionError' ||
    type === 'StripeRateLimitError' ||
    type === 'StripeAPIError' ||
    status === 429 ||
    status >= 500;
  // A mensagem da Stripe nao carrega segredo; ainda assim vai truncada.
  const message = error instanceof Error ? error.message.slice(0, 300) : 'Falha na Stripe.';
  return new BillingGatewayError(message, transient, error);
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw classify(error);
  }
}

export class StripeBillingGateway implements BillingGateway {
  readonly livemode: boolean;
  readonly #stripe: Stripe;
  readonly #webhookSecret: string;

  constructor(options: StripeGatewayOptions) {
    const live = isLiveKey(options.secretKey);
    if (live && options.allowLive !== true) {
      throw new Error('Chave LIVE da Stripe recusada fora de producao.');
    }
    this.livemode = live;
    this.#webhookSecret = options.webhookSecret;
    this.#stripe =
      options.client ??
      new Stripe(options.secretKey, { timeout: REQUEST_TIMEOUT_MS, maxNetworkRetries: 2 });
  }

  createProduct(input: CreateProductInput): Promise<{ id: string }> {
    return call(async () => {
      const product = await this.#stripe.products.create(
        {
          name: input.name,
          ...(input.description ? { description: input.description } : {}),
          metadata: { planId: input.planId, planCode: input.code },
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return { id: product.id };
    });
  }

  createPrice(input: CreatePriceInput): Promise<{ id: string }> {
    return call(async () => {
      const price = await this.#stripe.prices.create(
        {
          product: input.productId,
          unit_amount: input.unitAmountCents,
          currency: input.currency,
          recurring: { interval: input.interval },
          metadata: { planId: input.planId },
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return { id: price.id };
    });
  }

  createCustomer(input: CreateCustomerInput): Promise<{ id: string }> {
    return call(async () => {
      const customer = await this.#stripe.customers.create(
        { name: input.tenantName, metadata: { tenantId: input.tenantId } },
        { idempotencyKey: input.idempotencyKey },
      );
      return { id: customer.id };
    });
  }

  createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutSession> {
    return call(async () => {
      const session = await this.#stripe.checkout.sessions.create(
        {
          mode: 'subscription',
          customer: input.customerId,
          line_items: [{ price: input.priceId, quantity: 1 }],
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          client_reference_id: input.tenantId,
          metadata: { tenantId: input.tenantId, planId: input.planId },
          subscription_data: { metadata: { tenantId: input.tenantId, planId: input.planId } },
          expires_at: Math.floor(input.expiresAt.getTime() / 1000),
        },
        { idempotencyKey: input.idempotencyKey },
      );
      if (!session.url) {
        throw new BillingGatewayError('A Stripe nao devolveu a URL do Checkout.', false);
      }
      return { id: session.id, url: session.url, expiresAt: secs(session.expires_at) ?? input.expiresAt };
    });
  }

  expireCheckoutSession(sessionId: string): Promise<void> {
    return call(async () => {
      await this.#stripe.checkout.sessions.expire(sessionId);
    });
  }

  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    return call(async () => {
      const session = await this.#stripe.billingPortal.sessions.create({
        customer: input.customerId,
        return_url: input.returnUrl,
      });
      return { url: session.url };
    });
  }

  retrieveSubscription(id: string): Promise<SubscriptionSnapshot> {
    return call(async () => {
      const sub = asRecord(await this.#stripe.subscriptions.retrieve(id));
      const data = asRecord(sub['items'])['data'];
      const first = Array.isArray(data) ? asRecord(data[0]) : {};
      // Na API mais nova o periodo mora no ITEM; nas antigas, na assinatura.
      const start = first['current_period_start'] ?? sub['current_period_start'];
      const end = first['current_period_end'] ?? sub['current_period_end'];
      const status = String(sub['status']);
      if (!(SUBSCRIPTION_STATUSES as readonly string[]).includes(status)) {
        throw new BillingGatewayError(`Estado de assinatura desconhecido: ${status}`, false);
      }
      return {
        id: String(sub['id']),
        customerId: idOf(sub['customer']) ?? '',
        priceId: idOf(first['price']),
        status: status as SubscriptionSnapshot['status'],
        currentPeriodStart: secs(start),
        currentPeriodEnd: secs(end),
        cancelAtPeriodEnd: sub['cancel_at_period_end'] === true,
        cancelAt: secs(sub['cancel_at']),
        canceledAt: secs(sub['canceled_at']),
        trialEnd: secs(sub['trial_end']),
      };
    });
  }

  retrieveInvoice(id: string): Promise<InvoiceSnapshot> {
    return call(async () => {
      const inv = asRecord(await this.#stripe.invoices.retrieve(id));
      const status = String(inv['status']);
      if (!(INVOICE_STATUSES as readonly string[]).includes(status)) {
        throw new BillingGatewayError(`Estado de fatura desconhecido: ${status}`, false);
      }
      // Na API mais nova a assinatura vem em `parent.subscription_details`.
      const parent = asRecord(asRecord(inv['parent'])['subscription_details']);
      const transitions = asRecord(inv['status_transitions']);
      return {
        id: String(inv['id']),
        customerId: idOf(inv['customer']) ?? '',
        subscriptionId: idOf(parent['subscription']) ?? idOf(inv['subscription']),
        status: status as InvoiceSnapshot['status'],
        currency: String(inv['currency'] ?? 'brl'),
        amountDueCents: Number(inv['amount_due'] ?? 0),
        amountPaidCents: Number(inv['amount_paid'] ?? 0),
        amountRemainingCents: Number(inv['amount_remaining'] ?? 0),
        attemptCount: Number(inv['attempt_count'] ?? 0),
        periodStart: secs(inv['period_start']),
        periodEnd: secs(inv['period_end']),
        paidAt: secs(transitions['paid_at']),
        hostedInvoiceUrl: typeof inv['hosted_invoice_url'] === 'string' ? inv['hosted_invoice_url'] : null,
        createdAt: secs(inv['created']),
      };
    });
  }

  verifyWebhook(input: { rawBody: Buffer; signature: string | undefined }): EventEnvelope {
    if (!input.signature) {
      throw new InvalidWebhookSignatureError('Cabecalho Stripe-Signature ausente.');
    }
    let event: Stripe.Event;
    try {
      // Confere HMAC e tolerancia de tempo (5 min) sobre o corpo BRUTO.
      event = this.#stripe.webhooks.constructEvent(input.rawBody, input.signature, this.#webhookSecret);
    } catch (error) {
      throw new InvalidWebhookSignatureError(
        error instanceof Error ? error.message.slice(0, 200) : 'Assinatura invalida.',
      );
    }
    const envelope = toEnvelope(event);
    // Evento de producao numa instalacao de teste (ou o inverso) nunca e processado.
    if (envelope.livemode !== this.livemode) {
      throw new InvalidWebhookSignatureError('Modo do evento (live/test) diferente do da chave.');
    }
    return envelope;
  }
}
