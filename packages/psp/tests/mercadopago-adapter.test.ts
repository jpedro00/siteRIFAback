import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MercadoPagoGateway } from '../src/mercadopago.js';
import { PspRejectedError, PspUnavailableError } from '../src/types.js';

/**
 * Adaptador do Mercado Pago, sem rede: `fetch` e substituido.
 *
 * O que se protege: o formato do pedido ao PSP (valor em reais com arredondamento
 * correto, chave de idempotencia, prazo), o mapa de estados, a diferenca entre
 * "PSP fora" (tentar de novo) e "PSP recusou" (nao adianta), e a ASSINATURA do
 * webhook — a unica coisa que separa um aviso legitimo de um forjado.
 */

const SECRET = 'segredo-de-teste';

interface Chamada {
  url: string;
  init: NonNullable<Parameters<typeof fetch>[1]> & { headers: Record<string, string> };
}

function gatewayComResposta(resposta: () => Response | Promise<Response> | never, chamadas: Chamada[] = []) {
  return new MercadoPagoGateway({
    accessToken: 'TOKEN-SECRETO',
    webhookSecret: SECRET,
    fallbackPayerEmail: 'reserva@exemplo.com',
    fetchImpl: async (url, init) => {
      chamadas.push({ url, init: init as Chamada['init'] });
      return resposta();
    },
  });
}

function json(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });
}

const pixPendente = {
  id: 123456789,
  status: 'pending',
  transaction_amount: 15.5,
  external_reference: 'pedido-1',
  date_of_expiration: '2030-01-01T10:00:00.000+00:00',
  point_of_interaction: { transaction_data: { qr_code: '000201PIX', qr_code_base64: 'QUJD' } },
};

const cobranca = {
  idempotencyKey: 'pedido-1',
  amountCents: 1550,
  description: 'Pedido',
  externalReference: 'pedido-1',
  payerEmail: 'maria@example.com',
  payerName: 'Maria',
  expiresAt: new Date('2030-01-01T10:00:00.000Z'),
  notificationUrl: 'https://api.exemplo.com/api/webhooks/mercadopago/minha-comunidade',
};

describe('MercadoPagoGateway · criar cobranca PIX', () => {
  it('envia valor em reais, PIX, referencia, prazo e a chave de idempotencia', async () => {
    const chamadas: Chamada[] = [];
    const gw = gatewayComResposta(() => json(201, pixPendente), chamadas);

    const pagamento = await gw.createPixCharge(cobranca);

    expect(chamadas).toHaveLength(1);
    const { url, init } = chamadas[0]!;
    expect(url).toBe('https://api.mercadopago.com/v1/payments');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Idempotency-Key']).toBe('pedido-1');
    expect(init.headers['Authorization']).toBe('Bearer TOKEN-SECRETO');

    const corpo = JSON.parse(init.body as string);
    expect(corpo).toMatchObject({
      transaction_amount: 15.5,
      payment_method_id: 'pix',
      external_reference: 'pedido-1',
      date_of_expiration: '2030-01-01T10:00:00.000+00:00',
      payer: { email: 'maria@example.com', first_name: 'Maria' },
      notification_url: 'https://api.exemplo.com/api/webhooks/mercadopago/minha-comunidade',
    });

    expect(pagamento).toMatchObject({
      providerPaymentId: '123456789',
      status: 'PENDENTE',
      amountCents: 1550,
      externalReference: 'pedido-1',
      copyPaste: '000201PIX',
      qrCodeBase64: 'QUJD',
    });
  });

  it('a credencial nunca aparece no corpo nem no resultado', async () => {
    const gw = gatewayComResposta(() => json(201, pixPendente));
    const pagamento = await gw.createPixCharge(cobranca);
    expect(JSON.stringify(pagamento)).not.toContain('TOKEN-SECRETO');
  });

  it('sem e-mail do comprador usa o e-mail de reserva configurado', async () => {
    const chamadas: Chamada[] = [];
    const gw = gatewayComResposta(() => json(201, pixPendente), chamadas);
    await gw.createPixCharge({ ...cobranca, payerEmail: null });
    expect(JSON.parse(chamadas[0]!.init.body as string).payer.email).toBe('reserva@exemplo.com');
  });

  it('sem e-mail e sem reserva configurada: recusa antes de chamar a rede', async () => {
    const chamadas: Chamada[] = [];
    const gw = new MercadoPagoGateway({
      accessToken: 't',
      webhookSecret: SECRET,
      fetchImpl: async (url, init) => {
        chamadas.push({ url, init: init as Chamada['init'] });
        return json(201, pixPendente);
      },
    });
    await expect(gw.createPixCharge({ ...cobranca, payerEmail: null })).rejects.toBeInstanceOf(PspRejectedError);
    expect(chamadas).toHaveLength(0);
  });

  it('sem URL de notificacao, o campo nao e enviado', async () => {
    const chamadas: Chamada[] = [];
    const gw = gatewayComResposta(() => json(201, pixPendente), chamadas);
    await gw.createPixCharge({ ...cobranca, notificationUrl: null });
    expect(JSON.parse(chamadas[0]!.init.body as string)).not.toHaveProperty('notification_url');
  });

  it('5xx, 429, falha de rede e resposta que nao e JSON sao "indisponivel" (tentar de novo)', async () => {
    for (const resposta of [() => json(500, {}), () => json(503, {}), () => json(429, {})]) {
      await expect(gatewayComResposta(resposta).createPixCharge(cobranca)).rejects.toBeInstanceOf(
        PspUnavailableError,
      );
    }
    const rede = gatewayComResposta(() => {
      throw new TypeError('fetch failed');
    });
    await expect(rede.createPixCharge(cobranca)).rejects.toBeInstanceOf(PspUnavailableError);

    const lixo = gatewayComResposta(() => new Response('<html>', { status: 200 }));
    await expect(lixo.createPixCharge(cobranca)).rejects.toBeInstanceOf(PspUnavailableError);
  });

  it('4xx e "recusado" (nao adianta repetir)', async () => {
    const gw = gatewayComResposta(() => json(400, { message: 'invalid' }));
    await expect(gw.createPixCharge(cobranca)).rejects.toBeInstanceOf(PspRejectedError);
  });
});

describe('MercadoPagoGateway · consultar pagamento e mapa de estados', () => {
  const casos: [string, string | undefined, string][] = [
    ['pending', undefined, 'PENDENTE'],
    ['in_process', undefined, 'PENDENTE'],
    ['approved', 'accredited', 'APROVADO'],
    ['rejected', 'cc_rejected', 'CANCELADO'],
    ['cancelled', 'by_collector', 'CANCELADO'],
    ['cancelled', 'expired', 'EXPIRADO'],
    ['refunded', undefined, 'ESTORNADO'],
    ['charged_back', undefined, 'ESTORNADO'],
  ];

  for (const [status, detail, esperado] of casos) {
    it(`${status}${detail ? `/${detail}` : ''} -> ${esperado}`, async () => {
      const gw = gatewayComResposta(() =>
        json(200, { ...pixPendente, status, status_detail: detail, date_approved: '2030-01-01T09:00:00Z' }),
      );
      expect((await gw.getPayment('123456789')).status).toBe(esperado);
    });
  }

  it('19,99 vira 1999 centavos (sem o erro do ponto flutuante)', async () => {
    const gw = gatewayComResposta(() => json(200, { ...pixPendente, transaction_amount: 19.99 }));
    expect((await gw.getPayment('123456789')).amountCents).toBe(1999);
  });

  it('o identificador entra na URL: so digitos passam', async () => {
    const chamadas: Chamada[] = [];
    const gw = gatewayComResposta(() => json(200, pixPendente), chamadas);
    for (const ruim of ['../admin', '12 34', '1;DROP', '', 'abc']) {
      await expect(gw.getPayment(ruim)).rejects.toBeInstanceOf(PspRejectedError);
    }
    expect(chamadas).toHaveLength(0);
    await gw.getPayment('123456789');
    expect(chamadas[0]!.url).toBe('https://api.mercadopago.com/v1/payments/123456789');
  });

  it('resposta sem id e recusada', async () => {
    const gw = gatewayComResposta(() => json(200, { status: 'approved' }));
    await expect(gw.getPayment('1')).rejects.toBeInstanceOf(PspRejectedError);
  });
});

describe('MercadoPagoGateway · assinatura do webhook', () => {
  const gw = new MercadoPagoGateway({ accessToken: 't', webhookSecret: SECRET });

  function assinar(manifesto: string, secret = SECRET): string {
    return createHmac('sha256', secret).update(manifesto).digest('hex');
  }

  function aviso(over: { id?: string; requestId?: string; ts?: string; secret?: string; v1?: string } = {}) {
    const id = over.id ?? '987654321';
    const requestId = over.requestId ?? 'req-abc';
    const ts = over.ts ?? '1700000000';
    const manifesto = `id:${id.toLowerCase()};request-id:${requestId};ts:${ts};`;
    return {
      headers: {
        'x-signature': `ts=${ts},v1=${over.v1 ?? assinar(manifesto, over.secret)}`,
        'x-request-id': requestId,
      },
      query: { 'data.id': id },
      body: { type: 'payment', data: { id } },
    };
  }

  it('aviso assinado corretamente e aceito, com o id do pagamento', () => {
    expect(gw.verifyWebhook(aviso())).toEqual({ valid: true, isPaymentEvent: true, paymentId: '987654321' });
  });

  it('segredo errado, ts adulterado, id adulterado ou request-id adulterado: recusado', () => {
    expect(gw.verifyWebhook(aviso({ secret: 'outro' })).valid).toBe(false);

    const base = aviso();
    expect(
      gw.verifyWebhook({ ...base, headers: { ...base.headers, 'x-signature': base.headers['x-signature'].replace('ts=1700000000', 'ts=1700000001') } })
        .valid,
    ).toBe(false);
    expect(gw.verifyWebhook({ ...base, query: { 'data.id': '111' } }).valid).toBe(false);
    expect(gw.verifyWebhook({ ...base, headers: { ...base.headers, 'x-request-id': 'outro' } }).valid).toBe(false);
  });

  it('sem cabecalho, ou cabecalho incompleto: recusado', () => {
    expect(gw.verifyWebhook({ headers: {}, query: {}, body: {} }).valid).toBe(false);
    expect(gw.verifyWebhook({ headers: { 'x-signature': 'ts=1' }, query: {}, body: {} }).valid).toBe(false);
    expect(gw.verifyWebhook({ headers: { 'x-signature': 'v1=abc' }, query: {}, body: {} }).valid).toBe(false);
  });

  it('v1 de tamanho diferente e recusado sem lancar', () => {
    expect(gw.verifyWebhook(aviso({ v1: 'curto' })).valid).toBe(false);
  });

  it('o id alfanumerico e assinado em minusculas', () => {
    const r = gw.verifyWebhook(aviso({ id: 'ABC123' }));
    expect(r).toMatchObject({ valid: true, paymentId: 'ABC123' });
  });

  it('aviso valido de outro tipo nao e evento de pagamento', () => {
    const a = aviso();
    expect(gw.verifyWebhook({ ...a, body: { type: 'plan', data: { id: '987654321' } } })).toMatchObject({
      valid: true,
      isPaymentEvent: false,
    });
  });

  it('sem data.id na query, o do corpo entra no manifesto', () => {
    const ts = '1700000000';
    const v1 = assinar(`id:555;request-id:r1;ts:${ts};`);
    const r = gw.verifyWebhook({
      headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': 'r1' },
      query: {},
      body: { type: 'payment', data: { id: 555 } },
    });
    expect(r).toMatchObject({ valid: true, paymentId: '555' });
  });
});
