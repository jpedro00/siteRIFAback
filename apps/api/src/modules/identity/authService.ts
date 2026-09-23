import { withUser, withoutContext, type PoolClient } from '@campaigns/db';
import {
  platformPermissionsFor,
  requiresMfa,
  type MembershipRole,
  type PlatformRole,
} from '@campaigns/shared';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';
import { verifyPassword } from '../../lib/password.js';
import { generateSessionToken, hashSessionToken } from '../../lib/sessionToken.js';
import { buildOtpauthUri, generateTotpSecret, verifyTotp } from '../../lib/totp.js';
import {
  AUTH_AUDIT_ACTIONS,
  recordIdentityAudit,
  recordIdentityAuditIn,
  type AuditOrigin,
} from '../audit/identityAudit.js';
import type { AuthenticatedSession } from '../../middleware/types.js';

/** M01 · Identidade, autenticacao, sessao e segundo fator. RN12. */

interface LoginCredentialRow {
  user_id: string;
  email: string;
  display_name: string;
  user_status: string;
  password_hash: string;
  locked_until: string | null;
  failed_attempts: number;
}

export interface LoginOutcome {
  readonly status: 'authenticated' | 'mfa_required' | 'mfa_enrollment_required';
  readonly token: string;
  readonly user: { id: string; email: string; displayName: string };
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/**
 * Hash descartavel, com os mesmos parametros de custo dos hashes reais.
 *
 * Existe para que "e-mail inexistente" gaste o mesmo tempo que "senha errada":
 * sem isso, a diferenca de alguns centenas de milissegundos entrega uma lista
 * de e-mails validos a quem estiver sondando.
 */
const TIMING_DECOY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/**
 * Perfis do usuario, usados para decidir se RN12 obriga segundo fator.
 * Le por funcoes SECURITY DEFINER que filtram pelo usuario do CONTEXTO.
 */
async function loadProfile(
  deps: AppDeps,
  userId: string,
): Promise<{
  platformRoles: PlatformRole[];
  tenantRoles: MembershipRole[];
  mfaEnrolled: boolean;
}> {
  return withUser(deps.pool, { userId }, async (client) => {
    const platform = await client.query<{ role: PlatformRole }>(
      'SELECT role FROM app.my_platform_roles()',
    );
    const memberships = await client.query<{ role: MembershipRole }>(
      'SELECT role FROM app.my_memberships()',
    );
    const factor = await client.query(
      `SELECT 1 FROM user_mfa_factors
        WHERE user_id = $1 AND factor_type = 'TOTP' AND confirmed_at IS NOT NULL`,
      [userId],
    );
    return {
      platformRoles: platform.rows.map((row) => row.role),
      tenantRoles: memberships.rows.map((row) => row.role),
      mfaEnrolled: (factor.rowCount ?? 0) > 0,
    };
  });
}

/**
 * Login.
 *
 * RESPOSTA UNIFORME — o ponto que mais se erra aqui.
 *
 * Toda recusa sai como a MESMA resposta: senha errada, e-mail inexistente,
 * conta inativa e conta bloqueada por tentativas. Devolver 429 para a conta
 * bloqueada parecia informacao inofensiva, mas nao e: quem sonda so precisa
 * gastar as tentativas de um e-mail e ler o codigo de status para descobrir se
 * aquele endereco existe na plataforma. O bloqueio continua existindo e
 * continua valendo — o que deixa de existir e o sinal externo.
 *
 * A conta bloqueada NAO tem a tentativa contabilizada. Contabilizar empurraria
 * `locked_until` para frente a cada nova tentativa, e um atacante manteria a
 * conta trancada indefinidamente apenas insistindo. O bloqueio expira no prazo
 * que foi definido quando disparou.
 *
 * TEMPO DE RESPOSTA: a verificacao da senha acontece ANTES de qualquer decisao,
 * inclusive para conta bloqueada ou inativa. Um `return` antecipado economizaria
 * o scrypt e denunciaria o caso pelo tempo.
 */
export async function login(deps: AppDeps, input: LoginInput): Promise<LoginOutcome> {
  const email = input.email.trim().toLowerCase();
  const origin: AuditOrigin = { ip: input.ip, userAgent: input.userAgent };

  /**
   * LIMITE POR ORIGEM — antes de qualquer consulta ou verificacao.
   *
   * Roda aqui, e nao depois, por dois motivos que se somam:
   *
   *   1. A tentativa recusada NAO chega a `record_login_attempt`. E isso que
   *      impede a amplificacao: uma origem cortada nao consegue mais gastar o
   *      orcamento de tentativas de conta nenhuma, e portanto nao consegue
   *      trancar contas alheias.
   *   2. Nao custa consulta ao banco nem `scrypt`. Um limitador que trabalhasse
   *      para recusar seria ele proprio um amplificador.
   *
   * O 429 daqui NAO revela nada sobre conta nenhuma: e uma afirmacao sobre o
   * comportamento de quem esta chamando, que quem chama ja conhece. Por isso ele
   * pode ser explicito, enquanto a recusa de credencial permanece uniforme.
   */
  const throttle = deps.loginThrottle.check(input.ip);
  if (!throttle.allowed) {
    throw ApiError.rateLimited(
      'Muitas tentativas de entrada a partir deste dispositivo. Aguarde e tente novamente.',
      { retryAfterSeconds: throttle.retryAfterSeconds },
    );
  }

  const credential = await withoutContext(deps.pool, async (client) => {
    const { rows } = await client.query<LoginCredentialRow>(
      `SELECT user_id, email, display_name, user_status, password_hash, locked_until, failed_attempts
         FROM app.find_login_credential($1)`,
      [email],
    );
    return rows[0] ?? null;
  });

  const genericFailure = ApiError.unauthenticated('E-mail ou senha inválidos.');

  if (!credential) {
    // Conta para a ORIGEM mesmo sem conta existente: varrer enderecos e
    // exatamente o comportamento que este limite persegue, e nao contar aqui
    // deixaria a sondagem de e-mails sair de graca.
    deps.loginThrottle.recordFailure(input.ip, email);
    // Sem ator identificado nao ha trilha: ver o comentario em identityAudit.ts.
    await verifyPassword(input.password, TIMING_DECOY_HASH);
    throw genericFailure;
  }

  // Sempre, antes de qualquer ramificacao.
  const passwordOk = await verifyPassword(input.password, credential.password_hash);
  const isActive = credential.user_status === 'ACTIVE';
  const isLocked =
    credential.locked_until !== null && new Date(credential.locked_until) > new Date();

  if (isLocked) {
    deps.loginThrottle.recordFailure(input.ip, email);
    await recordIdentityAudit(deps, {
      userId: credential.user_id,
      action: AUTH_AUDIT_ACTIONS.LOGIN_FAILED,
      origin,
      metadata: { reason: 'account_locked' },
    });
    throw genericFailure;
  }

  const attempt = await withoutContext(deps.pool, async (client) => {
    const { rows } = await client.query<{ locked: boolean; failed_attempts: number }>(
      'SELECT locked, failed_attempts FROM app.record_login_attempt($1, $2, $3, $4)',
      [
        credential.user_id,
        passwordOk && isActive,
        deps.config.LOGIN_MAX_ATTEMPTS,
        deps.config.LOGIN_LOCK_MINUTES,
      ],
    );
    return rows[0] ?? { locked: false, failed_attempts: 0 };
  });

  if (!passwordOk || !isActive) {
    deps.loginThrottle.recordFailure(input.ip, email);
    await withUser(deps.pool, { userId: credential.user_id }, async (client) => {
      await recordIdentityAuditIn(client, {
        userId: credential.user_id,
        action: AUTH_AUDIT_ACTIONS.LOGIN_FAILED,
        origin,
        metadata: {
          reason: passwordOk ? 'user_not_active' : 'invalid_password',
          failedAttempts: attempt.failed_attempts,
        },
      });
      if (attempt.locked) {
        await recordIdentityAuditIn(client, {
          userId: credential.user_id,
          action: AUTH_AUDIT_ACTIONS.ACCOUNT_LOCKED,
          origin,
          metadata: {
            failedAttempts: attempt.failed_attempts,
            lockMinutes: deps.config.LOGIN_LOCK_MINUTES,
          },
        });
      }
    });
    throw genericFailure;
  }

  // Credencial provada: a origem deixa de ser suspeita. Manter a punicao depois
  // do acerto castigaria quem so errou a senha algumas vezes antes de lembrar.
  deps.loginThrottle.recordSuccess(input.ip);

  const profile = await loadProfile(deps, credential.user_id);
  const mfaRequired = requiresMfa({
    tenantRoles: profile.tenantRoles,
    platformRoles: profile.platformRoles,
  });

  /**
   * RN12 · O QUE `mfa_satisfied_at` SIGNIFICA
   *
   * Exclusivamente: **esta sessao apresentou e validou um segundo fator real**.
   *
   * A coluna NAO significa "este usuario nao precisava de MFA quando entrou".
   * Confundir as duas coisas foi o que abriu o contorno de RN12: a sessao de
   * quem nao exigia MFA nascia com a marca preenchida, `authenticateSession`
   * recalculava `mfaRequired` a cada requisicao mas lia a marca congelada do
   * login, e a trava `mfaRequired && !mfaSatisfied` nunca disparava. Um
   * SUPPORT promovido a OWNER — ou um usuario comum que recebesse Super Admin —
   * seguia acessando rotas privilegiadas pelas 12 horas da sessao, sem nunca ter
   * apresentado um fator.
   *
   * Por isso a sessao nasce SEMPRE com `mfa_satisfied_at` nulo. Quem nao esta
   * sob RN12 continua usando normalmente as rotas que lhe cabem, porque a
   * autorizacao pergunta duas coisas separadas — "precisa?" e "comprovou?" — e
   * so bloqueia quando a primeira e sim e a segunda e nao. A promocao de papel
   * passa a valer na requisicao seguinte, sem exigir logout.
   *
   * O `status` devolvido ao cliente continua descrevendo o que falta fazer:
   *   - fator confirmado na conta  -> 'mfa_required' (quem cadastrou quer usar);
   *   - sem fator e RN12 obriga    -> 'mfa_enrollment_required';
   *   - sem fator e sem obrigacao  -> 'authenticated', nada pendente.
   */
  let status: LoginOutcome['status'];
  if (profile.mfaEnrolled) {
    status = 'mfa_required';
  } else if (mfaRequired) {
    status = 'mfa_enrollment_required';
  } else {
    status = 'authenticated';
  }

  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + deps.config.SESSION_TTL_HOURS * 3600 * 1000);

  await withUser(deps.pool, { userId: credential.user_id }, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4::inet, $5)
       RETURNING id`,
      [credential.user_id, tokenHash, expiresAt.toISOString(), input.ip, input.userAgent],
    );

    // Trilha na MESMA transacao da sessao: nao existe sessao aberta sem
    // registro de que foi aberta (RN11).
    await recordIdentityAuditIn(client, {
      userId: credential.user_id,
      action: AUTH_AUDIT_ACTIONS.LOGIN_SUCCEEDED,
      origin,
      metadata: {
        sessionId: rows[0]!.id,
        status,
        mfaRequired,
        mfaEnrolled: profile.mfaEnrolled,
      },
    });
  });

  return {
    status,
    token,
    user: {
      id: credential.user_id,
      email: credential.email,
      displayName: credential.display_name,
    },
  };
}

interface SessionRow {
  session_id: string;
  user_id: string;
  mfa_satisfied_at: string | null;
  expires_at: string;
  user_status: string;
  email: string;
  display_name: string;
}

/**
 * Valida o token e monta a sessao.
 *
 * `app.authenticate_session` ja recusa sessao revogada ou expirada. A
 * revogacao, portanto, vale na requisicao seguinte — nao espera expiracao.
 *
 * `mfaRequired` e `mfaEnrolled` sao recalculados A CADA requisicao, a partir
 * dos papeis vigentes. `mfaSatisfied` vem da sessao. Sao tres perguntas
 * independentes, e e a combinacao delas que a autorizacao usa.
 */
export async function authenticateSession(
  deps: AppDeps,
  token: string,
): Promise<AuthenticatedSession | null> {
  if (!token) return null;

  const row = await withoutContext(deps.pool, async (client) => {
    const { rows } = await client.query<SessionRow>(
      `SELECT session_id, user_id, mfa_satisfied_at, expires_at, user_status, email, display_name
         FROM app.authenticate_session($1)`,
      [hashSessionToken(token)],
    );
    return rows[0] ?? null;
  });

  if (!row) return null;

  const profile = await loadProfile(deps, row.user_id);
  const platformPermissions = platformPermissionsFor(profile.platformRoles);

  await withUser(deps.pool, { userId: row.user_id }, async (client) => {
    await client.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]);
  });

  return {
    sessionId: row.session_id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    mfaSatisfied: row.mfa_satisfied_at !== null,
    mfaRequired: requiresMfa({
      tenantRoles: profile.tenantRoles,
      platformRoles: profile.platformRoles,
    }),
    mfaEnrolled: profile.mfaEnrolled,
    platformRoles: profile.platformRoles,
    platformPermissions,
  };
}

export async function revokeSession(
  deps: AppDeps,
  input: { userId: string; sessionId: string; reason: string; origin: AuditOrigin },
): Promise<void> {
  await withUser(deps.pool, { userId: input.userId }, async (client) => {
    await client.query(
      `UPDATE sessions
          SET revoked_at = now(), revoked_reason = $2
        WHERE id = $1 AND revoked_at IS NULL`,
      [input.sessionId, input.reason],
    );
    await recordIdentityAuditIn(client, {
      userId: input.userId,
      action: AUTH_AUDIT_ACTIONS.LOGOUT,
      origin: input.origin,
      metadata: { sessionId: input.sessionId, reason: input.reason },
    });
  });
}

/** Revoga TODAS as sessoes do usuario. Usado no "sair de todos os aparelhos". */
export async function revokeAllSessions(
  deps: AppDeps,
  input: { userId: string; reason: string; origin: AuditOrigin },
): Promise<number> {
  return withUser(deps.pool, { userId: input.userId }, async (client) => {
    const result = await client.query(
      `UPDATE sessions
          SET revoked_at = now(), revoked_reason = $2
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [input.userId, input.reason],
    );
    const revoked = result.rowCount ?? 0;
    await recordIdentityAuditIn(client, {
      userId: input.userId,
      action: AUTH_AUDIT_ACTIONS.LOGOUT_ALL,
      origin: input.origin,
      metadata: { revokedSessions: revoked, reason: input.reason },
    });
    return revoked;
  });
}

// ---------------------------------------------------------------------------
// Segundo fator (TOTP). RN12.
// ---------------------------------------------------------------------------

/**
 * Rotacao do segredo da sessao apos elevacao de privilegio.
 *
 * A LINHA da sessao permanece a mesma — o identificador continua ligando a
 * trilha de auditoria ao mesmo episodio de acesso. O que muda e o SEGREDO
 * portador: o `token_hash` e substituido, de modo que o token entregue antes da
 * verificacao deixa de resolver para qualquer sessao.
 *
 * Por que isso importa: sem rotacao, um token capturado enquanto a sessao ainda
 * nao tinha o segundo fator satisfeito passaria a valer como sessao ELEVADA no
 * instante em que a pessoa legitima completasse o MFA. Quem capturou o token nao
 * precisaria do fator — bastaria esperar.
 */
async function rotateSessionToken(client: PoolClient, sessionId: string): Promise<string> {
  const token = generateSessionToken();
  await client.query('UPDATE sessions SET token_hash = $2 WHERE id = $1', [
    sessionId,
    hashSessionToken(token),
  ]);
  return token;
}

/**
 * Bloqueio por tentativas do segundo fator.
 *
 * Um codigo TOTP tem 10^6 combinacoes e quem chega aqui ja acertou a senha.
 * Sem limite, o segundo fator seria apenas um atraso de minutos.
 *
 * Os contadores ficam em `user_credentials` junto dos da senha: e a mesma conta,
 * e o bloqueio precisa ser lido no mesmo lugar. O mesmo par de funcoes protege
 * a VERIFICACAO e o CADASTRO — sao o mesmo segredo de 6 digitos e merecem a
 * mesma defesa.
 */
async function assertMfaNotLocked(deps: AppDeps, userId: string): Promise<void> {
  const lockedUntil = await withUser(deps.pool, { userId }, async (client) => {
    const { rows } = await client.query<{ mfa_locked_until: string | null }>(
      'SELECT mfa_locked_until FROM user_credentials WHERE user_id = $1',
      [userId],
    );
    return rows[0]?.mfa_locked_until ?? null;
  });

  if (lockedUntil && new Date(lockedUntil) > new Date()) {
    throw ApiError.rateLimited('Muitas tentativas de verificação. Aguarde e tente novamente.');
  }
}

/**
 * Conta a tentativa falha em transacao PROPRIA.
 *
 * Incrementar e lancar o erro dentro da mesma transacao desfaria o incremento
 * no rollback — e o bloqueio nunca chegaria a acontecer.
 */
async function recordMfaFailure(deps: AppDeps, userId: string): Promise<void> {
  await withUser(deps.pool, { userId }, async (client) => {
    await client.query(
      `UPDATE user_credentials
          SET mfa_failed_attempts = mfa_failed_attempts + 1,
              mfa_locked_until = CASE
                WHEN mfa_failed_attempts + 1 >= $2
                  THEN now() + make_interval(mins => $3)
                ELSE mfa_locked_until
              END,
              updated_at = now()
        WHERE user_id = $1`,
      [userId, deps.config.LOGIN_MAX_ATTEMPTS, deps.config.LOGIN_LOCK_MINUTES],
    );
  });
}

/** Zera os contadores do segundo fator. Chamado ao acertar o codigo. */
async function clearMfaFailures(client: PoolClient, userId: string): Promise<void> {
  await client.query(
    `UPDATE user_credentials
        SET mfa_failed_attempts = 0, mfa_locked_until = NULL, updated_at = now()
      WHERE user_id = $1`,
    [userId],
  );
}

export interface MfaEnrollment {
  readonly secret: string;
  readonly otpauthUri: string;
}

/**
 * Inicia o cadastro do segundo fator.
 *
 * O segredo e gravado CIFRADO e ainda NAO confirmado. Um fator sem
 * `confirmed_at` nao satisfaz MFA e nao bloqueia o login — se a pessoa perder
 * o aplicativo no meio do cadastro, ela nao fica trancada para fora.
 *
 * Cadastros anteriores nao confirmados sao descartados, para nao deixar
 * segredos orfaos acumulados.
 */
export async function startMfaEnrollment(
  deps: AppDeps,
  input: { userId: string; email: string; origin: AuditOrigin },
): Promise<MfaEnrollment> {
  const secret = generateTotpSecret();
  const encrypted = deps.secretBox.encrypt(secret);

  await withUser(deps.pool, { userId: input.userId }, async (client) => {
    const confirmed = await client.query(
      `SELECT 1 FROM user_mfa_factors
        WHERE user_id = $1 AND factor_type = 'TOTP' AND confirmed_at IS NOT NULL`,
      [input.userId],
    );
    if ((confirmed.rowCount ?? 0) > 0) {
      throw ApiError.conflict('A verificação em duas etapas já está ativa nesta conta.');
    }

    await client.query(
      `DELETE FROM user_mfa_factors
        WHERE user_id = $1 AND factor_type = 'TOTP' AND confirmed_at IS NULL`,
      [input.userId],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO user_mfa_factors (user_id, factor_type, secret_encrypted)
       VALUES ($1, 'TOTP', $2)
       RETURNING id`,
      [input.userId, encrypted],
    );

    // O segredo NUNCA entra na trilha: so o fato de o cadastro ter comecado.
    await recordIdentityAuditIn(client, {
      userId: input.userId,
      action: AUTH_AUDIT_ACTIONS.MFA_ENROLLMENT_STARTED,
      origin: input.origin,
      metadata: { factorId: rows[0]!.id, factorType: 'TOTP' },
    });
  });

  return {
    secret,
    otpauthUri: buildOtpauthUri({
      issuer: deps.config.MFA_ISSUER,
      accountName: input.email,
      secret,
    }),
  };
}

interface FactorRow {
  id: string;
  secret_encrypted: Buffer;
  confirmed_at: string | null;
  last_used_step: string | null;
}

/** Resultado de uma elevacao de sessao: o token novo precisa chegar ao cookie. */
export interface MfaElevation {
  readonly token: string;
}

type MfaOutcome =
  | { readonly kind: 'ok'; readonly token: string }
  | { readonly kind: 'no_factor' }
  | { readonly kind: 'invalid' };

/**
 * Confirma o cadastro com um codigo valido, satisfaz a sessao e rotaciona o
 * token.
 *
 * Confirmar exige provar que o aplicativo esta gerando o codigo certo — e essa
 * prova vale tanto quanto uma verificacao: ao final, a sessao esta elevada. Por
 * isso o cadastro recebe as MESMAS defesas da verificacao (bloqueio por
 * tentativas, anti-replay e rotacao de token) em vez de um caminho paralelo
 * mais fraco.
 */
export async function confirmMfaEnrollment(
  deps: AppDeps,
  input: { userId: string; sessionId: string; code: string; origin: AuditOrigin },
): Promise<MfaElevation> {
  await assertMfaNotLocked(deps, input.userId);

  const outcome = await withUser<MfaOutcome>(deps.pool, { userId: input.userId }, async (client) => {
    const { rows } = await client.query<FactorRow>(
      `SELECT id, secret_encrypted, confirmed_at, last_used_step
         FROM user_mfa_factors
        WHERE user_id = $1 AND factor_type = 'TOTP' AND confirmed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [input.userId],
    );
    const factor = rows[0];
    if (!factor) return { kind: 'no_factor' };

    const secret = deps.secretBox.decrypt(factor.secret_encrypted);
    const verification = verifyTotp({
      token: input.code,
      secret,
      afterTimeStep: factor.last_used_step === null ? null : Number(factor.last_used_step),
    });
    if (!verification.valid) return { kind: 'invalid' };

    await client.query(
      `UPDATE user_mfa_factors
          SET confirmed_at = now(), last_used_at = now(), last_used_step = $2
        WHERE id = $1`,
      [factor.id, verification.timeStep],
    );
    await clearMfaFailures(client, input.userId);
    await client.query('UPDATE sessions SET mfa_satisfied_at = now() WHERE id = $1', [
      input.sessionId,
    ]);
    const token = await rotateSessionToken(client, input.sessionId);

    await recordIdentityAuditIn(client, {
      userId: input.userId,
      action: AUTH_AUDIT_ACTIONS.MFA_ENROLLMENT_CONFIRMED,
      origin: input.origin,
      metadata: { factorId: factor.id, sessionId: input.sessionId, rotated: true },
    });

    return { kind: 'ok', token };
  });

  if (outcome.kind === 'ok') return { token: outcome.token };
  if (outcome.kind === 'no_factor') {
    throw ApiError.badRequest('Nenhum cadastro de segundo fator em andamento.');
  }

  await recordMfaFailure(deps, input.userId);
  throw ApiError.unauthenticated('Código inválido.');
}

/**
 * Satisfaz o segundo fator na sessao atual. RN12.
 *
 * Quatro protecoes, nesta ordem:
 *
 *  1. BLOQUEIO POR TENTATIVAS (`assertMfaNotLocked`).
 *
 *  2. ANTI-REPLAY. `afterTimeStep` recusa qualquer passo menor ou igual ao
 *     ultimo aceito: um codigo interceptado nao vale de novo dentro dos 30 s.
 *
 *  3. MARCACAO POR SESSAO. `mfa_satisfied_at` fica na SESSAO, nao no usuario:
 *     abrir outra sessao exige passar pelo fator outra vez.
 *
 *  4. ROTACAO DO TOKEN. O segredo portador entregue antes da elevacao deixa de
 *     valer no instante em que a sessao e elevada.
 *
 * A contagem da tentativa falha e gravada em transacao SEPARADA, e so depois o
 * erro e lancado. Incrementar e lancar dentro da mesma transacao desfaria o
 * incremento no rollback — e o bloqueio nunca chegaria a acontecer.
 */
export async function verifyMfaForSession(
  deps: AppDeps,
  input: { userId: string; sessionId: string; code: string; origin: AuditOrigin },
): Promise<MfaElevation> {
  await assertMfaNotLocked(deps, input.userId);

  const outcome = await withUser<MfaOutcome>(deps.pool, { userId: input.userId }, async (client) => {
    const { rows } = await client.query<FactorRow>(
      `SELECT id, secret_encrypted, confirmed_at, last_used_step
         FROM user_mfa_factors
        WHERE user_id = $1 AND factor_type = 'TOTP' AND confirmed_at IS NOT NULL
        LIMIT 1
        FOR UPDATE`,
      [input.userId],
    );
    const factor = rows[0];
    if (!factor) return { kind: 'no_factor' };

    const secret = deps.secretBox.decrypt(factor.secret_encrypted);
    const verification = verifyTotp({
      token: input.code,
      secret,
      afterTimeStep: factor.last_used_step === null ? null : Number(factor.last_used_step),
    });

    if (!verification.valid) return { kind: 'invalid' };

    await clearMfaFailures(client, input.userId);
    await client.query(
      'UPDATE user_mfa_factors SET last_used_at = now(), last_used_step = $2 WHERE id = $1',
      [factor.id, verification.timeStep],
    );
    await client.query('UPDATE sessions SET mfa_satisfied_at = now() WHERE id = $1', [
      input.sessionId,
    ]);
    const token = await rotateSessionToken(client, input.sessionId);

    await recordIdentityAuditIn(client, {
      userId: input.userId,
      action: AUTH_AUDIT_ACTIONS.MFA_VERIFIED,
      origin: input.origin,
      metadata: { factorId: factor.id, sessionId: input.sessionId, rotated: true },
    });

    return { kind: 'ok', token };
  });

  if (outcome.kind === 'ok') return { token: outcome.token };
  if (outcome.kind === 'no_factor') throw ApiError.mfaEnrollmentRequired();

  await recordMfaFailure(deps, input.userId);
  throw ApiError.unauthenticated('Código inválido ou já utilizado.');
}
