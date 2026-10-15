import type { DbPool } from '@clubedarifa/db';
import { createConnectRuntime, type ConnectRuntime } from '@clubedarifa/payment-accounts';
import type { AppConfig } from '../../config.js';
import { log } from '../../lib/log.js';

/**
 * Monta o recebimento via Stripe Connect a partir da configuracao. `null` = desligado
 * (`CONNECT_ENABLED=false`, o padrao).
 *
 * Ambiente: `NODE_ENV=production` = PRODUCTION; qualquer outro = SANDBOX. A configuracao ja
 * recusa chave live fora de producao (e chave de teste em producao com o Connect ligado); o
 * runtime confere chave x ambiente de novo e, se nao combinarem, a API NAO sobe — o erro sai
 * daqui, com mensagem propria, sem a chave.
 */
export function createConnect(config: AppConfig, pool: DbPool): ConnectRuntime | null {
  if (!config.CONNECT_ENABLED) return null;

  const returnBaseUrl = config.ORGANIZER_PANEL_URL ?? config.BILLING_RETURN_URL;
  if (!config.STRIPE_SECRET_KEY || !returnBaseUrl || connectWebhookSecrets(config).length === 0) {
    // A configuracao ja barra isto; a checagem repetida evita um `!` cego.
    throw new Error('Stripe Connect ligado sem STRIPE_SECRET_KEY, STRIPE_CONNECT_WEBHOOK_SECRET ou URL do painel.');
  }

  const production = config.NODE_ENV === 'production';
  try {
    return createConnectRuntime(pool, {
      secretKey: config.STRIPE_SECRET_KEY,
      returnBaseUrl,
      environment: production ? 'PRODUCTION' : 'SANDBOX',
      allowLive: production,
      log,
    });
  } catch (error) {
    // A mensagem do runtime e fixa (nunca cita a chave); repassa o motivo para a subida.
    throw new Error(
      `Stripe Connect nao pode subir: ${error instanceof Error ? error.message : 'configuracao invalida'}`,
    );
  }
}

/** Os segredos do webhook Connect (um por endpoint na Stripe). */
export function connectWebhookSecrets(config: AppConfig): string[] {
  return (config.STRIPE_CONNECT_WEBHOOK_SECRET ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}
