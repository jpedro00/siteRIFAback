import type { PspGateway } from './types.js';

export * from './types.js';
export { MercadoPagoGateway, verifyMercadoPagoWebhook, type MercadoPagoOptions } from './mercadopago.js';

/**
 * NAO existe `createPspGateway(config)` com uma credencial global.
 *
 * Cada comunidade conecta a PROPRIA conta Mercado Pago por OAuth, e o gateway de cada uma e
 * resolvido por `PspGatewayResolver` (implementado em `@clubedarifa/payment-accounts`). O unico
 * segredo que sobra no ambiente e o de ASSINATURA DO WEBHOOK, que pertence a aplicacao da
 * plataforma — ele verifica avisos, nunca cria nem consulta cobranca.
 *
 * O PSP falso dos testes vive em `@clubedarifa/psp/testing` e nenhuma variavel o liga.
 */
export type { PspGateway };
