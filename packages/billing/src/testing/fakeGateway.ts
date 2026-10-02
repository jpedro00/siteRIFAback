import Stripe from 'stripe';

/**
 * Cliente Stripe EM MEMORIA, so para testes. Nunca e importado pela API nem pelo
 * worker em producao: vive em `@clubedarifa/billing/testing`.
 *
 * Ele implementa so os metodos que o `StripeBillingGateway` chama, com o formato de
 * resposta da Stripe — assim o teste exercita o gateway REAL (mapeamento, periodos no
 * item, assinatura do webhook) sem rede. A verificacao de assinatura do webhook e a do
 * SDK de verdade (`stripe.webhooks`), nao uma imitacao.
 */

export interface FakeStripeState {
  customers: Map<string, { id: string; name: string; tenantId: string }>;
  products: Map<string, { id: string; name: string; params: Record<string, unknown> }>;
  prices: Map<string, { id: string; product: string; unitAmount: number; currency: string; interval: string }>;
  sessions: Map<string, { id: string; url: string; status: 'open' | 'expired' | 'complete'; params: Record<string, unknown> }>;
  subscriptions: Map<string, Record<string, unknown>>;
  invoices: Map<string, Record<string, unknown>>;
  idempotency: Map<string, unknown>;
  calls: string[];
}

export interface FakeFailure {
  type: string;
  statusCode?: number;
  message: string;
}

type Options = { idempotencyKey?: string } | undefined;

function notFound(what: string, id: string): Error {
  const error = new Error(`No such ${what}: ${id}`) as Error & { type: string; statusCode: number };
  error.type = 'StripeInvalidRequestError';
  error.statusCode = 404;
  return error;
}

export class FakeStripeClient {
  readonly state: FakeStripeState = {
    customers: new Map(),
    products: new Map(),
    prices: new Map(),
    sessions: new Map(),
    subscriptions: new Map(),
    invoices: new Map(),
    idempotency: new Map(),
    calls: [],
  };
  readonly #failures = new Map<string, FakeFailure[]>();
  #seq = 0;
  /** Espera artificial (ms) por metodo, para intercalar processamentos nos testes. */
  readonly delays = new Map<string, number>();

  /** Verificacao de assinatura REAL do SDK (nao usa a rede). */
  readonly webhooks: Stripe['webhooks'];

  constructor() {
    this.webhooks = new Stripe('sk_test_fake_for_webhooks').webhooks;
  }

  /** Zera tudo entre um teste e outro, mantendo a MESMA instancia (o gateway a referencia). */
  reset(): void {
    this.state.customers.clear();
    this.state.products.clear();
    this.state.prices.clear();
    this.state.sessions.clear();
    this.state.subscriptions.clear();
    this.state.invoices.clear();
    this.state.idempotency.clear();
    this.state.calls.length = 0;
    this.#failures.clear();
    this.delays.clear();
    this.afterReadDelays.clear();
  }

  /** Programa uma falha para as PROXIMAS `times` chamadas de `method`. */
  failNext(method: string, failure: FakeFailure, times = 1): void {
    this.#failures.set(method, Array.from({ length: times }, () => failure));
  }

  callsTo(method: string): number {
    return this.state.calls.filter((c) => c === method).length;
  }

  async #enter(method: string): Promise<void> {
    this.state.calls.push(method);
    const wait = this.delays.get(method);
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    const failure = this.#failures.get(method)?.shift();
    if (failure) {
      const error = new Error(failure.message) as Error & { type: string; statusCode?: number };
      error.type = failure.type;
      if (failure.statusCode !== undefined) error.statusCode = failure.statusCode;
      throw error;
    }
  }

  #id(prefix: string): string {
    this.#seq += 1;
    return `${prefix}_fake${String(this.#seq).padStart(6, '0')}${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Reproduz a semantica da Stripe: mesma chave de idempotencia = mesmo objeto. */
  #idempotent<T>(options: Options, make: () => T): T {
    const key = options?.idempotencyKey;
    if (key !== undefined && this.state.idempotency.has(key)) return this.state.idempotency.get(key) as T;
    const created = make();
    if (key !== undefined) this.state.idempotency.set(key, created);
    return created;
  }

  readonly customers = {
    create: async (params: { name: string; metadata: { tenantId: string } }, options?: Options) => {
      await this.#enter('customers.create');
      return this.#idempotent(options, () => {
        const id = this.#id('cus');
        this.state.customers.set(id, { id, name: params.name, tenantId: params.metadata.tenantId });
        return { id };
      });
    },
  };

  readonly products = {
    create: async (params: Record<string, unknown> & { name: string }, options?: Options) => {
      await this.#enter('products.create');
      return this.#idempotent(options, () => {
        const id = this.#id('prod');
        this.state.products.set(id, { id, name: params.name, params });
        return { id };
      });
    },
  };

  readonly prices = {
    create: async (
      params: { product: string; unit_amount: number; currency: string; recurring: { interval: string } },
      options?: Options,
    ) => {
      await this.#enter('prices.create');
      return this.#idempotent(options, () => {
        const id = this.#id('price');
        this.state.prices.set(id, {
          id,
          product: params.product,
          unitAmount: params.unit_amount,
          currency: params.currency,
          interval: params.recurring.interval,
        });
        return { id };
      });
    },
  };

  readonly checkout = {
    sessions: {
      create: async (params: Record<string, unknown>, options?: Options) => {
        await this.#enter('checkout.sessions.create');
        return this.#idempotent(options, () => {
          const id = this.#id('cs_test');
          const url = `https://checkout.stripe.test/c/pay/${id}`;
          this.state.sessions.set(id, { id, url, status: 'open', params });
          return { id, url, expires_at: params['expires_at'] as number };
        });
      },
      expire: async (id: string) => {
        await this.#enter('checkout.sessions.expire');
        const session = this.state.sessions.get(id);
        if (session) session.status = 'expired';
        return { id };
      },
    },
  };

  readonly billingPortal = {
    sessions: {
      create: async (params: { customer: string; return_url: string }) => {
        await this.#enter('billingPortal.sessions.create');
        return { url: `https://billing.stripe.test/p/session/${params.customer}` };
      },
    },
  };

  /**
   * Espera DEPOIS de ler o estado: a resposta chega atrasada, ja "velha" quando o
   * chamador a recebe. Reproduz um processamento lento que tem em maos um estado
   * anterior enquanto a Stripe ja mudou.
   */
  readonly afterReadDelays = new Map<string, number>();

  readonly subscriptions = {
    retrieve: async (id: string) => {
      await this.#enter('subscriptions.retrieve');
      const sub = this.state.subscriptions.get(id);
      if (!sub) throw notFound('subscription', id);
      const snapshot = structuredClone(sub);
      const wait = this.afterReadDelays.get('subscriptions.retrieve');
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      return snapshot;
    },
  };

  readonly invoices = {
    retrieve: async (id: string) => {
      await this.#enter('invoices.retrieve');
      const invoice = this.state.invoices.get(id);
      if (!invoice) throw notFound('invoice', id);
      return invoice;
    },
  };

  // -------------------------------------------------------------------------
  // Semeadura do "lado Stripe" (o que a Stripe teria depois de um pagamento)
  // -------------------------------------------------------------------------

  /** Assinatura no formato da API nova: periodo no ITEM. */
  putSubscription(input: {
    id: string;
    customer: string;
    priceId: string;
    status: string;
    periodStart?: number;
    periodEnd?: number;
    cancelAtPeriodEnd?: boolean;
    canceledAt?: number | null;
  }): void {
    const now = Math.floor(Date.now() / 1000);
    this.state.subscriptions.set(input.id, {
      id: input.id,
      object: 'subscription',
      customer: input.customer,
      status: input.status,
      cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
      cancel_at: null,
      canceled_at: input.canceledAt ?? null,
      trial_end: null,
      items: {
        data: [
          {
            price: { id: input.priceId },
            current_period_start: input.periodStart ?? now,
            current_period_end: input.periodEnd ?? now + 30 * 86400,
          },
        ],
      },
    });
  }

  /** Fatura no formato da API nova: assinatura em `parent.subscription_details`. */
  putInvoice(input: {
    id: string;
    customer: string;
    subscriptionId: string | null;
    status: string;
    amountDue?: number;
    amountPaid?: number;
    attemptCount?: number;
  }): void {
    const now = Math.floor(Date.now() / 1000);
    const due = input.amountDue ?? 1000;
    const paid = input.amountPaid ?? (input.status === 'paid' ? due : 0);
    this.state.invoices.set(input.id, {
      id: input.id,
      object: 'invoice',
      customer: input.customer,
      status: input.status,
      currency: 'brl',
      amount_due: due,
      amount_paid: paid,
      amount_remaining: due - paid,
      attempt_count: input.attemptCount ?? 1,
      period_start: now,
      period_end: now + 30 * 86400,
      created: now,
      hosted_invoice_url: `https://invoice.stripe.test/i/${input.id}`,
      status_transitions: { paid_at: input.status === 'paid' ? now : null },
      parent: input.subscriptionId ? { subscription_details: { subscription: input.subscriptionId } } : null,
    });
  }

  // -------------------------------------------------------------------------
  // Webhooks assinados
  // -------------------------------------------------------------------------

  /** Corpo bruto + cabecalho `Stripe-Signature` validos para `secret`. */
  signedWebhook(
    event: { id: string; type: string; object: Record<string, unknown>; livemode?: boolean; created?: number },
    secret: string,
  ): { rawBody: Buffer; signature: string } {
    const payload = JSON.stringify({
      id: event.id,
      object: 'event',
      api_version: '2026-08-26.dahlia',
      created: event.created ?? Math.floor(Date.now() / 1000),
      livemode: event.livemode ?? false,
      type: event.type,
      data: { object: event.object },
    });
    const signature = this.webhooks.generateTestHeaderString({ payload, secret });
    return { rawBody: Buffer.from(payload), signature };
  }
}
