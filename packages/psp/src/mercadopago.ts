import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  PspRejectedError,
  PspUnauthorizedError,
  PspUnavailableError,
  type CreatePixChargeInput,
  type PspGateway,
  type PspPayment,
  type PspPaymentMethod,
  type PspPaymentStatus,
  type WebhookVerification,
} from './types.js';

/**
 * Adaptador do Mercado Pago (PIX).
 *
 * As credenciais entram POR PARAMETRO, lidas de variavel de ambiente por quem
 * monta o adaptador. Nada aqui as grava, loga ou devolve.
 */

const API_BASE = 'https://api.mercadopago.com';
const TIMEOUT_MS = 10_000;

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;
type FetchLike = (input: string, init?: FetchInit) => Promise<Response>;

export interface MercadoPagoOptions {
  readonly accessToken: string;
  readonly webhookSecret: string;
  /** Usado quando o comprador nao informou e-mail; o MP exige um. */
  readonly fallbackPayerEmail?: string | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  readonly apiBase?: string | undefined;
}

interface MpPaymentBody {
  id?: number | string;
  status?: string;
  status_detail?: string;
  transaction_amount?: number;
  external_reference?: string | null;
  date_approved?: string | null;
  date_of_expiration?: string | null;
  point_of_interaction?: {
    transaction_data?: { qr_code?: string | null; qr_code_base64?: string | null };
  };
}

/** `status` do MP -> vocabulario da plataforma. */
function mapStatus(status: string | undefined, detail: string | undefined): PspPaymentStatus {
  switch (status) {
    case 'approved':
      return 'APROVADO';
    case 'refunded':
    case 'charged_back':
      return 'ESTORNADO';
    case 'cancelled':
      // O MP usa `cancelled` + `expired` quando o prazo do PIX termina.
      return detail === 'expired' ? 'EXPIRADO' : 'CANCELADO';
    case 'rejected':
      return 'CANCELADO';
    default:
      // pending, in_process, authorized...: ainda nao e dinheiro na conta.
      return 'PENDENTE';
  }
}

function toPayment(body: MpPaymentBody): PspPayment {
  if (body.id === undefined || body.id === null) {
    throw new PspRejectedError('Resposta do Mercado Pago sem identificador de pagamento.', body);
  }
  const data = body.point_of_interaction?.transaction_data;
  return {
    providerPaymentId: String(body.id),
    status: mapStatus(body.status, body.status_detail),
    // `Math.round`: 19.99 * 100 = 1998.9999999999998 em ponto flutuante.
    amountCents: Math.round((body.transaction_amount ?? 0) * 100),
    externalReference: body.external_reference ?? null,
    paidAt: body.date_approved ?? null,
    expiresAt: body.date_of_expiration ?? null,
    copyPaste: data?.qr_code ?? null,
    qrCodeBase64: data?.qr_code_base64 ?? null,
    raw: body,
  };
}

export class MercadoPagoGateway implements PspGateway {
  readonly provider = 'MERCADO_PAGO' as const;
  private readonly fetchImpl: FetchLike;
  private readonly apiBase: string;

  constructor(private readonly options: MercadoPagoOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.apiBase = options.apiBase ?? API_BASE;
  }

  private async call(path: string, init: FetchInit): Promise<MpPaymentBody> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiBase}${path}`, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${this.options.accessToken}`,
          'Content-Type': 'application/json',
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch (error) {
      // Rede, DNS, timeout: transitorio.
      throw new PspUnavailableError('Mercado Pago indisponivel.', error);
    }

    if (res.status >= 500 || res.status === 429) {
      throw new PspUnavailableError(`Mercado Pago respondeu ${res.status}.`);
    }
    // 401: a credencial desta conta nao vale. Quem chama decide renovar ou marcar a conta.
    if (res.status === 401) {
      throw new PspUnauthorizedError();
    }
    const texto = await res.text();
    let json: unknown = null;
    try {
      json = texto === '' ? null : JSON.parse(texto);
    } catch {
      throw new PspUnavailableError('Resposta do Mercado Pago nao e JSON.');
    }
    if (!res.ok) {
      // 4xx: pedido recusado. O corpo do MP nao carrega nossa credencial.
      throw new PspRejectedError(`Mercado Pago recusou o pedido (${res.status}).`, json);
    }
    return json as MpPaymentBody;
  }

  async createPixCharge(input: CreatePixChargeInput): Promise<PspPayment> {
    const email = input.payerEmail ?? this.options.fallbackPayerEmail ?? null;
    if (!email) {
      throw new PspRejectedError(
        'O Mercado Pago exige um e-mail do pagador e nenhum foi informado nem configurado.',
      );
    }

    const body = await this.call('/v1/payments', {
      method: 'POST',
      headers: { 'X-Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify({
        transaction_amount: input.amountCents / 100,
        description: input.description,
        payment_method_id: 'pix',
        external_reference: input.externalReference,
        date_of_expiration: input.expiresAt.toISOString().replace('Z', '+00:00'),
        payer: { email, first_name: input.payerName },
        ...(input.notificationUrl ? { notification_url: input.notificationUrl } : {}),
      }),
    });
    return toPayment(body);
  }

  async listPaymentMethods(): Promise<readonly PspPaymentMethod[]> {
    const corpo = (await this.call('/v1/payment_methods', { method: 'GET' })) as unknown;
    if (!Array.isArray(corpo)) {
      throw new PspUnavailableError('Mercado Pago devolveu uma lista de meios de pagamento inesperada.');
    }
    const meios: PspPaymentMethod[] = [];
    for (const item of corpo as {
      id?: unknown;
      payment_type_id?: unknown;
      name?: unknown;
      status?: unknown;
    }[]) {
      if (typeof item?.id !== 'string' || typeof item.payment_type_id !== 'string') continue;
      meios.push({
        id: item.id,
        paymentTypeId: item.payment_type_id,
        name: typeof item.name === 'string' ? item.name : item.id,
        active: item.status === 'active',
      });
    }
    return meios;
  }

  async getPayment(providerPaymentId: string): Promise<PspPayment> {
    if (!/^[0-9]+$/.test(providerPaymentId)) {
      // O identificador entra no caminho da URL: nada alem de digitos passa.
      throw new PspRejectedError('Identificador de pagamento invalido.');
    }
    const body = await this.call(`/v1/payments/${providerPaymentId}`, { method: 'GET' });
    return toPayment(body);
  }

  /**
   * Assinatura do webhook do Mercado Pago.
   *
   * Cabecalho `x-signature: ts=<epoch>,v1=<hex>`. O `v1` e o HMAC-SHA256 do
   * "manifesto" `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, com o segredo
   * do webhook. Partes ausentes saem do manifesto. Comparacao em tempo constante.
   *
   * A assinatura prova que o AVISO veio do MP; ela NAO prova que o pagamento
   * foi aprovado. Isso e decidido consultando o pagamento (RN06).
   */
  verifyWebhook(input: {
    headers: Readonly<Record<string, string | undefined>>;
    query: Readonly<Record<string, string | undefined>>;
    body: unknown;
  }): WebhookVerification {
    return verifyMercadoPagoWebhook(this.options.webhookSecret, input);
  }
}

/**
 * Verificacao da assinatura do webhook, SEM precisar de credencial de conta nenhuma: o segredo
 * e o da APLICACAO da plataforma no Mercado Pago (um so, para todas as comunidades).
 */
export function verifyMercadoPagoWebhook(
  webhookSecret: string,
  input: {
    headers: Readonly<Record<string, string | undefined>>;
    query: Readonly<Record<string, string | undefined>>;
    body: unknown;
  },
): WebhookVerification {
  {
    const assinatura = input.headers['x-signature'];
    if (!assinatura) return { valid: false, reason: 'sem x-signature' };

    const partes = Object.fromEntries(
      assinatura.split(',').map((p) => {
        const i = p.indexOf('=');
        return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
      }),
    );
    const ts = partes['ts'];
    const v1 = partes['v1'];
    if (!ts || !v1) return { valid: false, reason: 'x-signature incompleta' };

    const corpo = (input.body ?? {}) as { type?: string; data?: { id?: string | number } };
    // O `data.id` assinado e o da QUERY; o do corpo so entra se a query nao trouxer.
    const idBruto =
      input.query['data.id'] ?? (corpo.data?.id !== undefined ? String(corpo.data.id) : undefined);
    // O MP assina o id em minusculas quando alfanumerico.
    const id = idBruto?.toLowerCase();
    const requestId = input.headers['x-request-id'];

    const manifesto =
      (id ? `id:${id};` : '') + (requestId ? `request-id:${requestId};` : '') + `ts:${ts};`;
    const esperado = createHmac('sha256', webhookSecret).update(manifesto).digest('hex');

    const a = Buffer.from(esperado, 'utf8');
    const b = Buffer.from(v1, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { valid: false, reason: 'assinatura nao confere' };
    }

    const topico = corpo.type ?? input.query['type'] ?? input.query['topic'];
    return { valid: true, isPaymentEvent: topico === 'payment', paymentId: idBruto ?? null };
  }
}
