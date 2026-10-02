import { withContext, type DbPool } from '@clubedarifa/db';
import type { PspGatewayResolver } from '@clubedarifa/psp';
import type { PaymentEnvironment } from '@clubedarifa/shared';
import { PaymentCredentialCipher } from './cipher.js';
import { beginConnection, completeConnection, type ConnectionResult } from './connection.js';
import type { FetchLike, Logger, PaymentAccountsCore } from './core.js';
import { MercadoPagoOAuthClient } from './mercadoPagoOAuth.js';
import { refreshDueAuthorizations } from './refresh.js';
import { DbPspGatewayResolver } from './resolver.js';

/**
 * O que a API e o worker usam para falar de recebimentos: o resolvedor do PSP por comunidade, a
 * conexao OAuth, a renovacao de tokens e a conclusao das desconexoes.
 */
export interface PaymentAccountsRuntime {
  /** O modulo OAuth esta configurado e autorizado neste ambiente? */
  readonly enabled: boolean;
  readonly environment: PaymentEnvironment;
  readonly resolver: PspGatewayResolver;
  beginConnection(input: { tenantId: string; userId: string }): Promise<{ url: string }>;
  completeConnection(input: {
    state: string | undefined;
    code: string | undefined;
    providerError?: string | undefined;
    sessionUserId: string;
  }): Promise<ConnectionResult>;
  refreshDue(limit?: number): Promise<{ refreshed: number; revoked: number; failed: number }>;
  finalizeDisconnections(limit?: number): Promise<number>;
}

export interface PaymentAccountsConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Chave de cifragem das credenciais (base64, 32 bytes). */
  readonly credentialsKey: string;
  readonly redirectUri: string;
  readonly webhookSecret: string;
  readonly environment: PaymentEnvironment;
  readonly fallbackPayerEmail?: string | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  readonly authBase?: string | undefined;
  readonly apiBase?: string | undefined;
  readonly log?: Logger | undefined;
}

export function createPaymentAccountsRuntime(pool: DbPool, config: PaymentAccountsConfig): PaymentAccountsRuntime {
  const core: PaymentAccountsCore = {
    pool,
    cipher: new PaymentCredentialCipher(config.credentialsKey),
    oauth: new MercadoPagoOAuthClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
      fetchImpl: config.fetchImpl,
      authBase: config.authBase,
      apiBase: config.apiBase,
    }),
    environment: config.environment,
    webhookSecret: config.webhookSecret,
    fallbackPayerEmail: config.fallbackPayerEmail,
    fetchImpl: config.fetchImpl,
    apiBase: config.apiBase,
    log: config.log,
  };

  return {
    enabled: true,
    environment: config.environment,
    resolver: new DbPspGatewayResolver(core),
    beginConnection: (input) => beginConnection(core, input),
    completeConnection: (input) => completeConnection(core, input),
    refreshDue: (limit) => refreshDueAuthorizations(core, limit),
    async finalizeDisconnections(limit = 50) {
      return withContext(pool, { userId: null, tenantId: null, platformAccess: false }, async (client) => {
        const { rows } = await client.query<{ n: number }>('SELECT app.finalize_payment_disconnections($1) AS n', [limit]);
        return rows[0]!.n;
      });
    },
  };
}
