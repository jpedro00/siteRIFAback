import type { EventEnvelope } from './types.js';

/**
 * Reduz um evento da Stripe ao MINIMO necessario para rotear e reprocessar.
 *
 * E uma LISTA BRANCA, nao um filtro do que remover: o que nao esta aqui nao e
 * guardado. Ninguem "esquece" de tirar o e-mail do cliente porque ele nunca entra.
 * O evento cru da Stripe (com nome, e-mail, endereco, cartao mascarado) nao e gravado
 * em lugar nenhum.
 */

interface RawEventLike {
  readonly id: string;
  readonly type: string;
  readonly livemode: boolean;
  readonly created: number;
  readonly data: { readonly object: unknown };
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** `customer` vem como id (string) ou como objeto expandido. */
function idOf(v: unknown): string | null {
  if (typeof v === 'string') return v === '' ? null : v;
  return str(asRecord(v)['id']);
}

export function toEnvelope(event: RawEventLike): EventEnvelope {
  const obj = asRecord(event.data.object);
  const kind = str(obj['object']);
  const base = {
    id: event.id,
    type: event.type,
    livemode: event.livemode === true,
    created: new Date(event.created * 1000),
    objectType: kind,
    objectId: str(obj['id']),
    customerId: idOf(obj['customer']),
  };

  switch (kind) {
    case 'checkout.session':
      return {
        ...base,
        summary: {
          subscriptionId: idOf(obj['subscription']),
          mode: str(obj['mode']),
          paymentStatus: str(obj['payment_status']),
        },
      };
    case 'subscription':
      return { ...base, summary: { status: str(obj['status']) } };
    case 'invoice': {
      // Na API mais nova a assinatura vem em `parent.subscription_details`; nas antigas,
      // em `subscription`. Aceita os dois.
      const parent = asRecord(asRecord(obj['parent'])['subscription_details']);
      return {
        ...base,
        summary: {
          subscriptionId: idOf(parent['subscription']) ?? idOf(obj['subscription']),
          status: str(obj['status']),
        },
      };
    }
    default:
      return { ...base, summary: {} };
  }
}
