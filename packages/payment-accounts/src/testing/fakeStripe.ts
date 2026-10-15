import Stripe from 'stripe';

function unique(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Stripe FALSA em memoria: so o que o runtime Connect e o `StripeConnectGateway` usam. Registra
 * cada chamada e honra `idempotencyKey` como a Stripe. Nenhuma chave real passa por aqui.
 */

interface FakeAccount {
  charges_enabled: boolean;
  payouts_enabled: boolean;
  requirements: { currently_due: string[]; past_due: string[] };
}

/** Segredo de webhook OBVIAMENTE falso, so para os testes. */
export const FAKE_CONNECT_WEBHOOK_SECRET = 'whsec_test_fake_for_unit_tests';

export class FakeStripe {
  readonly intents: { params: Record<string, unknown>; opts: Record<string, unknown> | undefined }[] = [];
  readonly accountsById = new Map<string, FakeAccount>();
  /** Cada `paymentIntents.retrieve` (o RN06: o webhook so dispara a CONSULTA). */
  readonly retrieved: string[] = [];
  readonly #intentByKey = new Map<string, Record<string, unknown>>();
  readonly #intentById = new Map<string, Record<string, unknown>>();
  #n = 0;

  readonly accounts = {
    create: async (_params: Record<string, unknown>, _opts?: Record<string, unknown>) => {
      const id = `acct_${unique('f').replace(/[^A-Za-z0-9]/g, '')}`;
      this.accountsById.set(id, {
        charges_enabled: false,
        payouts_enabled: false,
        requirements: { currently_due: ['external_account'], past_due: [] },
      });
      return { id, object: 'account' };
    },
    retrieve: async (id: string) => {
      const a = this.accountsById.get(id);
      if (!a) throw Object.assign(new Error('No such account'), { type: 'StripeInvalidRequestError', statusCode: 404 });
      return { id, object: 'account', ...a };
    },
  };

  readonly accountLinks = {
    create: async (params: Record<string, unknown>) => ({
      object: 'account_link',
      url: `https://connect.stripe.test/setup/${String(params['account'])}/${++this.#n}`,
    }),
  };

  /** A proxima criacao de PaymentIntent falha com este erro (uma vez). */
  failNextCreate: Error | null = null;
  /** A proxima consulta de PaymentIntent falha com este erro (uma vez). */
  failNextRetrieve: Error | null = null;
  /** A proxima consulta DESTE PaymentIntent falha com o erro (uma vez), sem afetar os outros. */
  readonly failNextRetrieveOf = new Map<string, Error>();
  readonly #paramsByKey = new Map<string, string>();

  readonly paymentIntents = {
    create: async (params: Record<string, unknown>, opts?: Record<string, unknown>) => {
      this.intents.push({ params, opts });
      if (this.failNextCreate) {
        const e = this.failNextCreate;
        this.failNextCreate = null;
        throw e;
      }
      const key = opts?.['idempotencyKey'];
      if (typeof key === 'string' && this.#intentByKey.has(key)) {
        // Como a Stripe: mesma chave com parametros DIFERENTES e erro de idempotencia.
        if (this.#paramsByKey.get(key) !== JSON.stringify(params)) {
          throw Object.assign(new Error('Keys for idempotent requests can only be used with the same parameters'), {
            type: 'StripeIdempotencyError',
            statusCode: 400,
          });
        }
        return this.#intentByKey.get(key)!;
      }
      if (typeof key === 'string') this.#paramsByKey.set(key, JSON.stringify(params));
      const intent: Record<string, unknown> = {
        id: `pi_${unique('t').replace(/[^A-Za-z0-9]/g, '')}`,
        object: 'payment_intent',
        status: 'requires_action',
        amount: params['amount'],
        created: Math.floor(Date.now() / 1000),
        metadata: params['metadata'],
        transfer_data: params['transfer_data'],
        next_action: {
          pix_display_qr_code: {
            data: `00020126PIXSTRIPE${++this.#n}`,
            expires_at: Math.floor(Date.now() / 1000) + 600,
          },
        },
      };
      if (typeof key === 'string') this.#intentByKey.set(key, intent);
      this.#intentById.set(intent['id'] as string, intent);
      return intent;
    },
    retrieve: async (id: string, _opts?: Record<string, unknown>) => {
      this.retrieved.push(id);
      if (this.failNextRetrieve) {
        const e = this.failNextRetrieve;
        this.failNextRetrieve = null;
        throw e;
      }
      const alvo = this.failNextRetrieveOf.get(id);
      if (alvo) {
        this.failNextRetrieveOf.delete(id);
        throw alvo;
      }
      const intent = this.#intentById.get(id);
      if (!intent) {
        throw Object.assign(new Error('No such payment_intent'), { type: 'StripeInvalidRequestError', statusCode: 404 });
      }
      return { ...intent };
    },
  };

  /** O criador termina o cadastro na Stripe. */
  ready(acct: string): void {
    const a = this.accountsById.get(acct)!;
    a.charges_enabled = true;
    a.payouts_enabled = true;
    a.requirements = { currently_due: [], past_due: [] };
  }

  /** O comprador paga (ou nao): muda o estado do PaymentIntent NA STRIPE. */
  setIntentStatus(id: string, status: string): void {
    const intent = this.#intentById.get(id)!;
    intent['status'] = status;
  }

  /** Simula um PaymentIntent cujo destino NAO e a conta do pagamento (id trocado). */
  setIntentDestination(id: string, destination: string): void {
    this.#intentById.get(id)!['transfer_data'] = { destination };
  }

  asClient(): Stripe {
    return this as unknown as Stripe;
  }
}

/** Corpo bruto + `Stripe-Signature` validos para `secret`, como a Stripe envia. */
export function signedConnectEvent(
  event: { id: string; type: string; object: Record<string, unknown>; account?: string; livemode?: boolean },
  secret = FAKE_CONNECT_WEBHOOK_SECRET,
): { rawBody: string; signature: string } {
  const payload = JSON.stringify({
    id: event.id,
    object: 'event',
    api_version: '2026-08-26.dahlia',
    created: Math.floor(Date.now() / 1000),
    livemode: event.livemode ?? false,
    type: event.type,
    ...(event.account ? { account: event.account } : {}),
    data: { object: event.object },
  });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  return { rawBody: payload, signature };
}
