import { withTenant } from '@clubedarifa/db';
import {
  MercadoPagoGateway,
  PaymentAccountUnavailableError,
  PaymentsNotConfiguredError,
  PspUnauthorizedError,
  verifyMercadoPagoWebhook,
  type CreatePixChargeInput,
  type PspGateway,
  type PspGatewayResolver,
  type PspPayment,
  type PspPaymentMethod,
  type PspResolution,
  type WebhookVerification,
} from '@clubedarifa/psp';
import { tokenAad } from './cipher.js';
import type { PaymentAccountsCore } from './core.js';
import { refreshAuthorization } from './refresh.js';

/**
 * Resolve o PSP PELA COMUNIDADE.
 *
 * Sequencia: comunidade -> conta que recebe (ou a conta ORIGINAL do pagamento) -> autorizacao
 * -> credencial cifrada (entregue so por funcao do banco, so para a propria comunidade) ->
 * gateway amarrado a essa conta. NAO existe caminho para uma credencial global: sem conta,
 * `PaymentsNotConfiguredError`; conta ou autorizacao inutilizavel,
 * `PaymentAccountUnavailableError` — e nenhuma cobranca e criada.
 */

interface CredentialRow {
  usable: boolean;
  reason: string;
  authorization_id: string | null;
  provider: string | null;
  environment: string | null;
  provider_account_id: string | null;
  access_token_encrypted: Buffer | null;
  token_expires_at: Date | null;
  credential_version: number | null;
}

/** Quanto antes do vencimento o token e renovado na hora de usar (alem do job do worker). */
const RENOVAR_ANTES_MS = 5 * 60_000;

export class DbPspGatewayResolver implements PspGatewayResolver {
  readonly provider = 'MERCADO_PAGO' as const;
  readonly #core: PaymentAccountsCore;

  constructor(core: PaymentAccountsCore) {
    this.#core = core;
  }

  async forTenant(tenantId: string): Promise<PspResolution> {
    const { accountId, caida } = await withTenant(this.#core.pool, { tenantId }, async (client) => {
      const { rows } = await client.query<{ id: string | null }>(
        'SELECT app.tenant_receiving_account($1, $2::payment_provider, $3::payment_environment) AS id',
        [tenantId, 'MERCADO_PAGO', this.#core.environment],
      );
      if (rows[0]!.id) return { accountId: rows[0]!.id, caida: null };
      // Sem conta recebendo. Se a ULTIMA conta da comunidade caiu (revogada/erro), o erro e
      // especifico: o dono precisa reconectar, nao "configurar pela primeira vez".
      const { rows: ultima } = await client.query<{ status: string }>(
        `SELECT status FROM app.payment_account_overview($1) WHERE provider = 'MERCADO_PAGO' AND environment = $2::payment_environment
          ORDER BY connected_at DESC LIMIT 1`,
        [tenantId, this.#core.environment],
      );
      const status = ultima[0]?.status;
      return { accountId: null, caida: status === 'REVOKED' || status === 'ERROR' ? status : null };
    });
    if (!accountId) {
      if (caida) throw new PaymentAccountUnavailableError(caida);
      throw new PaymentsNotConfiguredError();
    }
    return this.#build(tenantId, accountId, 'CREATE');
  }

  async forPayment(input: { tenantId: string; paymentAccountId: string | null }): Promise<PspResolution> {
    if (!input.paymentAccountId) throw new PaymentAccountUnavailableError('NO_ACCOUNT');
    return this.#build(input.tenantId, input.paymentAccountId, 'SETTLE');
  }

  verifyWebhook(input: Parameters<PspGateway['verifyWebhook']>[0]): WebhookVerification {
    return verifyMercadoPagoWebhook(this.#core.webhookSecret, input);
  }

  async #credentials(tenantId: string, accountId: string, purpose: 'CREATE' | 'SETTLE'): Promise<CredentialRow> {
    return withTenant(this.#core.pool, { tenantId }, async (client) => {
      const { rows } = await client.query<CredentialRow>('SELECT * FROM app.get_payment_credentials($1, $2, $3)', [
        tenantId,
        accountId,
        purpose,
      ]);
      return rows[0]!;
    });
  }

  async #build(tenantId: string, accountId: string, purpose: 'CREATE' | 'SETTLE'): Promise<PspResolution> {
    let creds = await this.#credentials(tenantId, accountId, purpose);
    if (!creds.usable) throw new PaymentAccountUnavailableError(creds.reason);

    // Vence em instantes: renova antes de usar (o job do worker normalmente ja o fez).
    if (creds.token_expires_at && new Date(creds.token_expires_at).getTime() < Date.now() + RENOVAR_ANTES_MS) {
      await refreshAuthorization(this.#core, creds.authorization_id!, {
        tenantId,
        knownVersion: creds.credential_version,
      });
      creds = await this.#credentials(tenantId, accountId, purpose);
      if (!creds.usable) throw new PaymentAccountUnavailableError(creds.reason);
    }

    try {
      return {
        gateway: new AccountBoundGateway(this.#core, tenantId, accountId, purpose, creds, this),
        paymentAccountId: accountId,
      };
    } catch {
      // Credencial que nao abre (chave errada/dado corrompido): essa conta nao serve, e so ela.
      // Uma conta ruim nao pode derrubar o ciclo das outras; a mensagem nao leva nenhum dado.
      throw new PaymentAccountUnavailableError('CREDENTIAL_UNREADABLE');
    }
  }

  /** Recarrega a credencial (depois de uma renovacao). Usado pelo gateway da conta. */
  async reload(tenantId: string, accountId: string, purpose: 'CREATE' | 'SETTLE'): Promise<CredentialRow> {
    return this.#credentials(tenantId, accountId, purpose);
  }
}

/**
 * Gateway de UMA conta. Se o provedor responde 401, renova a autorizacao (uma vez, sob lock) e
 * repete a chamada; se ainda assim recusar, a autorizacao e marcada com erro e a operacao
 * falha — sem inventar sucesso.
 */
class AccountBoundGateway implements PspGateway {
  readonly provider = 'MERCADO_PAGO' as const;
  #inner: MercadoPagoGateway;
  #version: number | null;

  constructor(
    private readonly core: PaymentAccountsCore,
    private readonly tenantId: string,
    private readonly accountId: string,
    private readonly purpose: 'CREATE' | 'SETTLE',
    creds: CredentialRow,
    private readonly resolver: DbPspGatewayResolver,
  ) {
    this.#inner = this.#gatewayFor(creds);
    this.#version = creds.credential_version;
  }

  #gatewayFor(creds: CredentialRow): MercadoPagoGateway {
    const token = this.core.cipher.decrypt(
      creds.access_token_encrypted!,
      tokenAad(creds.provider!, creds.environment!, creds.provider_account_id!),
    );
    return new MercadoPagoGateway({
      accessToken: token,
      webhookSecret: this.core.webhookSecret,
      fallbackPayerEmail: this.core.fallbackPayerEmail,
      fetchImpl: this.core.fetchImpl,
      apiBase: this.core.apiBase,
    });
  }

  async #comRenovacao<T>(op: (g: MercadoPagoGateway) => Promise<T>): Promise<T> {
    try {
      return await op(this.#inner);
    } catch (error) {
      if (!(error instanceof PspUnauthorizedError)) throw error;
    }

    // 401: o token desta conta nao vale. Renova (ou descobre que foi revogado) e tenta UMA vez.
    const atual = await this.resolver.reload(this.tenantId, this.accountId, this.purpose);
    if (!atual.usable) throw new PaymentAccountUnavailableError(atual.reason);
    const outcome = await refreshAuthorization(this.core, atual.authorization_id!, {
      tenantId: this.tenantId,
      knownVersion: this.#version,
      force: true,
    });
    if (outcome === 'revoked' || outcome === 'unavailable') {
      throw new PaymentAccountUnavailableError('AUTHORIZATION_REVOKED');
    }
    const nova = await this.resolver.reload(this.tenantId, this.accountId, this.purpose);
    if (!nova.usable) throw new PaymentAccountUnavailableError(nova.reason);
    this.#inner = this.#gatewayFor(nova);
    this.#version = nova.credential_version;

    try {
      return await op(this.#inner);
    } catch (error) {
      if (error instanceof PspUnauthorizedError) {
        // Renovou e continua recusado: a autorizacao nao presta. Marca e para.
        await withTenant(this.core.pool, { tenantId: this.tenantId }, (client) =>
          client.query('SELECT app.mark_authorization_invalid($1, $2::payment_authorization_status, $3)', [
            nova.authorization_id,
            'ERROR',
            'o provedor recusou a credencial renovada',
          ]),
        );
        throw new PaymentAccountUnavailableError('AUTHORIZATION_ERROR');
      }
      throw error;
    }
  }

  createPixCharge(input: CreatePixChargeInput): Promise<PspPayment> {
    return this.#comRenovacao((g) => g.createPixCharge(input));
  }

  listPaymentMethods(): Promise<readonly PspPaymentMethod[]> {
    return this.#comRenovacao((g) => g.listPaymentMethods());
  }

  getPayment(providerPaymentId: string): Promise<PspPayment> {
    return this.#comRenovacao((g) => g.getPayment(providerPaymentId));
  }

  verifyWebhook(input: Parameters<PspGateway['verifyWebhook']>[0]): WebhookVerification {
    return verifyMercadoPagoWebhook(this.core.webhookSecret, input);
  }
}
