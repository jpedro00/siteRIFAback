import { createPaymentAccountsRuntime, type PaymentAccountsRuntime } from '@clubedarifa/payment-accounts';
import type { DbPool } from '@clubedarifa/db';
import type { AppConfig } from '../../config.js';
import { log } from '../../lib/log.js';

/**
 * Monta o modulo de recebimentos a partir da configuracao. `null` = desligado (padrao).
 *
 * Fica LIGADO so com `PSP_PROVIDER=mercadopago` E todas as variaveis do aplicativo OAuth (a
 * configuracao ja recusa subir com o conjunto pela metade). Nao existe access token global: o
 * que a plataforma guarda e o aplicativo (client id/secret) e o segredo de assinatura do webhook.
 */
export function createPaymentAccounts(config: AppConfig, pool: DbPool): PaymentAccountsRuntime | null {
  if (config.PSP_PROVIDER !== 'mercadopago') return null;

  return createPaymentAccountsRuntime(pool, {
    clientId: config.MERCADOPAGO_OAUTH_CLIENT_ID!,
    clientSecret: config.MERCADOPAGO_OAUTH_CLIENT_SECRET!,
    credentialsKey: config.PAYMENT_CREDENTIALS_KEY!,
    redirectUri: `${config.PUBLIC_API_BASE_URL!}/api/payment-accounts/oauth/callback`,
    webhookSecret: config.MERCADOPAGO_WEBHOOK_SECRET!,
    // Producao so em producao; qualquer outro ambiente fala com o de teste do provedor.
    environment: config.NODE_ENV === 'production' ? 'PRODUCTION' : 'SANDBOX',
    fallbackPayerEmail: config.MERCADOPAGO_FALLBACK_PAYER_EMAIL,
    log,
  });
}
