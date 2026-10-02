import { StripeBillingGateway, processStripeEvent } from '@clubedarifa/billing';
import type { DbPool } from '@clubedarifa/db';
import type { AppConfig } from '../../config.js';
import type { BillingDeps } from '../../deps.js';
import { log } from '../../lib/log.js';

/**
 * Monta a cobranca da plataforma a partir da configuracao. `null` = desligada.
 *
 * Chave `live` so passa em producao (a configuracao ja recusa nos outros ambientes; o
 * gateway confere de novo, e nunca aceita evento `livemode` numa instalacao de teste).
 */
export function createBillingDeps(config: AppConfig, pool: DbPool): BillingDeps | null {
  if (config.BILLING_PROVIDER !== 'stripe') return null;

  const gateway = new StripeBillingGateway({
    secretKey: config.STRIPE_SECRET_KEY!,
    webhookSecret: config.STRIPE_WEBHOOK_SECRET!,
    allowLive: config.NODE_ENV === 'production',
  });

  return {
    gateway,
    // Processamento imediato, DEPOIS de responder a Stripe. Erros nao sobem: o evento ja
    // esta gravado e o worker o retoma (recuo, lease vencido).
    schedule: (eventId) => {
      processStripeEvent({ pool, gateway, log }, eventId).catch((error: unknown) => {
        log.error('stripe.inline_processing_failed', {
          event_id: eventId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
  };
}
