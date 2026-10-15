import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { StripeConnectGateway } from '../src/stripeConnect.js';
import { PspRejectedError, PspUnauthorizedError, PspUnavailableError } from '../src/types.js';

// Chaves FALSAS: nenhum segredo real aparece aqui.
const KEY = 'sk_test_fake_for_unit_tests';
const ACCT = 'acct_teste';

function intent(over: Record<string, unknown> = {}) {
  return {
    id: 'pi_1',
    status: 'requires_action',
    amount: 2500,
    created: 1_800_000_000,
    metadata: { order_id: 'ord-1' },
    transfer_data: { destination: ACCT },
    next_action: {
      type: 'pix_display_qr_code',
      pix_display_qr_code: { data: '000201PIX', expires_at: 1_800_003_600, image_url_png: 'https://x/qr.png' },
    },
    ...over,
  };
}

function make(client: Record<string, unknown>) {
  return new StripeConnectGateway({
    secretKey: KEY,
    connectedAccountId: ACCT,
    client: client as unknown as Stripe,
  });
}

const input = {
  idempotencyKey: 'ord-1',
  amountCents: 2500,
  description: 'Rifa',
  externalReference: 'ord-1',
  payerEmail: 'a@b.com',
  payerName: 'Fulano',
  expiresAt: new Date(Date.now() + 3600_000),
  notificationUrl: null,
  platformFeeCents: 125,
};

describe('StripeConnectGateway', () => {
  it('createPixCharge monta o PaymentIntent com taxa e destino', async () => {
    const create = vi.fn().mockResolvedValue(intent());
    const p = await make({ paymentIntents: { create } }).createPixCharge(input);
    const [params, opts] = create.mock.calls[0] as [Record<string, any>, Record<string, unknown>];
    expect(params).toMatchObject({
      amount: 2500,
      currency: 'brl',
      payment_method_types: ['pix'],
      payment_method_data: { type: 'pix' },
      confirm: true,
      application_fee_amount: 125,
      transfer_data: { destination: ACCT },
      metadata: { order_id: 'ord-1' },
    });
    expect(params['payment_method_options'].pix.expires_after_seconds).toBeGreaterThanOrEqual(60);
    expect(opts).toEqual({ idempotencyKey: 'ord-1' });
    expect(p.copyPaste).toBe('000201PIX');
    expect(p.qrCodeBase64).toBeNull();
    expect(p.status).toBe('PENDENTE');
    expect(p.providerPaymentId).toBe('pi_1');
  });

  it('expires_after_seconds tem minimo de 60', async () => {
    const create = vi.fn().mockResolvedValue(intent());
    await make({ paymentIntents: { create } }).createPixCharge({ ...input, expiresAt: new Date(Date.now() + 1000) });
    expect((create.mock.calls[0] as any)[0].payment_method_options.pix.expires_after_seconds).toBe(60);
  });

  it('getPayment mapeia estados', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ status: 'succeeded' }, 'APROVADO'],
      [{ status: 'requires_action' }, 'PENDENTE'],
      [{ status: 'processing' }, 'PENDENTE'],
      [{ status: 'requires_payment_method' }, 'PENDENTE'],
      [{ status: 'requires_confirmation' }, 'PENDENTE'],
      [{ status: 'canceled', cancellation_reason: 'automatic' }, 'EXPIRADO'],
      [{ status: 'canceled', cancellation_reason: 'requested_by_customer' }, 'CANCELADO'],
      [{ status: 'canceled' }, 'CANCELADO'],
    ];
    for (const [over, esperado] of cases) {
      const retrieve = vi.fn().mockResolvedValue(intent(over));
      const p = await make({ paymentIntents: { retrieve } }).getPayment('pi_1');
      expect(p.status).toBe(esperado);
      expect(p.amountCents).toBe(2500);
      expect(p.externalReference).toBe('ord-1');
    }
  });

  it('paidAt vem da cobranca paga, sem inventar horario', async () => {
    const ok = intent({ status: 'succeeded', latest_charge: { created: 1_800_000_500, paid: true } });
    const p = await make({ paymentIntents: { retrieve: vi.fn().mockResolvedValue(ok) } }).getPayment('pi_1');
    expect(p.paidAt).toBe(new Date(1_800_000_500 * 1000).toISOString());
    const pend = await make({ paymentIntents: { retrieve: vi.fn().mockResolvedValue(intent()) } }).getPayment('pi_1');
    expect(pend.paidAt).toBeNull();
  });

  it('getPayment recusa PaymentIntent de outra conta conectada', async () => {
    const retrieve = vi.fn().mockResolvedValue(intent({ transfer_data: { destination: 'acct_outra' } }));
    await expect(make({ paymentIntents: { retrieve } }).getPayment('pi_1')).rejects.toBeInstanceOf(PspRejectedError);
  });

  it('classifica erros e nunca vaza a chave', async () => {
    const err = (o: Record<string, unknown>) => Object.assign(new Error(`falha ${KEY}`), o);
    const gw = (e: unknown) => make({ paymentIntents: { retrieve: vi.fn().mockRejectedValue(e) } });
    await expect(gw(err({ statusCode: 400, type: 'StripeInvalidRequestError' })).getPayment('pi_1')).rejects.toBeInstanceOf(PspRejectedError);
    await expect(gw(err({ statusCode: 401 })).getPayment('pi_1')).rejects.toBeInstanceOf(PspUnauthorizedError);
    await expect(gw(err({ statusCode: 503 })).getPayment('pi_1')).rejects.toBeInstanceOf(PspUnavailableError);
    await expect(gw(err({ type: 'StripeConnectionError' })).getPayment('pi_1')).rejects.toBeInstanceOf(PspUnavailableError);
    for (const e of [err({ statusCode: 400 }), err({ statusCode: 500 })]) {
      const caught = await gw(e).getPayment('pi_1').catch((x: Error) => x);
      expect((caught as Error).message).not.toContain(KEY);
    }
  });

  it('refund devolve taxa e reverte a transferencia', async () => {
    const create = vi.fn().mockResolvedValue({ id: 're_1' });
    await make({ refunds: { create } }).refund('pi_1', 'idem-1');
    expect(create).toHaveBeenCalledWith(
      { payment_intent: 'pi_1', refund_application_fee: true, reverse_transfer: true },
      { idempotencyKey: 'idem-1' },
    );
  });

  it('listPaymentMethods devolve so PIX e verifyWebhook nao e usado', async () => {
    const gw = make({});
    const m = await gw.listPaymentMethods();
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ id: 'pix', paymentTypeId: 'bank_transfer', active: true });
    expect(gw.verifyWebhook({ headers: {}, query: {}, body: null })).toEqual({
      valid: false,
      reason: 'use o webhook Connect',
    });
    expect(gw.provider).toBe('STRIPE');
  });

  it('recusa chave live sem allowLive', () => {
    expect(() => new StripeConnectGateway({ secretKey: 'rk_live_fake', connectedAccountId: ACCT })).toThrow();
    expect(() => new StripeConnectGateway({ secretKey: 'sk_live_fake', connectedAccountId: ACCT })).toThrow();
    expect(
      () => new StripeConnectGateway({ secretKey: 'rk_live_fake', connectedAccountId: ACCT, allowLive: true }),
    ).not.toThrow();
  });
});
