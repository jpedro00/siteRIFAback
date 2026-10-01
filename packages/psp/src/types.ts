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
/** O provedor respondeu 401: a credencial usada nao vale (expirada ou revogada). */
export class PspUnauthorizedError extends Error {
  constructor(message = 'O provedor recusou a credencial.') {
    super(message);
    this.name = 'PspUnauthorizedError';
  }
}

/** A comunidade nao tem conta de recebimento conectada. Nunca ha fallback para credencial global. */
export class PaymentsNotConfiguredError extends Error {
  constructor(message = 'A comunidade nao tem conta de recebimento conectada.') {
    super(message);
    this.name = 'PaymentsNotConfiguredError';
  }
}

/** A conta existe, mas nao pode ser usada agora (autorizacao invalida/revogada, conta desconectando...). */
export class PaymentAccountUnavailableError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Conta de recebimento indisponivel (${reason}).`);
    this.name = 'PaymentAccountUnavailableError';
    this.reason = reason;
  }
}

/** Um gateway ja amarrado a UMA conta de recebimento, e qual conta e. */
export interface PspResolution {
  readonly gateway: PspGateway;
  /** Nulo so para o PSP falso dos testes. */
  readonly paymentAccountId: string | null;
}

/**
 * Resolve o PSP PELA COMUNIDADE. E a unica forma de chegar a um gateway real: nao existe
 * credencial Mercado Pago global, e quem nao tem conta recebe `PaymentsNotConfiguredError`.
 */
export interface PspGatewayResolver {
  /** Provedor dos pagamentos que este resolvedor cria (`payments.provider`). */
  readonly provider: 'MERCADO_PAGO' | 'FAKE';
  /** Para criar cobranca NOVA: a conta que recebe hoje (CONNECTED). */
  forTenant(tenantId: string): Promise<PspResolution>;
  /**
   * Para consultar, conciliar ou devolver o que JA existe: a conta ORIGINAL do pagamento,
   * mesmo que a comunidade tenha trocado de conta (ou esteja desconectando).
   */
  forPayment(input: { tenantId: string; paymentAccountId: string | null }): Promise<PspResolution>;
  /** A assinatura do webhook e da APLICACAO da plataforma, nao de cada comunidade. */
  verifyWebhook(input: Parameters<PspGateway['verifyWebhook']>[0]): WebhookVerification;
}

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
