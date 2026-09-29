import { createHmac } from 'node:crypto';
import { MercadoPagoGateway } from '../mercadopago.js';
import {
  PspRejectedError,
  PspUnavailableError,
  type CreatePixChargeInput,
  type PspGateway,
  type PspPayment,
  type PspPaymentStatus,
  type WebhookVerification,
} from '../types.js';

/**
 * PSP FALSO. Existe SO na bancada de testes: nenhuma variavel de ambiente o liga.
 * Recusa ser construido em staging ou producao — o pacote o exporta em um caminho
 * proprio (`@clubedarifa/psp/testing`), fora do `index`, e esta guarda cobre o
 * import por engano.
 *
 * A verificacao de assinatura NAO e falsa: delega ao adaptador REAL do Mercado
 * Pago, com um segredo de teste. Assim os testes de webhook exercitam o mesmo
 * HMAC que producao usa, e nao uma comparacao de string inventada aqui.
 *
 * `approve`/`setStatus` mexem no "lado do PSP" — o que a CONSULTA devolve. E
 * isso que prova RN06: o teste decide o que o provedor diz, e a API so paga se
 * a consulta disser "aprovado".
 */
export const FAKE_WEBHOOK_SECRET = 'segredo-do-webhook-de-teste';

interface Cobranca {
  payment: PspPayment;
  idempotencyKey: string;
}

export class FakePsp implements PspGateway {
  readonly provider = 'FAKE' as const;
  private readonly real = new MercadoPagoGateway({
    accessToken: 'nao-usado',
    webhookSecret: FAKE_WEBHOOK_SECRET,
  });
  private readonly cobrancas = new Map<string, Cobranca>();
  // Ponto de partida por instancia: o banco de teste guarda pagamentos de execucoes
  // anteriores, e `(provider, provider_payment_id)` e unico.
  private proximoId = 900_000_000 + Math.floor(Math.random() * 50_000_000);

  constructor() {
    const ambiente = process.env['NODE_ENV'];
    if (ambiente === 'production' || ambiente === 'staging') {
      throw new Error('O PSP falso nao pode ser usado em staging nem em producao.');
    }
  }

  readonly calls = { create: 0, get: 0 };
  /** Faz a proxima criacao falhar, uma vez. */
  falharProximaCriacao: 'unavailable' | 'rejected' | null = null;
  /** Faz TODA consulta falhar como indisponivel, ate desligar. */
  consultaIndisponivel = false;

  async createPixCharge(input: CreatePixChargeInput): Promise<PspPayment> {
    this.calls.create += 1;
    if (this.falharProximaCriacao === 'unavailable') {
      this.falharProximaCriacao = null;
      throw new PspUnavailableError('PSP falso: indisponivel.');
    }
    if (this.falharProximaCriacao === 'rejected') {
      this.falharProximaCriacao = null;
      throw new PspRejectedError('PSP falso: recusado.');
    }

    // Idempotencia do PSP: mesma chave, mesma cobranca.
    const existente = this.cobrancas.get(input.idempotencyKey);
    if (existente) return existente.payment;

    const payment: PspPayment = {
      providerPaymentId: String(this.proximoId++),
      status: 'PENDENTE',
      amountCents: input.amountCents,
      externalReference: input.externalReference,
      paidAt: null,
      expiresAt: input.expiresAt.toISOString(),
      copyPaste: `00020126FAKEPIX${input.externalReference}`,
      qrCodeBase64: 'ZmFrZS1xci1jb2Rl',
      raw: { fake: true },
    };
    this.cobrancas.set(input.idempotencyKey, { payment, idempotencyKey: input.idempotencyKey });
    return payment;
  }

  async getPayment(providerPaymentId: string): Promise<PspPayment> {
    this.calls.get += 1;
    if (this.consultaIndisponivel) throw new PspUnavailableError('PSP falso: consulta indisponivel.');
    for (const { payment } of this.cobrancas.values()) {
      if (payment.providerPaymentId === providerPaymentId) return payment;
    }
    throw new PspRejectedError('PSP falso: pagamento inexistente.');
  }

  verifyWebhook(input: Parameters<PspGateway['verifyWebhook']>[0]): WebhookVerification {
    return this.real.verifyWebhook(input);
  }

  // ---- lado do "provedor", manipulado pelo teste ----

  private cobrancaDoPedido(orderId: string): Cobranca {
    const c = this.cobrancas.get(orderId);
    if (!c) throw new Error(`PSP falso: nenhuma cobranca para o pedido ${orderId}`);
    return c;
  }

  idDoPedido(orderId: string): string {
    return this.cobrancaDoPedido(orderId).payment.providerPaymentId;
  }

  setStatus(
    orderId: string,
    status: PspPaymentStatus,
    overrides: Partial<PspPayment> = {},
  ): void {
    const c = this.cobrancaDoPedido(orderId);
    c.payment = {
      ...c.payment,
      status,
      paidAt: status === 'APROVADO' ? new Date().toISOString() : c.payment.paidAt,
      ...overrides,
    };
  }

  approve(orderId: string, overrides: Partial<PspPayment> = {}): void {
    this.setStatus(orderId, 'APROVADO', overrides);
  }

  /** Cabecalhos e query de um aviso ASSINADO pelo "PSP", como o Mercado Pago faz. */
  signedWebhook(
    providerPaymentId: string,
    opts: { secret?: string; requestId?: string; ts?: string } = {},
  ): { headers: Record<string, string>; query: Record<string, string>; body: unknown } {
    const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
    const requestId = opts.requestId ?? `req-${providerPaymentId}`;
    const manifesto = `id:${providerPaymentId};request-id:${requestId};ts:${ts};`;
    const v1 = createHmac('sha256', opts.secret ?? FAKE_WEBHOOK_SECRET)
      .update(manifesto)
      .digest('hex');
    return {
      headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId },
      query: { 'data.id': providerPaymentId, type: 'payment' },
      body: { type: 'payment', action: 'payment.updated', data: { id: providerPaymentId } },
    };
  }
}
