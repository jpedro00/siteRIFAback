/**
 * Provedor de pagamento (PSP). M05.
 *
 * O restante da API fala com esta INTERFACE, nunca com o Mercado Pago. Trocar de
 * provedor — ou usar o falso nos testes — nao toca regra de negocio.
 *
 * REGRA CENTRAL (RN06): um pagamento so vale depois de CONSULTADO no PSP. O que
 * chega num webhook e um aviso de que vale a pena consultar, nunca a prova.
 */

/** Estado de um pagamento, no vocabulario da plataforma (`payment_status`). */
export type PspPaymentStatus = 'PENDENTE' | 'APROVADO' | 'EXPIRADO' | 'CANCELADO' | 'ESTORNADO';

export interface PspPayment {
  readonly providerPaymentId: string;
  readonly status: PspPaymentStatus;
  readonly amountCents: number;
  /** O que enviamos como `external_reference`: o `order_id`. */
  readonly externalReference: string | null;
  readonly paidAt: string | null;
  readonly expiresAt: string | null;
  /** "Copia e cola" do PIX. */
  readonly copyPaste: string | null;
  readonly qrCodeBase64: string | null;
  /** Resposta do PSP, para diagnostico. Nunca contem credencial nossa. */
  readonly raw: unknown;
}

export interface CreatePixChargeInput {
  /** Chave de idempotencia: o `order_id`. Repetir a chamada nao cobra duas vezes. */
  readonly idempotencyKey: string;
  readonly amountCents: number;
  readonly description: string;
  readonly externalReference: string;
  readonly payerEmail: string | null;
  readonly payerName: string;
  readonly expiresAt: Date;
  /** Onde o PSP avisa (webhook). Nulo quando nao ha URL publica configurada. */
  readonly notificationUrl: string | null;
}

export type WebhookVerification =
  | { readonly valid: true; readonly isPaymentEvent: boolean; readonly paymentId: string | null }
  | { readonly valid: false; readonly reason: string };

export interface PspGateway {
  readonly provider: 'MERCADO_PAGO' | 'FAKE';
  createPixCharge(input: CreatePixChargeInput): Promise<PspPayment>;
  getPayment(providerPaymentId: string): Promise<PspPayment>;
  /** Confere a ASSINATURA do aviso e extrai o identificador do pagamento. */
  verifyWebhook(input: {
    headers: Readonly<Record<string, string | undefined>>;
    query: Readonly<Record<string, string | undefined>>;
    body: unknown;
  }): WebhookVerification;
}

/** O PSP nao respondeu ou respondeu com erro de servidor. E transitorio: tente de novo. */
export class PspUnavailableError extends Error {
  override readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'PspUnavailableError';
    this.cause = cause;
  }
}

/** O PSP recusou o pedido (dado invalido). Repetir nao adianta. */
export class PspRejectedError extends Error {
  readonly detail: unknown;
  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = 'PspRejectedError';
    this.detail = detail;
  }
}
