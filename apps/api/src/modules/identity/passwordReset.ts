import { createHash, randomBytes } from 'node:crypto';
import { withoutContext } from '@clubedarifa/db';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';
import { LoginThrottle } from '../../lib/loginThrottle.js';
import { hashPassword } from '../../lib/password.js';
import { undeliverablePasswordResetNotifier } from '../../lib/passwordResetNotifier.js';
import { AUTH_AUDIT_ACTIONS, recordIdentityAudit } from '../audit/identityAudit.js';

/**
 * Recuperacao de senha. Identidade GLOBAL: o mesmo fluxo serve participante, dono,
 * equipe e Super Admin.
 *
 * - Pedido: resposta uniforme (exista a conta ou nao). So existindo, gera-se o token,
 *   grava-se o HASH dele (uso unico, validade curta, tokens anteriores invalidados) e a
 *   entrega e delegada ao notificador.
 * - Redefinicao: token valido + senha nova (mesmo scrypt do cadastro e do login). Revoga
 *   todas as sessoes da conta e zera bloqueio e tentativas.
 */

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateResetToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashResetToken(token) };
}

/**
 * Limite por origem para os DOIS endpoints, separado do limite de login: pedir ou tentar
 * redefinir muitas vezes nao deve trancar quem so quer entrar, e vice-versa. Estado em
 * memoria por instancia de `deps` (cada bancada de teste tem o proprio balde).
 */
const throttles = new WeakMap<AppDeps, LoginThrottle>();
function resetThrottle(deps: AppDeps): LoginThrottle {
  let t = throttles.get(deps);
  if (!t) {
    // Mesmos limites por origem do login (config), em balde proprio.
    t = new LoginThrottle({
      windowMs: deps.config.LOGIN_ORIGIN_WINDOW_MINUTES * 60_000,
      maxFailures: deps.config.LOGIN_ORIGIN_MAX_FAILURES,
      maxDistinctAccounts: deps.config.LOGIN_ORIGIN_MAX_ACCOUNTS,
    });
    throttles.set(deps, t);
  }
  return t;
}

function enforceThrottle(deps: AppDeps, ip: string | null): void {
  const decision = resetThrottle(deps).check(ip);
  if (!decision.allowed) {
    throw ApiError.rateLimited('Muitas tentativas a partir deste dispositivo. Aguarde e tente novamente.', {
      retryAfterSeconds: decision.retryAfterSeconds,
    });
  }
}

export async function requestPasswordReset(
  deps: AppDeps,
  input: { email: string; ip: string | null; userAgent: string | null },
): Promise<void> {
  const email = input.email.trim().toLowerCase();
  enforceThrottle(deps, input.ip);
  // Cada pedido conta contra a origem, exista a conta ou nao: nao ha como sondar e-mails
  // pela diferenca de tratamento.
  resetThrottle(deps).recordFailure(input.ip, email);

  const { token, hash } = generateResetToken();
  const created = await withoutContext(deps.pool, async (client) => {
    const { rows } = await client.query<{ user_id: string; email: string; display_name: string }>(
      'SELECT user_id, email, display_name FROM app.request_password_reset($1, $2, $3, $4)',
      [email, hash, deps.config.PASSWORD_RESET_TTL_MINUTES, deps.config.PASSWORD_RESET_COOLDOWN_SECONDS],
    );
    return rows[0] ?? null;
  });
  if (!created) return;

  await recordIdentityAudit(deps, {
    userId: created.user_id,
    action: AUTH_AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
    origin: { ip: input.ip, userAgent: input.userAgent },
    // Sem token, sem hash do token.
    metadata: { ttlMinutes: deps.config.PASSWORD_RESET_TTL_MINUTES },
  });

  const base = deps.config.PASSWORD_RESET_URL;
  const notifier = deps.passwordResetNotifier ?? undeliverablePasswordResetNotifier;
  try {
    await notifier.send({
      email: created.email,
      displayName: created.display_name,
      token,
      expiresAt: new Date(Date.now() + deps.config.PASSWORD_RESET_TTL_MINUTES * 60_000),
      resetUrl: base ? `${base}#token=${token}` : null,
    });
  } catch {
    // Falha de entrega nao pode virar diferenca visivel de resposta (enumeracao).
  }
}

export async function resetPassword(
  deps: AppDeps,
  input: { token: string; password: string; ip: string | null; userAgent: string | null },
): Promise<void> {
  enforceThrottle(deps, input.ip);

  const passwordHash = await hashPassword(input.password);
  const done = await withoutContext(deps.pool, async (client) => {
    const { rows } = await client.query<{ user_id: string; revoked_sessions: number }>(
      'SELECT user_id, revoked_sessions FROM app.reset_password($1, $2)',
      [hashResetToken(input.token), passwordHash],
    );
    return rows[0] ?? null;
  });

  if (!done) {
    resetThrottle(deps).recordFailure(input.ip, 'token');
    // Uma resposta so para token desconhecido, usado, revogado ou vencido.
    throw ApiError.badRequest('Link de redefinição inválido ou expirado. Peça um novo.');
  }

  await recordIdentityAudit(deps, {
    userId: done.user_id,
    action: AUTH_AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED,
    origin: { ip: input.ip, userAgent: input.userAgent },
    metadata: { revokedSessions: done.revoked_sessions },
  });
}
