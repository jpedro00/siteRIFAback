import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import {
  PspRejectedError,
  PspUnauthorizedError,
  PspUnavailableError,
  type CreatePixChargeInput,
  type PspFailedRefund,
  type PspGateway,
  type PspPayment,
  type PspPaymentMethod,
  type PspPaymentStatus,
  type WebhookVerification,
} from './types.js';

/**
 * Adaptador Stripe Connect (PIX, destination charge).
 *
 * O gateway fica amarrado a UMA conta conectada (`acct_...`) e usa a chave da PLATAFORMA,
 * entregue por parametro (lida do ambiente por quem monta). Nada aqui a grava, loga ou devolve.
 * Cobranca: PaymentIntent na conta da plataforma com `transfer_data.destination` = conta
 * conectada e `application_fee_amount` = taxa da plataforma.
 */

export interface StripeConnectOptions {
  readonly secretKey: string;
  readonly connectedAccountId: string;
  /** Chave live so com `allowLive` (a configuracao so o liga em producao). */
  readonly allowLive?: boolean;
  /** Para testes: substitui o SDK. */
  readonly client?: Stripe;
}

const REQUEST_TIMEOUT_MS = 10_000;
/** `failure_reason` da Stripe e um codigo (`expired_or_canceled_card`, `lost_or_stolen_card`...). */
const FAILURE_REASON = /^[a-z][a-z0-9_]{0,63}$/;
const MIN_PIX_EXPIRES_SECONDS = 60;
/** Teto da Stripe para o prazo do PIX (`expires_at` ate 14 dias no futuro). */
const MAX_PIX_EXPIRES_SECONDS = 1_209_600;

function isLiveKey(secretKey: string): boolean {
  return secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_');
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

const iso = (seconds: unknown): string | null =>
  typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null;

/** Mensagem curta e sem nada que lembre uma chave da Stripe. */
function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'Falha na Stripe.';
  return raw.replace(/\b[rs]k_(?:live|test)_\w*/g, '[chave]').slice(0, 300);
}

/** 401 = credencial invalida; rede, limite de taxa e 5xx = tentar de novo; o resto (4xx) e definitivo. */
function classify(error: unknown): Error {
  if (
    error instanceof PspRejectedError ||
    error instanceof PspUnavailableError ||
    error instanceof PspUnauthorizedError
  ) {
    return error;
  }
  const e = asRecord(error);
  const type = String(e['type'] ?? '');
  const status = typeof e['statusCode'] === 'number' ? (e['statusCode'] as number) : 0;
  if (status === 401 || type === 'StripeAuthenticationError') return new PspUnauthorizedError();
  const transient =
    type === 'StripeConnectionError' ||
    type === 'StripeRateLimitError' ||
    type === 'StripeAPIError' ||
    status === 429 ||
    status >= 500;
  const message = safeMessage(error);
  // A causa original (erro do SDK) pode carregar cabecalhos; so o 5xx/rede a guarda.
  return transient ? new PspUnavailableError(message, error) : new PspRejectedError(message);
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw classify(error);
  }
}

/**
 * `status` do PaymentIntent -> vocabulario da plataforma.
 * `canceled` com `cancellation_reason: 'automatic'` e o cancelamento feito pela propria Stripe
 * quando o prazo do PIX vence sem pagamento: vira EXPIRADO. Qualquer outro motivo (ou nenhum)
 * e cancelamento deliberado: CANCELADO.
 */
function mapStatus(status: unknown, cancellationReason: unknown): PspPaymentStatus {
  switch (status) {
    case 'succeeded':
      return 'APROVADO';
    case 'canceled':
      return cancellationReason === 'automatic' ? 'EXPIRADO' : 'CANCELADO';
    default:
      // requires_action, processing, requires_payment_method, requires_confirmation...
      return 'PENDENTE';
  }
}

/**
 * Estorno TOTAL da cobranca? O PaymentIntent estornado continua `succeeded`: quem diz e a charge
 * (`refunded`, ou `amount_refunded >= amount`). Estorno PARCIAL nao conta: a plataforma so estorna
 * por inteiro, e um parcial (feito fora dela) mantem o pagamento APROVADO — os numeros continuam
 * pagos e a divergencia de valor fica para o operador, nunca vira ESTORNADO por engano.
 */
function isFullyRefunded(charge: Record<string, unknown>): boolean {
  if (charge['refunded'] === true) return true;
  const amount = charge['amount'];
  const refunded = charge['amount_refunded'];
  return typeof amount === 'number' && amount > 0 && typeof refunded === 'number' && refunded >= amount;
}

/** Campos com segredo ou dado pessoal do pagador: nunca vao para `payments.raw`. */
const INTENT_SENSIVEIS = ['client_secret', 'receipt_email', 'shipping', 'next_action'] as const;
const CHARGE_SENSIVEIS = [
  'billing_details',
  'payment_method_details',
  'receipt_email',
  'receipt_url',
  'receipt_number',
  'shipping',
] as const;

/**
 * Copia do PaymentIntent para guardar em `payments.raw`: sem `client_secret`, sem dados do
 * pagador da cobranca (`billing_details`, `payment_method_details`, recibo) e sem o QR do PIX
 * (`next_action`, que no PIX so traz `pix_display_qr_code` — o copia-e-cola ja tem coluna
 * propria). Ficam ids, estado, valores, moeda, metadata, destino e taxa.
 */
function sanitizeIntent(intent: unknown): Record<string, unknown> {
  const copia: Record<string, unknown> = { ...asRecord(intent) };
  for (const campo of INTENT_SENSIVEIS) delete copia[campo];
  if (typeof copia['latest_charge'] === 'object' && copia['latest_charge'] !== null) {
    const charge: Record<string, unknown> = { ...asRecord(copia['latest_charge']) };
    for (const campo of CHARGE_SENSIVEIS) delete charge[campo];
    copia['latest_charge'] = charge;
  }
  return copia;
}

function toPayment(intent: unknown): PspPayment {
  const pi = asRecord(intent);
  const id = pi['id'];
  if (typeof id !== 'string' || id === '') {
    throw new PspRejectedError('Resposta da Stripe sem identificador de pagamento.');
  }
  const charge = asRecord(pi['latest_charge']); // so vem como objeto quando expandido
  const mapped = mapStatus(pi['status'], pi['cancellation_reason']);
  // So um pagamento que FOI aprovado pode ter sido estornado.
  const status: PspPaymentStatus = mapped === 'APROVADO' && isFullyRefunded(charge) ? 'ESTORNADO' : mapped;
  const pix = asRecord(asRecord(pi['next_action'])['pix_display_qr_code']);
  const metadata = asRecord(pi['metadata']);
  const orderId = metadata['order_id'];
  // paidAt: so existe se foi pago (aprovado, ou aprovado e depois estornado). Horario da cobranca
  // paga; sem ela, o `created` do intent.
  const paid = status === 'APROVADO' || status === 'ESTORNADO';
  const paidAt = paid ? (iso(charge['created']) ?? iso(pi['created'])) : null;
  return {
    providerPaymentId: id,
    status,
    amountCents: typeof pi['amount'] === 'number' ? (pi['amount'] as number) : 0,
    externalReference: typeof orderId === 'string' ? orderId : null,
    paidAt,
    expiresAt: iso(pix['expires_at']),
    copyPaste: typeof pix['data'] === 'string' ? (pix['data'] as string) : null,
    // A Stripe entrega a imagem por URL (`image_url_png`), nao em base64.
    qrCodeBase64: null,
    raw: sanitizeIntent(intent),
  };
}

export class StripeConnectGateway implements PspGateway {
  readonly provider = 'STRIPE' as const;
  readonly #stripe: Stripe;
  readonly #connectedAccountId: string;

  constructor(options: StripeConnectOptions) {
    if (isLiveKey(options.secretKey) && options.allowLive !== true) {
      throw new Error('Chave LIVE da Stripe recusada fora de producao.');
    }
    this.#connectedAccountId = options.connectedAccountId;
    this.#stripe =
      options.client ??
      new Stripe(options.secretKey, { timeout: REQUEST_TIMEOUT_MS, maxNetworkRetries: 2 });
  }

  /** PIX e o unico meio que este gateway cria. */
  async listPaymentMethods(): Promise<readonly PspPaymentMethod[]> {
    return [{ id: 'pix', paymentTypeId: 'bank_transfer', name: 'PIX', active: true }];
  }

  createPixCharge(input: CreatePixChargeInput): Promise<PspPayment> {
    // Prazo ABSOLUTO (epoch em segundos), limitado ao que a Stripe aceita: ao menos agora + 60 s e
    // no maximo agora + 14 dias. Absoluto, e nao relativo: o mesmo `expiresAt` gera o mesmo valor
    // em qualquer segundo, entao um retry ou duplo envio segundos depois repete os parametros.
    const agoraSeg = Math.floor(Date.now() / 1000);
    const expiresAt = Math.min(
      agoraSeg + MAX_PIX_EXPIRES_SECONDS,
      Math.max(agoraSeg + MIN_PIX_EXPIRES_SECONDS, Math.floor(input.expiresAt.getTime() / 1000)),
    );
    // Chave de idempotencia = pedido + impressao digital dos PARAMETROS. A Stripe recusa a mesma
    // chave com parametros diferentes, e prazo e taxa (plano vigente) podem mudar entre
    // tentativas: com a chave so do pedido, uma falha depois de criar o PaymentIntent (a gravacao
    // no banco, a rede) travaria o pedido para sempre. Assim, o retry identico (inclusive o do
    // proprio SDK, e o duplo envio com o mesmo prazo absoluto) continua deduplicado na Stripe; um
    // retry com parametros novos cria outro PaymentIntent, e o que vale e a linha que vence o
    // `INSERT ... ON CONFLICT` no banco — o comprador so ve o QR dela, e o PaymentIntent sem uso
    // expira sozinho pelo prazo do PIX.
    const fingerprint = createHash('sha256')
      .update(
        `${input.amountCents}|${input.platformFeeCents ?? 0}|${expiresAt}|${this.#connectedAccountId}|${input.description}`,
      )
      .digest('hex')
      .slice(0, 16);
    const idempotencyKey = `${input.idempotencyKey}:${fingerprint}`;
    return call(async () => {
      const intent = await this.#stripe.paymentIntents.create(
        {
          amount: input.amountCents,
          currency: 'brl',
          payment_method_types: ['pix'],
          payment_method_data: { type: 'pix' },
          payment_method_options: { pix: { expires_at: expiresAt } },
          confirm: true,
          description: input.description,
          ...(input.platformFeeCents !== undefined && input.platformFeeCents > 0 ? { application_fee_amount: input.platformFeeCents } : {}),
          transfer_data: { destination: this.#connectedAccountId },
          metadata: { order_id: input.externalReference },
        },
        { idempotencyKey },
      );
      return toPayment(intent);
    });
  }

  getPayment(providerPaymentId: string): Promise<PspPayment> {
    return call(async () => {
      const intent = await this.#stripe.paymentIntents.retrieve(providerPaymentId, {
        expand: ['latest_charge'],
      });
      this.#assertOwn(intent);
      return toPayment(intent);
    });
  }

  /** Defesa contra id trocado: o pagamento tem de ser DESTA conta conectada. */
  #assertOwn(intent: unknown): void {
    const destination = asRecord(asRecord(intent)['transfer_data'])['destination'];
    const destinationId = typeof destination === 'string' ? destination : asRecord(destination)['id'];
    if (destinationId !== this.#connectedAccountId) {
      throw new PspRejectedError('O pagamento nao pertence a conta conectada deste gateway.');
    }
  }

  /** Estorno total: devolve tambem a taxa da plataforma e reverte a transferencia ao vendedor. */
  refund(providerPaymentId: string, idempotencyKey: string): Promise<void> {
    return call(async () => {
      // Mesma defesa do getPayment: nunca estorna pagamento de outra conta.
      this.#assertOwn(await this.#stripe.paymentIntents.retrieve(providerPaymentId));
      await this.#stripe.refunds.create(
        { payment_intent: providerPaymentId, refund_application_fee: true, reverse_transfer: true },
        { idempotencyKey },
      );
    });
  }

  /**
   * Estornos FALHADOS do PaymentIntent, relidos na Stripe (RN06). Mesma defesa do getPayment: o
   * PaymentIntent tem de ser desta conta conectada, senao nem lista. So sai id, valor e o codigo
   * do motivo — nada de `destination_details`/instrucoes (dados do comprador).
   */
  failedRefunds(providerPaymentId: string): Promise<readonly PspFailedRefund[]> {
    return call(async () => {
      this.#assertOwn(await this.#stripe.paymentIntents.retrieve(providerPaymentId));
      // Um pagamento so e estornado por inteiro, uma vez: 100 cobre com folga (sem paginar).
      const page = await this.#stripe.refunds.list({ payment_intent: providerPaymentId, limit: 100 });
      const data: unknown = asRecord(page)['data'];
      const out: PspFailedRefund[] = [];
      for (const item of Array.isArray(data) ? (data as unknown[]) : []) {
        const r = asRecord(item);
        if (r['status'] !== 'failed' || typeof r['id'] !== 'string') continue;
        const reason = r['failure_reason'];
        out.push({
          refundId: r['id'],
          amountCents: typeof r['amount'] === 'number' ? r['amount'] : 0,
          failureReason: typeof reason === 'string' && FAILURE_REASON.test(reason) ? reason : null,
        });
      }
      return out;
    });
  }

  /** A verificacao do webhook Connect e outra peca (nao usa este gateway). */
  verifyWebhook(_input: Parameters<PspGateway['verifyWebhook']>[0]): WebhookVerification {
    return { valid: false, reason: 'use o webhook Connect' };
  }
}
