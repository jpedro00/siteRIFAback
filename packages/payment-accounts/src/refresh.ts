import { withContext, withTenant, type PoolClient } from '@clubedarifa/db';
import { PAYMENT_TOKEN_REFRESH_MARGIN_DAYS } from '@clubedarifa/shared';
import { tokenAad } from './cipher.js';
import { sanitize, type PaymentAccountsCore } from './core.js';
import { OAuthError } from './mercadoPagoOAuth.js';

/**
 * Renovacao do token de uma AUTORIZACAO (a fonte das credenciais, compartilhada entre
 * comunidades).
 *
 *  1. Um processo por vez: o lock de transacao por autorizacao (no banco) serializa a API
 *     e o worker. Quem esperou ja encontra a credencial renovada e NAO renova de novo.
 *  2. O refresh token do Mercado Pago e de uso unico: a chamada de renovacao acontece com o
 *     lock segurado, e o par NOVO (access + refresh + validade) entra no banco num UPDATE so,
 *     com versao otimista. Um refresh token antigo nunca sobrescreve o novo, e uma falha no
 *     meio deixa a credencial vigente INTACTA (rollback).
 *  3. Refresh recusado (`invalid_grant`): a autorizacao e marcada REVOKED/EXPIRED e as
 *     comunidades ligadas a ela caem junto — nada de fingir que ainda da para consultar.
 */
export type RefreshOutcome = 'refreshed' | 'already_fresh' | 'revoked' | 'conflict' | 'unavailable';

export interface RefreshOptions {
  /** Comunidade no contexto (a API). O worker nao passa: ele atua em todas. */
  readonly tenantId?: string | undefined;
  /** Renova se o token vence em menos que isto. Padrao: 5 minutos. */
  readonly marginMs?: number | undefined;
  /** Versao da credencial que o chamador VIU falhar. Se ja mudou, outro renovou: nao renova de novo. */
  readonly knownVersion?: number | null | undefined;
  /** Renova mesmo com o token ainda valido (o provedor disse 401). */
  readonly force?: boolean | undefined;
}

const NULL_CONTEXT = { userId: null, tenantId: null, platformAccess: false } as const;

interface LockedAuthorization {
  status: string;
  credential_version: number;
  expires_at: Date | null;
  refresh_token_encrypted: Buffer | null;
  provider: string;
  environment: string;
  provider_account_id: string;
}

export async function refreshAuthorization(
  core: PaymentAccountsCore,
  authorizationId: string,
  options: RefreshOptions = {},
): Promise<RefreshOutcome> {
  const run = async (client: PoolClient): Promise<RefreshOutcome> => {
    const { rows } = await client.query<LockedAuthorization>(
      'SELECT * FROM app.lock_authorization_for_refresh($1)',
      [authorizationId],
    );
    const cur = rows[0];
    if (!cur) return 'unavailable';
    if (cur.status !== 'ACTIVE') return 'unavailable';

    // Outro processo ja renovou enquanto este esperava o lock.
    if (options.knownVersion != null && cur.credential_version > options.knownVersion) return 'already_fresh';
    const margem = options.marginMs ?? 5 * 60_000;
    if (!options.force && cur.expires_at && new Date(cur.expires_at).getTime() > Date.now() + margem) {
      return 'already_fresh';
    }
    if (!cur.refresh_token_encrypted) return 'unavailable';

    const aad = tokenAad(cur.provider, cur.environment, cur.provider_account_id);
    const refreshToken = core.cipher.decrypt(cur.refresh_token_encrypted, aad);

    let tokens;
    try {
      tokens = await core.oauth.refresh(refreshToken);
    } catch (error) {
      if (error instanceof OAuthError && error.kind === 'invalid_grant') {
        const vencido = cur.expires_at !== null && new Date(cur.expires_at).getTime() < Date.now();
        await client.query('SELECT app.mark_authorization_invalid($1, $2::payment_authorization_status, $3)', [
          authorizationId,
          vencido ? 'EXPIRED' : 'REVOKED',
          'renovacao recusada pelo provedor',
        ]);
        core.log?.warn('payment_account.refresh_denied', { authorization_id: authorizationId });
        return 'revoked';
      }
      // Rede, 5xx, limite: nada mudou; o rollback mantem a credencial vigente.
      throw error;
    }

    // A conta que o provedor reconhece tem de ser a MESMA da autorizacao.
    if (tokens.userId !== cur.provider_account_id) {
      await client.query('SELECT app.mark_authorization_invalid($1, $2::payment_authorization_status, $3)', [
        authorizationId,
        'ERROR',
        'renovacao devolveu outra conta',
      ]);
      return 'revoked';
    }

    const { rows: saved } = await client.query<{ ok: boolean }>(
      'SELECT app.store_refreshed_credentials($1, $2, $3, $4, $5, $6) AS ok',
      [
        authorizationId,
        cur.credential_version,
        core.cipher.encrypt(tokens.accessToken, aad),
        core.cipher.encrypt(tokens.refreshToken, aad),
        core.cipher.keyVersion,
        tokens.expiresAt,
      ],
    );
    return saved[0]!.ok ? 'refreshed' : 'conflict';
  };

  try {
    return options.tenantId
      ? await withTenant(core.pool, { tenantId: options.tenantId }, run)
      : await withContext(core.pool, NULL_CONTEXT, run);
  } catch (error) {
    core.log?.warn('payment_account.refresh_failed', {
      authorization_id: authorizationId,
      error: sanitize(error instanceof Error ? error.message : String(error)),
    });
    throw error;
  }
}

/** Worker: renova as autorizacoes que vencem dentro da margem. */
export async function refreshDueAuthorizations(
  core: PaymentAccountsCore,
  limit = 50,
  marginDays: number = PAYMENT_TOKEN_REFRESH_MARGIN_DAYS,
): Promise<{ refreshed: number; revoked: number; failed: number }> {
  const due = await withContext(core.pool, NULL_CONTEXT, async (client) => {
    const { rows } = await client.query<{ authorization_id: string }>(
      'SELECT authorization_id FROM app.list_authorizations_due_for_refresh($1, $2)',
      [marginDays, limit],
    );
    return rows.map((r) => r.authorization_id);
  });

  const totals = { refreshed: 0, revoked: 0, failed: 0 };
  for (const id of due) {
    try {
      const outcome = await refreshAuthorization(core, id, { marginMs: marginDays * 86_400_000 });
      if (outcome === 'refreshed') totals.refreshed += 1;
      else if (outcome === 'revoked') totals.revoked += 1;
    } catch {
      // Transitorio: o proximo ciclo tenta de novo, com a credencial vigente intacta.
      totals.failed += 1;
    }
  }
  return totals;
}
