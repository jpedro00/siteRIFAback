import { withContext, withTenant } from '@clubedarifa/db';
import {
  PAYMENT_OAUTH_STATE_TTL_SECONDS,
  tenantPermissionsFor,
  type MembershipRole,
} from '@clubedarifa/shared';
import { VERIFIER_AAD, tokenAad } from './cipher.js';
import { sanitize, type PaymentAccountsCore } from './core.js';
import { OAuthError } from './mercadoPagoOAuth.js';
import { codeChallengeFor, generateCodeVerifier, generateState, hashState } from './pkce.js';

/**
 * Conexao da conta por OAuth (authorization_code + PKCE).
 *
 * INICIO: gera `state` e `code_verifier` ALEATORIOS (nada de tenant, usuario ou segredo dentro
 * do `state`), grava o hash do state e o verifier cifrado, amarrados a comunidade e ao usuario
 * que iniciaram, com validade curta e uso unico. Devolve a URL do provedor.
 *
 * RETORNO: a tentativa e localizada pelo HASH do state e CONSUMIDA (uso unico) antes de qualquer
 * outra coisa — repetir o retorno nao faz nada. O resultado so vale se, alem do state:
 *   - o usuario da SESSAO e o que iniciou;
 *   - esse usuario ainda tem `payment_account:manage` na comunidade da tentativa;
 *   - o PKCE confere (o provedor recusa o codigo se o verifier nao bate);
 *   - a conta que o provedor identifica e a do token, no ambiente esperado.
 * O codigo de autorizacao e trocado so pelo backend e nunca e guardado nem logado.
 */

export type ConnectionFailure =
  | 'missing_state'
  | 'invalid_state'
  | 'wrong_user'
  | 'not_authorized'
  | 'provider_denied'
  | 'missing_code'
  | 'exchange_failed'
  | 'provider_unavailable'
  | 'identity_mismatch'
  | 'environment_mismatch'
  | 'attempt_invalid';

export interface ConnectionResult {
  readonly ok: boolean;
  /** Comunidade da tentativa, quando ela foi localizada (para o redirect e a auditoria). */
  readonly tenantId: string | null;
  readonly reason: ConnectionFailure | 'connected' | 'already_linked';
}

const NULL_CONTEXT = { userId: null, tenantId: null, platformAccess: false } as const;

export async function beginConnection(
  core: PaymentAccountsCore,
  input: { tenantId: string; userId: string },
): Promise<{ url: string }> {
  const state = generateState();
  const verifier = generateCodeVerifier();
  const verifierEncrypted = core.cipher.encrypt(verifier, VERIFIER_AAD);

  await withTenant(core.pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
    await client.query(
      'SELECT app.begin_payment_account_connection($1, $2, $3::payment_provider, $4::payment_environment, $5, $6, $7)',
      [
        input.tenantId,
        input.userId,
        'MERCADO_PAGO',
        core.environment,
        hashState(state),
        verifierEncrypted,
        PAYMENT_OAUTH_STATE_TTL_SECONDS,
      ],
    );
  });

  return { url: core.oauth.buildAuthorizationUrl({ state, codeChallenge: codeChallengeFor(verifier) }) };
}

interface ConsumedState {
  state_id: string;
  tenant_id: string;
  user_id: string;
  environment: 'SANDBOX' | 'PRODUCTION';
  code_verifier_encrypted: Buffer;
}

export async function completeConnection(
  core: PaymentAccountsCore,
  input: { state: string | undefined; code: string | undefined; providerError?: string | undefined; sessionUserId: string },
): Promise<ConnectionResult> {
  if (!input.state) return { ok: false, tenantId: null, reason: 'missing_state' };

  // 1. CONSOME a tentativa: a partir daqui este `state` nao vale mais, aconteca o que acontecer.
  const attempt = await withContext(core.pool, NULL_CONTEXT, async (client) => {
    const { rows } = await client.query<ConsumedState>('SELECT * FROM app.consume_payment_oauth_state($1)', [
      hashState(input.state!),
    ]);
    return rows[0] ?? null;
  });
  if (!attempt) return { ok: false, tenantId: null, reason: 'invalid_state' };

  const tenantId = attempt.tenant_id;
  const falhou = async (reason: ConnectionFailure): Promise<ConnectionResult> => {
    // Trilha sem segredo: so o motivo.
    await withTenant(core.pool, { tenantId, userId: input.sessionUserId }, (client) =>
      client.query('SELECT app.record_payment_account_event($1, $2, $3, $4::jsonb)', [
        tenantId,
        input.sessionUserId,
        'payment_account.connection_failed',
        JSON.stringify({ reason }),
      ]),
    ).catch(() => undefined);
    return { ok: false, tenantId, reason };
  };

  // 2. Usuario da sessao = usuario que iniciou.
  if (attempt.user_id !== input.sessionUserId) return falhou('wrong_user');

  // 3. O iniciador ainda pode gerir recebimentos desta comunidade (o papel pode ter mudado).
  const roles = await withTenant(core.pool, { tenantId, userId: attempt.user_id }, async (client) => {
    const { rows } = await client.query<{ role: MembershipRole }>(
      'SELECT role::text AS role FROM memberships WHERE user_id = $1 AND revoked_at IS NULL',
      [attempt.user_id],
    );
    return rows.map((r) => r.role);
  });
  if (!tenantPermissionsFor(roles).has('payment_account:manage')) return falhou('not_authorized');

  // 4. O vendedor pode ter recusado no provedor, ou o retorno veio sem codigo.
  if (input.providerError) return falhou('provider_denied');
  if (!input.code) return falhou('missing_code');

  // 5. Troca do codigo (PKCE): so o backend, e so uma vez.
  let tokens;
  try {
    const verifier = core.cipher.decrypt(attempt.code_verifier_encrypted, VERIFIER_AAD);
    tokens = await core.oauth.exchangeCode({ code: input.code, codeVerifier: verifier });
  } catch (error) {
    if (error instanceof OAuthError && error.kind === 'transient') return falhou('provider_unavailable');
    core.log?.warn('payment_account.exchange_failed', {
      tenant_id: tenantId,
      error: sanitize(error instanceof Error ? error.message : String(error)),
    });
    return falhou('exchange_failed');
  }

  // 6. Identidade e ambiente. O que o provedor diz do TOKEN precisa bater com quem o token e.
  let identity;
  try {
    identity = await core.oauth.whoAmI(tokens.accessToken);
  } catch (error) {
    if (error instanceof OAuthError && error.kind === 'transient') return falhou('provider_unavailable');
    return falhou('identity_mismatch');
  }
  if (identity.id !== tokens.userId) return falhou('identity_mismatch');
  if (tokens.liveMode !== null && tokens.liveMode !== (attempt.environment === 'PRODUCTION')) {
    return falhou('environment_mismatch');
  }

  // 7. Cifra e grava: cria ou reutiliza a autorizacao da conta e vincula a comunidade.
  const aad = tokenAad('MERCADO_PAGO', attempt.environment, tokens.userId);
  const result = await withTenant(core.pool, { tenantId, userId: attempt.user_id }, async (client) => {
    const { rows } = await client.query<{ result: string }>(
      'SELECT * FROM app.complete_payment_account_connection($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [
        attempt.state_id,
        tenantId,
        attempt.user_id,
        tokens.userId,
        core.cipher.encrypt(tokens.accessToken, aad),
        core.cipher.encrypt(tokens.refreshToken, aad),
        core.cipher.keyVersion,
        tokens.expiresAt,
        [...tokens.scopes],
      ],
    );
    return rows[0]!.result;
  });

  if (result === 'connected' || result === 'already_linked') return { ok: true, tenantId, reason: result };
  return falhou('attempt_invalid');
}
