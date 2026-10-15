import type Stripe from 'stripe';
import type { DbPool } from '@clubedarifa/db';
import { createConnectRuntime, type ConnectRuntime } from './connect.js';
import type { Logger } from './core.js';

/**
 * Monta o runtime Connect a partir da configuracao do PROCESSO (API ou worker), com a mesma regra
 * nos dois: `null` = desligado; `NODE_ENV=production` = PRODUCTION (e so ai chave live), qualquer
 * outro = SANDBOX. O runtime confere chave x ambiente de novo; se nao combinarem, o processo NAO
 * sobe — o erro sai daqui com mensagem propria, sem a chave.
 *
 * `returnBaseUrl` so faz sentido onde ha cadastro (a API). O worker nao o passa: o runtime dele so
 * resolve o gateway do pagamento para CONSULTAR a Stripe, e `beginOnboarding` la recusa.
 */
export interface ConnectSetupInput {
  readonly enabled: boolean;
  readonly secretKey: string | undefined;
  readonly nodeEnv: string;
  readonly returnBaseUrl?: string | undefined;
  readonly log?: Logger | undefined;
  /** Para testes: substitui o SDK. */
  readonly client?: Stripe | undefined;
}

export function createConnectRuntimeFromConfig(pool: DbPool, input: ConnectSetupInput): ConnectRuntime | null {
  if (!input.enabled) return null;
  if (!input.secretKey) {
    // A configuracao ja barra isto; a checagem repetida evita um `!` cego.
    throw new Error('Stripe Connect ligado sem STRIPE_SECRET_KEY.');
  }
  const production = input.nodeEnv === 'production';
  try {
    return createConnectRuntime(pool, {
      secretKey: input.secretKey,
      returnBaseUrl: input.returnBaseUrl,
      environment: production ? 'PRODUCTION' : 'SANDBOX',
      allowLive: production,
      client: input.client,
      log: input.log,
    });
  } catch (error) {
    // A mensagem do runtime e fixa (nunca cita a chave); repassa o motivo para a subida.
    throw new Error(
      `Stripe Connect nao pode subir: ${error instanceof Error ? error.message : 'configuracao invalida'}`,
    );
  }
}
