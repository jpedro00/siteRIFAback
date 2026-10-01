import { withTenant } from '@clubedarifa/db';
import type { PaymentAccount, PaymentAccountsResponse } from '@clubedarifa/shared';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';

/**
 * Recebimentos da comunidade (FLUXO B). A API NUNCA devolve credencial: o que sai daqui vem de
 * `app.payment_account_overview`, que nao tem coluna de segredo.
 */

interface OverviewRow {
  id: string;
  provider: PaymentAccount['provider'];
  environment: PaymentAccount['environment'];
  status: PaymentAccount['status'];
  provider_account_id: string;
  authorization_status: PaymentAccount['authorizationStatus'];
  token_expires_at: Date | null;
  last_verified_at: Date | null;
  last_error: string | null;
  connected_at: Date;
  disconnect_requested_at: Date | null;
  can_receive: boolean;
  open_obligations: number;
}

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

function toAccount(r: OverviewRow): PaymentAccount {
  return {
    id: r.id,
    provider: r.provider,
    environment: r.environment,
    status: r.status,
    providerAccountId: r.provider_account_id,
    authorizationStatus: r.authorization_status,
    tokenExpiresAt: iso(r.token_expires_at),
    lastVerifiedAt: iso(r.last_verified_at),
    lastError: r.last_error,
    connectedAt: new Date(r.connected_at).toISOString(),
    disconnectRequestedAt: iso(r.disconnect_requested_at),
    canReceivePayments: r.can_receive,
    openObligations: r.open_obligations,
  };
}

function exigirModulo(deps: AppDeps) {
  const runtime = deps.paymentAccounts;
  // Desligado: enquanto nao houver aplicativo OAuth configurado e autorizado, nao se oferece conexao.
  if (!runtime || !runtime.enabled) {
    throw new ApiError('PAYMENT_ACCOUNT_UNAVAILABLE', 'A conexão de contas de recebimento ainda não está habilitada.');
  }
  return runtime;
}

export async function listPaymentAccounts(
  deps: AppDeps,
  input: { tenantId: string; userId: string },
): Promise<PaymentAccountsResponse> {
  return withTenant(deps.pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
    const { rows } = await client.query<OverviewRow>('SELECT * FROM app.payment_account_overview($1)', [input.tenantId]);
    const { rows: apto } = await client.query<{ ok: boolean }>('SELECT app.tenant_has_payment_account($1) AS ok', [
      input.tenantId,
    ]);
    const enabled = deps.paymentAccounts?.enabled === true;
    return {
      enabled,
      accounts: rows.map(toAccount),
      // Checkout pago: precisa de modulo ligado E conta conectada com autorizacao utilizavel.
      checkoutAvailable: deps.paymentAccounts !== null && apto[0]!.ok,
    };
  });
}

export async function connectPaymentAccount(
  deps: AppDeps,
  input: { tenantId: string; userId: string },
): Promise<{ url: string }> {
  const runtime = exigirModulo(deps);
  try {
    return await runtime.beginConnection({ tenantId: input.tenantId, userId: input.userId });
  } catch (error) {
    if ((error as { code?: string }).code === 'P0001') {
      throw ApiError.rateLimited('Há tentativas de conexão demais em aberto. Conclua ou aguarde alguns minutos.');
    }
    throw error;
  }
}

export async function disconnectPaymentAccount(
  deps: AppDeps,
  input: { tenantId: string; userId: string; accountId: string },
): Promise<PaymentAccount> {
  return withTenant(deps.pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
    const { rows } = await client.query<{ r: string }>('SELECT app.request_payment_account_disconnect($1, $2, $3) AS r', [
      input.tenantId,
      input.accountId,
      input.userId,
    ]);
    const r = rows[0]!.r;
    if (r === 'unknown_account' || r === 'forbidden') throw ApiError.notFound('Conta de recebimento não encontrada.');
    if (r === 'not_connected') throw ApiError.conflict('Esta conta não está conectada.');

    const { rows: visao } = await client.query<OverviewRow>('SELECT * FROM app.payment_account_overview($1)', [input.tenantId]);
    const conta = visao.find((v) => v.id === input.accountId);
    if (!conta) throw ApiError.notFound('Conta de recebimento não encontrada.');
    return toAccount(conta);
  });
}

/** Motivos que a tela do painel pode mostrar (nada alem do motivo vai na URL). */
const MOTIVOS_PUBLICOS = new Set([
  'missing_state', 'invalid_state', 'wrong_user', 'not_authorized', 'provider_denied', 'missing_code',
  'exchange_failed', 'provider_unavailable', 'identity_mismatch', 'environment_mismatch', 'attempt_invalid',
]);

/**
 * Retorno do provedor. Devolve a URL do painel para onde o navegador segue. A conexao SO se
 * conclui se a tentativa persistida confere (state, PKCE, usuario, comunidade, validade, uso unico).
 */
export async function handleOAuthCallback(
  deps: AppDeps,
  input: { state: unknown; code: unknown; error: unknown; sessionUserId: string },
): Promise<string> {
  const runtime = exigirModulo(deps);
  const painel = deps.config.ORGANIZER_PANEL_URL;
  if (!painel) throw new ApiError('PAYMENT_ACCOUNT_UNAVAILABLE');

  const texto = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  const resultado = await runtime.completeConnection({
    state: texto(input.state),
    code: texto(input.code),
    providerError: texto(input.error),
    sessionUserId: input.sessionUserId,
  });

  if (resultado.ok) return `${painel}/recebimentos?conexao=ok`;
  const motivo = MOTIVOS_PUBLICOS.has(resultado.reason) ? resultado.reason : 'attempt_invalid';
  return `${painel}/recebimentos?conexao=erro&motivo=${motivo}`;
}
