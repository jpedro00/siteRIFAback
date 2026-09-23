import { withUser, type PoolClient } from '@campaigns/db';
import type { AppDeps } from '../../deps.js';
import { recordAuditEvent } from './auditService.js';

/**
 * M12 · trilha de auditoria da IDENTIDADE. RN11.
 *
 * Login, logout e segundo fator acontecem ANTES de existir comunidade, e podem
 * acontecer para quem nao tem comunidade nenhuma. Por isso estes eventos tem
 * `tenant_id` NULO — inventar um "tenant tecnico" para abriga-los criaria um
 * balde onde dados de varias comunidades se encontrariam.
 *
 * O CONTRATO COM A POLICY (`audit_identity_insert`, migration 0007) e estreito
 * e esta refletido aqui, num unico lugar:
 *
 *   tenant_id IS NULL
 *   AND actor_type = 'USER'
 *   AND actor_user_id = app.current_user_id()
 *   AND action LIKE 'auth.%'
 *
 * A terceira condicao e a que importa: o evento so entra se o usuario do
 * CONTEXTO for o proprio ator. Ninguem grava trilha em nome de outra pessoa —
 * nem por engano da aplicacao, porque quem recusa e o banco.
 *
 * POR QUE NAO HA TRILHA PARA E-MAIL INEXISTENTE: `auth.login.failed` exige um
 * ator identificado (a CHECK `audit_events_human_actor_identified` de 0004).
 * Uma tentativa contra um e-mail que nao existe nao tem ator a quem atribuir, e
 * registra-la sob um ator de sistema transformaria a trilha num log de
 * enderecos sondados — dado pessoal de nao-usuarios, acumulado sem proposito.
 * A contagem desse caso pertence a metricas, nao a RN11.
 */

/**
 * Acoes de identidade. Os nomes seguem o prefixo exigido pela policy e o
 * padrao `dominio.acao` ja usado por `tenant.created`.
 */
export const AUTH_AUDIT_ACTIONS = {
  LOGIN_SUCCEEDED: 'auth.login.succeeded',
  LOGIN_FAILED: 'auth.login.failed',
  LOGOUT: 'auth.logout',
  LOGOUT_ALL: 'auth.logout_all',
  MFA_ENROLLMENT_STARTED: 'auth.mfa.enrollment_started',
  MFA_ENROLLMENT_CONFIRMED: 'auth.mfa.enrollment_confirmed',
  MFA_VERIFIED: 'auth.mfa.verified',
  ACCOUNT_LOCKED: 'auth.account_locked',
} as const;

export type AuthAuditAction = (typeof AUTH_AUDIT_ACTIONS)[keyof typeof AUTH_AUDIT_ACTIONS];

/** Origem da requisicao, propagada de `req.context` ate a trilha. */
export interface AuditOrigin {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface IdentityAuditInput {
  readonly userId: string;
  readonly action: AuthAuditAction;
  readonly origin: AuditOrigin;
  /**
   * Metadados seguros. Senha, segredo TOTP, token e cookie NUNCA entram aqui —
   * e `app.assert_no_secrets` (0001) recusa a insercao se entrarem, de modo que
   * a disciplina do chamador nao e a unica linha de defesa.
   */
  readonly metadata?: Record<string, unknown>;
  readonly targetId?: string | null;
}

/** Grava a trilha DENTRO de uma transacao ja aberta com o contexto do usuario. */
export async function recordIdentityAuditIn(
  client: PoolClient,
  input: IdentityAuditInput,
): Promise<void> {
  await recordAuditEvent(client, {
    tenantId: null,
    actorUserId: input.userId,
    actorType: 'USER',
    action: input.action,
    targetType: 'user',
    targetId: input.targetId ?? input.userId,
    after: input.metadata ?? null,
    ip: input.origin.ip,
    userAgent: input.origin.userAgent,
  });
}

/**
 * Grava a trilha em transacao propria.
 *
 * Usado quando a acao auditada NAO tem transacao de negocio a que se juntar —
 * tipicamente uma tentativa recusada. Quando existe uma mudanca a registrar
 * junto (abrir sessao, confirmar fator), use `recordIdentityAuditIn` dentro da
 * transacao da mudanca: trilha e efeito precisam viver ou morrer juntos.
 */
export async function recordIdentityAudit(
  deps: AppDeps,
  input: IdentityAuditInput,
): Promise<void> {
  await withUser(deps.pool, { userId: input.userId }, async (client) => {
    await recordIdentityAuditIn(client, input);
  });
}
