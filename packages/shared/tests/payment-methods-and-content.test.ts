import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROGRESS_MODE,
  PAYMENT_METHOD_KINDS,
  PAYMENT_METHOD_POLICY,
  createDrawRequestSchema,
  drawCustomizationInputSchema,
  mapProviderPaymentType,
  recordDeliveryRequestSchema,
  resolvePaymentMethods,
  type PaymentMethodKind,
} from '../src/index.js';

describe('meios de pagamento · politica x o que o provedor oferece', () => {
  it('a politica de hoje liga SO o PIX; boleto tem motivo proprio', () => {
    const ligados = PAYMENT_METHOD_KINDS.filter((k) => PAYMENT_METHOD_POLICY[k].platformEnabled);
    expect(ligados).toEqual(['PIX']);
    expect(PAYMENT_METHOD_POLICY.BOLETO.disabledReason).toBe('RESERVATION_WINDOW_UNDEFINED');
  });

  it('o provedor listar um meio NAO o habilita', () => {
    const todos = new Set<PaymentMethodKind>(PAYMENT_METHOD_KINDS);
    const r = resolvePaymentMethods(todos);
    expect(r.filter((m) => m.enabled).map((m) => m.kind)).toEqual(['PIX']);
    expect(r.every((m) => m.providerReported)).toBe(true);
  });

  it('PIX so liga se a conta do vendedor o oferece', () => {
    const r = resolvePaymentMethods(new Set<PaymentMethodKind>(['CREDIT_CARD']));
    expect(r.find((m) => m.kind === 'PIX')).toEqual({
      kind: 'PIX',
      providerReported: false,
      enabled: false,
      reason: 'NOT_REPORTED_BY_PROVIDER',
    });
    expect(r.some((m) => m.enabled)).toBe(false);
  });

  it('traduz o vocabulario do Mercado Pago', () => {
    expect(mapProviderPaymentType('bank_transfer', 'pix')).toBe('PIX');
    expect(mapProviderPaymentType('credit_card', 'visa')).toBe('CREDIT_CARD');
    expect(mapProviderPaymentType('debit_card', 'maestro')).toBe('DEBIT_CARD');
    expect(mapProviderPaymentType('prepaid_card', 'x')).toBe('DEBIT_CARD');
    expect(mapProviderPaymentType('account_money', 'account_money')).toBe('ACCOUNT_MONEY');
    expect(mapProviderPaymentType('ticket', 'bolbradesco')).toBe('BOLETO');
    expect(mapProviderPaymentType('digital_currency', 'x')).toBe('OTHER');
    expect(mapProviderPaymentType(undefined, undefined)).toBe('OTHER');
  });
});

describe('personalizacao do sorteio e entrega · formas de entrada', () => {
  it('padrao de progresso e "faltam X"', () => {
    expect(DEFAULT_PROGRESS_MODE).toBe('FALTAM');
  });

  it('personalizacao: aceita o que a vitrine honra e recusa o resto', () => {
    expect(drawCustomizationInputSchema.safeParse({}).success).toBe(true);
    expect(drawCustomizationInputSchema.safeParse({ progressMode: 'OCULTAR', headline: 'Oi', ctaLabel: 'Comprar' }).success).toBe(true);
    expect(drawCustomizationInputSchema.safeParse({ banner: 'https://x/y.png' }).success).toBe(false);
    expect(drawCustomizationInputSchema.safeParse({ progressMode: 'NUNCA' }).success).toBe(false);
  });

  it('criacao aceita subtitulo, categoria, regulamento e valor estimado por premio', () => {
    const r = createDrawRequestSchema.safeParse({
      title: 'Sorteio',
      subtitle: 'Sub',
      category: 'Veículos',
      regulation: 'Regulamento.',
      prizes: [{ name: 'Moto', estimatedValueCents: 100 }],
      ticketPriceCents: 1000,
      totalNumbers: 100,
    });
    expect(r.success).toBe(true);
    expect(createDrawRequestSchema.safeParse({ title: 'Sorteio', prizes: [{ name: 'Moto', estimatedValueCents: -5 }], ticketPriceCents: 1000, totalNumbers: 100 }).success).toBe(false);
  });

  it('entrega: forma conhecida, data ISO e autorizacao de imagem explicita', () => {
    const ok = { method: 'RETIRADA', deliveredAt: '2030-01-01T10:00:00Z', winnerImageAuthorized: false };
    expect(recordDeliveryRequestSchema.safeParse(ok).success).toBe(true);
    expect(recordDeliveryRequestSchema.safeParse({ ...ok, method: 'DRONE' }).success).toBe(false);
    expect(recordDeliveryRequestSchema.safeParse({ ...ok, deliveredAt: 'ontem' }).success).toBe(false);
    // Sem o campo, a autorizacao NAO e presumida.
    expect(
      recordDeliveryRequestSchema.safeParse({ method: ok.method, deliveredAt: ok.deliveredAt }).success,
    ).toBe(false);
  });
});
