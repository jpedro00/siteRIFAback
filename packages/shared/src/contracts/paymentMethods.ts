import { z } from 'zod';

/**
 * Meios de pagamento dos participantes. M05.
 *
 * ARQUITETURA POR CAPACIDADES
 * ---------------------------
 *   PaymentProvider  -> PaymentAccount  -> PaymentMethod
 *   (Mercado Pago)      (conta conectada     (PIX, cartao, saldo, ...)
 *                        pela comunidade)
 *
 * O provedor INFORMA o que a conta do vendedor aceita. A plataforma decide o que
 * LIGA. Nenhum meio e habilitado so porque o provedor o lista: a disponibilidade
 * junta (1) o que a conta reporta e (2) a politica do Clube da Rifa.
 *
 * HOJE: somente PIX esta habilitado. Os demais aparecem para o organizador com o
 * motivo exato de estarem desligados — nao ha botao nem fluxo falso.
 *
 *   * CARTAO / SALDO / OUTROS: exigem tokenizacao do PSP no navegador (o backend
 *     nunca toca dado bruto de cartao) e um fluxo de confirmacao proprio.
 *   * BOLETO: o prazo de pagamento (dias) e incompativel com a reserva de 30 min
 *     (RN05). Antes de ligar e preciso modelar prazo, reserva do numero, expiracao,
 *     conflito com outro comprador e fechamento do sorteio. Sem essa politica, fica
 *     DESLIGADO.
 *
 * RN06 vale para todos: pagamento so conta depois de consultado no PSP.
 */
export const PAYMENT_METHOD_KINDS = [
  'PIX',
  'CREDIT_CARD',
  'DEBIT_CARD',
  'ACCOUNT_MONEY',
  'BOLETO',
  'OTHER',
] as const;
export type PaymentMethodKind = (typeof PAYMENT_METHOD_KINDS)[number];

/** Por que um meio esta (des)ligado. Vocabulario fechado: a tela escolhe o texto. */
export const PAYMENT_METHOD_REASONS = [
  'ENABLED',
  /** A politica liga, mas a conta do vendedor nao oferece. */
  'NOT_REPORTED_BY_PROVIDER',
  /** A conta oferece, mas a plataforma ainda nao implementou o fluxo. */
  'NOT_SUPPORTED_YET',
  /** Boleto: falta politica de prazo x reserva x fechamento. */
  'RESERVATION_WINDOW_UNDEFINED',
  /** O criador desligou um meio que a plataforma e a conta oferecem. */
  'DISABLED_BY_CREATOR',
] as const;
export type PaymentMethodReason = (typeof PAYMENT_METHOD_REASONS)[number];

/**
 * Politica da PLATAFORMA: o que pode ser ligado e, quando nao pode, por que.
 * Unica fonte; a API e os paineis leem daqui.
 */
export const PAYMENT_METHOD_POLICY: Readonly<
  Record<PaymentMethodKind, { readonly platformEnabled: boolean; readonly disabledReason: PaymentMethodReason }>
> = Object.freeze({
  PIX: { platformEnabled: true, disabledReason: 'ENABLED' },
  CREDIT_CARD: { platformEnabled: false, disabledReason: 'NOT_SUPPORTED_YET' },
  DEBIT_CARD: { platformEnabled: false, disabledReason: 'NOT_SUPPORTED_YET' },
  ACCOUNT_MONEY: { platformEnabled: false, disabledReason: 'NOT_SUPPORTED_YET' },
  BOLETO: { platformEnabled: false, disabledReason: 'RESERVATION_WINDOW_UNDEFINED' },
  OTHER: { platformEnabled: false, disabledReason: 'NOT_SUPPORTED_YET' },
});

export const paymentMethodAvailabilitySchema = z.object({
  kind: z.enum(PAYMENT_METHOD_KINDS),
  /** A conta conectada informa que oferece este meio. */
  providerReported: z.boolean(),
  /** Liga de verdade: politica da plataforma E conta que oferece. */
  enabled: z.boolean(),
  reason: z.enum(PAYMENT_METHOD_REASONS),
});
export type PaymentMethodAvailability = z.infer<typeof paymentMethodAvailabilitySchema>;

export const paymentMethodsResponseSchema = z.object({
  /**
   * OK            conta conectada e consultada;
   * NO_ACCOUNT    a comunidade nao tem conta conectada;
   * UNAVAILABLE   a conta existe, mas o provedor nao respondeu agora.
   */
  status: z.enum(['OK', 'NO_ACCOUNT', 'UNAVAILABLE']),
  provider: z.literal('MERCADO_PAGO').nullable(),
  accountId: z.string().uuid().nullable(),
  methods: z.array(paymentMethodAvailabilitySchema),
  checkedAt: z.string(),
});
export type PaymentMethodsResponse = z.infer<typeof paymentMethodsResponseSchema>;

/** Mapeia o que o provedor chama de tipo de pagamento para o nosso vocabulario. */
export function mapProviderPaymentType(
  paymentTypeId: string | undefined,
  methodId: string | undefined,
): PaymentMethodKind {
  const tipo = (paymentTypeId ?? '').toLowerCase();
  const id = (methodId ?? '').toLowerCase();
  if (id === 'pix') return 'PIX';
  switch (tipo) {
    case 'credit_card':
      return 'CREDIT_CARD';
    case 'debit_card':
    case 'prepaid_card':
      return 'DEBIT_CARD';
    case 'account_money':
      return 'ACCOUNT_MONEY';
    case 'ticket':
    case 'atm':
      return 'BOLETO';
    default:
      return 'OTHER';
  }
}

/**
 * Junta o que a conta reporta com a politica. Funcao PURA: a API a chama com o
 * resultado do provedor; os testes a chamam com listas montadas a mao.
 */
export function resolvePaymentMethods(
  reported: ReadonlySet<PaymentMethodKind>,
  disabledByCreator: ReadonlySet<PaymentMethodKind> = new Set(),
): PaymentMethodAvailability[] {
  return PAYMENT_METHOD_KINDS.map((kind): PaymentMethodAvailability => {
    const politica = PAYMENT_METHOD_POLICY[kind];
    const providerReported = reported.has(kind);
    if (!politica.platformEnabled) {
      return { kind, providerReported, enabled: false, reason: politica.disabledReason };
    }
    if (providerReported && disabledByCreator.has(kind)) {
      return { kind, providerReported, enabled: false, reason: 'DISABLED_BY_CREATOR' };
    }
    return providerReported
      ? { kind, providerReported, enabled: true, reason: 'ENABLED' }
      : { kind, providerReported, enabled: false, reason: 'NOT_REPORTED_BY_PROVIDER' };
  });
}

/** Meios que o CRIADOR pode ligar/desligar: so os que a plataforma suporta de verdade. */
export function creatorTogglableMethods(): PaymentMethodKind[] {
  return PAYMENT_METHOD_KINDS.filter((k) => PAYMENT_METHOD_POLICY[k].platformEnabled);
}

export const setPaymentMethodRequestSchema = z.object({
  method: z.enum(PAYMENT_METHOD_KINDS),
  /** `true` liga, `false` desliga. Ligar so vale para meio suportado pela plataforma. */
  enabled: z.boolean(),
});
export type SetPaymentMethodRequest = z.infer<typeof setPaymentMethodRequestSchema>;
