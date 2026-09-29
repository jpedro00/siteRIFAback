import type { AppConfig } from '../config.js';
import { MercadoPagoGateway } from './mercadopago.js';
import type { PspGateway } from './types.js';

export * from './types.js';
export { MercadoPagoGateway } from './mercadopago.js';

/**
 * Monta o PSP a partir da configuracao. `null` = nenhum provedor ligado.
 *
 * O provedor FALSO nao existe aqui, de proposito: ele vive so na bancada de
 * testes e e injetado la. Nenhuma variavel de ambiente o liga em producao.
 */
export function createPspGateway(config: AppConfig): PspGateway | null {
  if (config.PSP_PROVIDER === 'mercadopago') {
    return new MercadoPagoGateway({
      accessToken: config.MERCADOPAGO_ACCESS_TOKEN!,
      webhookSecret: config.MERCADOPAGO_WEBHOOK_SECRET!,
      fallbackPayerEmail: config.MERCADOPAGO_FALLBACK_PAYER_EMAIL,
    });
  }
  return null;
}
