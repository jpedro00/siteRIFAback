import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

/** A chave esperada: pedido + impressao digital dos parametros (sha256, 16 hex). `expires` e ABSOLUTO (epoch s). */
const chave = (pedido: string, amount: number, fee: number, expires: number, acct = ACCT, desc = 'Rifa') =>
  `${pedido}:${createHash('sha256').update(`${amount}|${fee}|${expires}|${acct}|${desc}`).digest('hex').slice(0, 16)}`;

describe('StripeConnectGateway', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('chave de idempotencia (pedido + parametros)', () => {
    const agora = new Date('2026-10-15T12:00:00Z');
    const chaveDe = (create: ReturnType<typeof vi.fn>, i: number) =>
      (create.mock.calls[i] as [unknown, { idempotencyKey: string }])[1].idempotencyKey;

    const epoch = (d: Date) => Math.floor(d.getTime() / 1000);

    it('mesmos parametros: mesma chave (retry identico deduplica na Stripe)', async () => {
      vi.useFakeTimers({ now: agora });
      const create = vi.fn().mockResolvedValue(intent());
      const gw = make({ paymentIntents: { create } });
      const em = new Date(agora.getTime() + 1800_000);
      await gw.createPixCharge({ ...input, expiresAt: em });
      await gw.createPixCharge({ ...input, expiresAt: em });
      expect(chaveDe(create, 0)).toBe(chaveDe(create, 1));
      expect(chaveDe(create, 0)).toBe(chave('ord-1', 2500, 125, epoch(em)));
      expect(chaveDe(create, 0)).toMatch(/^ord-1:[0-9a-f]{16}$/);
    });

    it('mesmo prazo ABSOLUTO, chamadas segundos depois: mesma chave e mesmo expires_at', async () => {
      vi.useFakeTimers({ now: agora });
      const create = vi.fn().mockResolvedValue(intent());
      const gw = make({ paymentIntents: { create } });
      const em = new Date(agora.getTime() + 1800_000);
      await gw.createPixCharge({ ...input, expiresAt: em });
      vi.setSystemTime(agora.getTime() + 7_400); // duplo envio / retry 7,4 s depois
      await gw.createPixCharge({ ...input, expiresAt: em });
      expect(chaveDe(create, 0)).toBe(chaveDe(create, 1));
      const pixDe = (i: number) => (create.mock.calls[i] as any)[0].payment_method_options.pix;
      expect(pixDe(0)).toEqual({ expires_at: epoch(em) });
      expect(pixDe(1)).toEqual({ expires_at: epoch(em) });
    });

    it('prazo, taxa, valor, conta ou descricao diferentes: outra chave (sem conflito de idempotencia)', async () => {
      vi.useFakeTimers({ now: agora });
      const create = vi.fn().mockResolvedValue(intent());
      const gw = make({ paymentIntents: { create } });
      const em = new Date(agora.getTime() + 1800_000);
      await gw.createPixCharge({ ...input, expiresAt: em });
      await gw.createPixCharge({ ...input, expiresAt: new Date(em.getTime() - 5_000) });
      await gw.createPixCharge({ ...input, expiresAt: em, platformFeeCents: 200 });
      await gw.createPixCharge({ ...input, expiresAt: em, amountCents: 2600 });
      const outra = new StripeConnectGateway({
        secretKey: KEY,
        connectedAccountId: 'acct_outra',
        client: { paymentIntents: { create } } as unknown as Stripe,
      });
      await outra.createPixCharge({ ...input, expiresAt: em });
      await gw.createPixCharge({ ...input, expiresAt: em, description: 'Outra rifa' });
      const chaves = [0, 1, 2, 3, 4, 5].map((i) => chaveDe(create, i));
      expect(new Set(chaves).size).toBe(6);
      expect(chaves[1]).toBe(chave('ord-1', 2500, 125, epoch(em) - 5));
      expect(chaves[2]).toBe(chave('ord-1', 2500, 200, epoch(em)));
      expect(chaves[4]).toBe(chave('ord-1', 2500, 125, epoch(em), 'acct_outra'));
      expect(chaves[5]).toBe(chave('ord-1', 2500, 125, epoch(em), ACCT, 'Outra rifa'));
    });

    it('sem taxa: a impressao usa 0', async () => {
      vi.useFakeTimers({ now: agora });
      const create = vi.fn().mockResolvedValue(intent());
      const semTaxa: Partial<typeof input> = { ...input };
      delete semTaxa.platformFeeCents;
      await make({ paymentIntents: { create } }).createPixCharge({
        ...(semTaxa as Omit<typeof input, 'platformFeeCents'>),
        expiresAt: new Date(agora.getTime() + 1800_000),
      });
      expect(chaveDe(create, 0)).toBe(chave('ord-1', 2500, 0, epoch(agora) + 1800));
    });
  });

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
    expect(params['payment_method_options'].pix).toEqual({ expires_at: Math.floor(input.expiresAt.getTime() / 1000) });
    expect(params['payment_method_options'].pix).not.toHaveProperty('expires_after_seconds');
    const exp = params['payment_method_options'].pix.expires_at as number;
    expect(opts).toEqual({ idempotencyKey: chave('ord-1', 2500, 125, exp) });
    expect(p.copyPaste).toBe('000201PIX');
    expect(p.qrCodeBase64).toBeNull();
    expect(p.status).toBe('PENDENTE');
    expect(p.providerPaymentId).toBe('pi_1');
  });

  it('expires_at tem minimo de agora + 60 s', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-15T12:00:00Z') });
    const create = vi.fn().mockResolvedValue(intent());
    await make({ paymentIntents: { create } }).createPixCharge({ ...input, expiresAt: new Date(Date.now() + 1000) });
    expect((create.mock.calls[0] as any)[0].payment_method_options.pix.expires_at).toBe(Math.floor(Date.now() / 1000) + 60);
  });

  describe('raw sanitizado (vai para payments.raw)', () => {
    const sensivel = intent({
      client_secret: 'pi_1_secret_abc',
      status: 'succeeded',
      currency: 'brl',
      application_fee_amount: 125,
      receipt_email: 'comprador@exemplo.test',
      latest_charge: {
        id: 'ch_1',
        object: 'charge',
        status: 'succeeded',
        amount: 2500,
        amount_refunded: 0,
        created: 1_800_000_100,
        refunded: false,
        billing_details: { name: 'Fulano', email: 'comprador@exemplo.test', phone: '+5511999999999', address: null },
        payment_method_details: { type: 'pix', pix: { bank_transaction_id: 'E123' } },
        receipt_email: 'comprador@exemplo.test',
        receipt_url: 'https://pay.stripe.com/receipts/x',
        receipt_number: '1234',
        shipping: null,
      },
    });

    const conferir = (raw: unknown) => {
      const json = JSON.stringify(raw);
      for (const proibido of ['client_secret', 'billing_details', 'payment_method_details', 'receipt_', 'pix_display_qr_code', 'comprador@', '000201PIX']) {
        expect(json).not.toContain(proibido);
      }
      expect(raw).toMatchObject({
        id: 'pi_1',
        status: 'succeeded',
        amount: 2500,
        currency: 'brl',
        metadata: { order_id: 'ord-1' },
        transfer_data: { destination: ACCT },
        application_fee_amount: 125,
        latest_charge: { id: 'ch_1', status: 'succeeded', amount: 2500 },
      });
    };

    it('getPayment: sem client_secret, dados do pagador nem QR', async () => {
      const p = await make({ paymentIntents: { retrieve: vi.fn().mockResolvedValue(sensivel) } }).getPayment('pi_1');
      conferir(p.raw);
      expect(p.status).toBe('APROVADO');
    });

    it('createPixCharge: o QR segue em copyPaste, mas nao no raw', async () => {
      const create = vi.fn().mockResolvedValue({ ...intent({ client_secret: 'pi_1_secret_abc' }) });
      const p = await make({ paymentIntents: { create } }).createPixCharge(input);
      expect(p.copyPaste).toBe('000201PIX');
      expect(JSON.stringify(p.raw)).not.toContain('client_secret');
      expect(JSON.stringify(p.raw)).not.toContain('000201PIX');
    });
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

  describe('estorno no latest_charge', () => {
    const consultar = (latest: Record<string, unknown> | string) =>
      make({
        paymentIntents: {
          retrieve: vi.fn().mockResolvedValue(intent({ status: 'succeeded', latest_charge: latest })),
        },
      }).getPayment('pi_1');

    it('cobranca estornada (refunded) vira ESTORNADO e mantem o paidAt do pagamento', async () => {
      const p = await consultar({ created: 1_800_000_500, paid: true, refunded: true, amount: 2500, amount_refunded: 2500 });
      expect(p.status).toBe('ESTORNADO');
      expect(p.paidAt).toBe(new Date(1_800_000_500 * 1000).toISOString());
    });

    it('amount_refunded >= amount tambem e estorno total', async () => {
      const p = await consultar({ created: 1_800_000_500, paid: true, refunded: false, amount: 2500, amount_refunded: 2500 });
      expect(p.status).toBe('ESTORNADO');
    });

    it('estorno PARCIAL continua APROVADO (a plataforma nunca estorna em parte)', async () => {
      const p = await consultar({ created: 1_800_000_500, paid: true, refunded: false, amount: 2500, amount_refunded: 1000 });
      expect(p.status).toBe('APROVADO');
      expect(p.paidAt).toBe(new Date(1_800_000_500 * 1000).toISOString());
    });

    it('latest_charge nao expandido (so o id) nao inventa estorno', async () => {
      const p = await consultar('ch_1');
      expect(p.status).toBe('APROVADO');
    });

    it('intent nao aprovado nunca vira ESTORNADO, mesmo com charge marcada', async () => {
      const retrieve = vi.fn().mockResolvedValue(
        intent({ status: 'requires_action', latest_charge: { refunded: true, amount: 2500, amount_refunded: 2500 } }),
      );
      const p = await make({ paymentIntents: { retrieve } }).getPayment('pi_1');
      expect(p.status).toBe('PENDENTE');
      expect(p.paidAt).toBeNull();
    });
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

  it('refund devolve taxa e reverte a transferencia (conta propria)', async () => {
    const create = vi.fn().mockResolvedValue({ id: 're_1' });
    const retrieve = vi.fn().mockResolvedValue(intent());
    await make({ refunds: { create }, paymentIntents: { retrieve } }).refund('pi_1', 'idem-1');
    expect(create).toHaveBeenCalledWith(
      { payment_intent: 'pi_1', refund_application_fee: true, reverse_transfer: true },
      { idempotencyKey: 'idem-1' },
    );
  });

  it('refund aceita destination expandido (objeto com id)', async () => {
    const create = vi.fn().mockResolvedValue({ id: 're_1' });
    const retrieve = vi.fn().mockResolvedValue(intent({ transfer_data: { destination: { id: ACCT } } }));
    await make({ refunds: { create }, paymentIntents: { retrieve } }).refund('pi_1', 'idem-1');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('refund de PaymentIntent de outra conta rejeita sem estornar', async () => {
    const create = vi.fn();
    const retrieve = vi.fn().mockResolvedValue(intent({ transfer_data: { destination: 'acct_outra' } }));
    await expect(
      make({ refunds: { create }, paymentIntents: { retrieve } }).refund('pi_1', 'idem-1'),
    ).rejects.toBeInstanceOf(PspRejectedError);
    expect(create).not.toHaveBeenCalled();
  });

  it('refund classifica falha do retrieve', async () => {
    const create = vi.fn();
    const retrieve = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { statusCode: 503 }));
    await expect(
      make({ refunds: { create }, paymentIntents: { retrieve } }).refund('pi_1', 'idem-1'),
    ).rejects.toBeInstanceOf(PspUnavailableError);
    expect(create).not.toHaveBeenCalled();
  });

  describe('failedRefunds (estorno que falhou depois de aceito)', () => {
    const refund = (over: Record<string, unknown> = {}) => ({
      id: 're_1',
      object: 'refund',
      status: 'succeeded',
      amount: 2500,
      payment_intent: 'pi_1',
      // Campos que NUNCA podem sair do gateway (dados do comprador / instrucoes).
      destination_details: { pix: { bank: 'Banco X' } },
      instructions_email: 'maria@example.com',
      ...over,
    });

    it('confere a conta, lista os estornos DO PaymentIntent e devolve so os failed, sem dado pessoal', async () => {
      const retrieve = vi.fn().mockResolvedValue(intent({ status: 'succeeded' }));
      const list = vi.fn().mockResolvedValue({
        data: [
          refund({ id: 're_ok', status: 'succeeded' }),
          refund({ id: 're_fail', status: 'failed', failure_reason: 'expired_or_canceled_card', amount: 2500 }),
          refund({ id: 're_pend', status: 'pending' }),
        ],
      });
      const out = await make({ paymentIntents: { retrieve }, refunds: { list } }).failedRefunds('pi_1');
      expect(retrieve).toHaveBeenCalledWith('pi_1');
      expect(list).toHaveBeenCalledWith({ payment_intent: 'pi_1', limit: 100 });
      expect(out).toEqual([{ refundId: 're_fail', amountCents: 2500, failureReason: 'expired_or_canceled_card' }]);
    });

    it('failure_reason fora do formato de codigo (ou ausente) vira null', async () => {
      const retrieve = vi.fn().mockResolvedValue(intent());
      const list = vi.fn().mockResolvedValue({
        data: [refund({ status: 'failed', failure_reason: 'Conta 1234-5 do Fulano' }), refund({ id: 're_2', status: 'failed' })],
      });
      const out = await make({ paymentIntents: { retrieve }, refunds: { list } }).failedRefunds('pi_1');
      expect(out.map((r) => r.failureReason)).toEqual([null, null]);
    });

    it('PaymentIntent de outra conta: rejeita SEM listar estornos', async () => {
      const retrieve = vi.fn().mockResolvedValue(intent({ transfer_data: { destination: 'acct_outra' } }));
      const list = vi.fn();
      await expect(make({ paymentIntents: { retrieve }, refunds: { list } }).failedRefunds('pi_1')).rejects.toBeInstanceOf(
        PspRejectedError,
      );
      expect(list).not.toHaveBeenCalled();
    });

    it('classifica falhas da Stripe (5xx = transitorio)', async () => {
      const retrieve = vi.fn().mockResolvedValue(intent());
      const list = vi.fn().mockRejectedValue(Object.assign(new Error(`x ${KEY}`), { statusCode: 503 }));
      const p = make({ paymentIntents: { retrieve }, refunds: { list } }).failedRefunds('pi_1');
      await expect(p).rejects.toBeInstanceOf(PspUnavailableError);
      await expect(p).rejects.not.toThrow(KEY);
    });
  });

  it('expires_at tem teto de agora + 1209600 s (14 dias)', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-15T12:00:00Z') });
    const create = vi.fn().mockResolvedValue(intent());
    await make({ paymentIntents: { create } }).createPixCharge({
      ...input,
      expiresAt: new Date(Date.now() + 40 * 86_400_000),
    });
    expect((create.mock.calls[0] as any)[0].payment_method_options.pix.expires_at).toBe(Math.floor(Date.now() / 1000) + 1_209_600);
  });

  it('nao envia application_fee_amount com taxa ausente ou zero', async () => {
    for (const fee of [undefined, 0]) {
      const create = vi.fn().mockResolvedValue(intent());
      const rest: Omit<typeof input, 'platformFeeCents'> & { platformFeeCents?: number } = { ...input };
      delete rest.platformFeeCents;
      await make({ paymentIntents: { create } }).createPixCharge(fee === undefined ? rest : { ...rest, platformFeeCents: fee });
      expect((create.mock.calls[0] as any)[0]).not.toHaveProperty('application_fee_amount');
    }
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
