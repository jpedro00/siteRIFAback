import Stripe from 'stripe';

/**
 * Verificacao do webhook Stripe Connect.
 *
 * A autenticidade vem da ASSINATURA (`Stripe-Signature`, HMAC sobre o CORPO BRUTO, com
 * tolerancia de tempo do SDK). Aceita mais de um segredo: a Stripe entrega os eventos das contas
 * conectadas (`account.updated`) e os da propria plataforma (o PaymentIntent de uma destination
 * charge) por endpoints diferentes, cada um com o seu `whsec_`.
 *
 * O evento devolvido e so um AVISO: nada dele e aplicado como verdade. Quem o consome rele o
 * estado na Stripe (RN06).
 */

export class InvalidConnectWebhookError extends Error {
  constructor() {
    // Mensagem fixa: o erro do SDK pode citar o cabecalho recebido.
    super('Assinatura do webhook Connect invalida.');
    this.name = 'InvalidConnectWebhookError';
  }
}

export interface ConnectWebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly livemode: boolean;
  /** Conta conectada de onde veio o evento; nulo nos eventos da propria plataforma. */
  readonly account: string | null;
  /** `data.object` do evento (so para ROTEAR: ids). */
  readonly object: Readonly<Record<string, unknown>>;
}

const ACCOUNT_ID = /^acct_[A-Za-z0-9]{1,64}$/;
const EVENT_ID = /^evt_[A-Za-z0-9_]{1,255}$/;

export function verifyConnectWebhook(
  rawBody: Buffer,
  signature: string | undefined,
  secrets: readonly string[],
): ConnectWebhookEvent {
  if (!signature || secrets.length === 0) throw new InvalidConnectWebhookError();

  let event: Stripe.Event | null = null;
  for (const secret of secrets) {
    try {
      event = Stripe.webhooks.constructEvent(rawBody, signature, secret);
      break;
    } catch {
      // tenta o proximo segredo
    }
  }
  if (!event || typeof event.id !== 'string' || !EVENT_ID.test(event.id) || typeof event.type !== 'string') {
    throw new InvalidConnectWebhookError();
  }

  const account = typeof event.account === 'string' && ACCOUNT_ID.test(event.account) ? event.account : null;
  const object = event.data?.object;
  return {
    id: event.id,
    type: event.type,
    livemode: event.livemode === true,
    account,
    object: typeof object === 'object' && object !== null ? (object as unknown as Record<string, unknown>) : {},
  };
}
