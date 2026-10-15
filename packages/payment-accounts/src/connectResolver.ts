import type Stripe from 'stripe';
import { withTenant, type DbPool } from '@clubedarifa/db';
import {
  PaymentAccountUnavailableError,
  PaymentsNotConfiguredError,
  StripeConnectGateway,
  type PspGateway,
  type PspGatewayResolver,
  type PspResolution,
  type WebhookVerification,
} from '@clubedarifa/psp';
import type { PaymentEnvironment } from '@clubedarifa/shared';

/**
 * Resolve o PSP Stripe Connect PELA COMUNIDADE.
 *
 * Sequencia: comunidade -> vinculo STRIPE que recebe (ou o vinculo ORIGINAL do pagamento) ->
 * `acct_...` da conta conectada -> `StripeConnectGateway` amarrado a ele. A chave e da
 * PLATAFORMA (uma so); o que muda por comunidade e so a conta de destino.
 *
 * Sem conta: `PaymentsNotConfiguredError`. Conta ligada mas com cadastro incompleto
 * (`charges_enabled` falso ou ainda desconhecido): `PaymentAccountUnavailableError('NOT_READY')`
 * — e nenhuma cobranca e criada.
 */

export interface ConnectResolverOptions {
  readonly pool: DbPool;
  readonly environment: PaymentEnvironment;
  readonly secretKey: string;
  readonly allowLive?: boolean | undefined;
  /** Cliente Stripe compartilhado (um por processo). */
  readonly client: Stripe;
}

interface ReceivingRow {
  id: string;
  status: string;
  authorization_status: string;
  provider_account_id: string;
  charges_enabled: boolean | null;
}

interface CredentialRow {
  usable: boolean;
  reason: string;
  provider: string | null;
  provider_account_id: string | null;
}

export class ConnectPspGatewayResolver implements PspGatewayResolver {
  readonly provider = 'STRIPE' as const;
  readonly #o: ConnectResolverOptions;

  constructor(options: ConnectResolverOptions) {
    this.#o = options;
  }

  async forTenant(tenantId: string): Promise<PspResolution> {
    const row = await withTenant(this.#o.pool, { tenantId }, async (client) => {
      // A vinculada (CONNECTED) primeiro; senao a mais recente, para saber se ela CAIU.
      const { rows } = await client.query<ReceivingRow>(
        `SELECT id, status::text AS status, authorization_status::text AS authorization_status,
                provider_account_id, charges_enabled
           FROM app.payment_account_overview($1)
          WHERE provider = 'STRIPE' AND environment = $2::payment_environment
          ORDER BY (status = 'CONNECTED') DESC, connected_at DESC
          LIMIT 1`,
        [tenantId, this.#o.environment],
      );
      return rows[0] ?? null;
    });

    if (!row) throw new PaymentsNotConfiguredError();
    if (row.status === 'REVOKED' || row.status === 'ERROR') throw new PaymentAccountUnavailableError(row.status);
    if (row.status !== 'CONNECTED') throw new PaymentsNotConfiguredError();
    if (row.authorization_status !== 'ACTIVE') {
      throw new PaymentAccountUnavailableError(`AUTHORIZATION_${row.authorization_status}`);
    }
    // Cadastro na Stripe ainda incompleto: nao cobra.
    if (row.charges_enabled !== true) throw new PaymentAccountUnavailableError('NOT_READY');
    return { gateway: this.#gateway(row.provider_account_id), paymentAccountId: row.id };
  }

  async forPayment(input: { tenantId: string; paymentAccountId: string | null }): Promise<PspResolution> {
    if (!input.paymentAccountId) throw new PaymentAccountUnavailableError('NO_ACCOUNT');
    // Mesma porta do Mercado Pago: so a propria comunidade, conta CONNECTED ou DISCONNECTING.
    const creds = await withTenant(this.#o.pool, { tenantId: input.tenantId }, async (client) => {
      const { rows } = await client.query<CredentialRow>(
        `SELECT usable, reason, provider::text AS provider, provider_account_id
           FROM app.get_payment_credentials($1, $2, 'SETTLE')`,
        [input.tenantId, input.paymentAccountId],
      );
      return rows[0]!;
    });
    if (!creds.usable) throw new PaymentAccountUnavailableError(creds.reason);
    if (creds.provider !== 'STRIPE' || !creds.provider_account_id) {
      throw new PaymentAccountUnavailableError('WRONG_PROVIDER');
    }
    return { gateway: this.#gateway(creds.provider_account_id), paymentAccountId: input.paymentAccountId };
  }

  /** O webhook Connect tem rota e segredo proprios; este resolvedor nao o valida. */
  verifyWebhook(_input: Parameters<PspGateway['verifyWebhook']>[0]): WebhookVerification {
    return { valid: false, reason: 'use o webhook Connect' };
  }

  #gateway(connectedAccountId: string): StripeConnectGateway {
    return new StripeConnectGateway({
      secretKey: this.#o.secretKey,
      connectedAccountId,
      allowLive: this.#o.allowLive === true,
      client: this.#o.client,
    });
  }
}
