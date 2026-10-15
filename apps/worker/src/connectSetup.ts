import type { DbPool } from '@clubedarifa/db';
import { createConnectRuntimeFromConfig, type ConnectRuntime } from '@clubedarifa/payment-accounts';
import type { WorkerConfig } from './config.js';
import { log } from './lib/log.js';

/**
 * Stripe Connect no worker. `null` = desligado (`CONNECT_ENABLED=false`, o padrao): os jobs de PIX
 * seguem so com o Mercado Pago, como antes.
 *
 * Mesma montagem da API (`createConnectRuntimeFromConfig`): ambiente pelo `NODE_ENV`, chave live
 * so em producao, e chave x ambiente conferidos de novo — divergiu, o worker nao sobe. Aqui SEM URL
 * de retorno: o worker nao faz cadastro de conta (so resolve o gateway da conta ORIGINAL de um
 * pagamento para consultar a Stripe), e `beginOnboarding` neste runtime recusa.
 */
export function createWorkerConnect(config: WorkerConfig, pool: DbPool): ConnectRuntime | null {
  return createConnectRuntimeFromConfig(pool, {
    enabled: config.CONNECT_ENABLED,
    secretKey: config.STRIPE_SECRET_KEY,
    nodeEnv: config.NODE_ENV,
    log,
  });
}
