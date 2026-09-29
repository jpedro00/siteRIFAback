import { MercadoPagoGateway } from './mercadopago.js';
import type { PspGateway } from './types.js';

export * from './types.js';
export { MercadoPagoGateway } from './mercadopago.js';

/** O recorte da configuracao que o PSP precisa. Vale para a API e para o worker. */
export interface PspConfig {
  readonly PSP_PROVIDER: 'none' | 'mercadopago';
  readonly MERCADOPAGO_ACCESS_TOKEN?: string | undefined;
  readonly MERCADOPAGO_WEBHOOK_SECRET?: string | undefined;
  readonly MERCADOPAGO_FALLBACK_PAYER_EMAIL?: string | undefined;
}

/**
 * Monta o PSP a partir da configuracao. `null` = nenhum provedor ligado.
 *
 * O provedor FALSO nao existe aqui, de proposito: ele vive so em
 * `@clubedarifa/psp/testing` e e injetado pelos testes. Nenhuma variavel de
 * ambiente o liga em producao.
 */
export function createPspGateway(config: PspConfig): PspGateway | null {
  if (config.PSP_PROVIDER === 'mercadopago') {
    return new MercadoPagoGateway({
      accessToken: config.MERCADOPAGO_ACCESS_TOKEN!,
      webhookSecret: config.MERCADOPAGO_WEBHOOK_SECRET!,
      fallbackPayerEmail: config.MERCADOPAGO_FALLBACK_PAYER_EMAIL,
    });
  }
  return null;
}
