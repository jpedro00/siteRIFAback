import type { PoolClient } from '@clubedarifa/db';
import {
  ENTITLEMENT_REASONS,
  ENTITLEMENT_REASON_MESSAGES,
  apiErrorCodeForEntitlement,
  type BillingState,
  type EntitlementCheck,
  type EntitlementReason,
  type EntitlementsResponse,
} from '@clubedarifa/shared';
import { ApiError } from '../../lib/apiError.js';

/**
 * EntitlementService: o ponto UNICO por onde a API fala de direitos comerciais da
 * comunidade (plano, limites, consumo, funcionalidades).
 *
 * A REGRA mora no banco (migration 0018) e este arquivo so a LE ou traduz o que ela
 * decidiu — nenhum controller reimplementa contagem, estado ou limite. Ha dois usos, e
 * nao se misturam:
 *
 *  1. EXIBIR (`readEntitlements`, `checkFeature`): leitura sem lock. Serve para a tela
 *     dizer "voce esta em 4 de 5". NUNCA autoriza uma mutacao: entre a leitura e o clique
 *     o consumo pode ter mudado.
 *  2. AUTORIZAR uma mutacao: acontece DENTRO da transacao da propria operacao, no banco
 *     (gatilho de envio de sorteio; aceite de convite), sob lock por comunidade. O que a
 *     API faz aqui e TRADUZIR o erro (`translateEntitlementError`).
 *
 * Sao dois direitos independentes: o PAPEL do usuario (matriz de permissoes) e o direito
 * COMERCIAL da comunidade. Uma assinatura nao concede privilegio administrativo, e ser
 * dono nao ultrapassa o limite do plano.
 */

const REASONS = new Set<string>(ENTITLEMENT_REASONS);

/** "used=4;max=5" -> { used: 4, max: 5 } (max vazio = ilimitado). */
function parseDetail(detail: unknown): { used: number | null; max: number | null } {
  const text = typeof detail === 'string' ? detail : '';
  const used = /used=(\d+)/.exec(text)?.[1];
  const max = /max=(\d+)/.exec(text)?.[1];
  return { used: used === undefined ? null : Number(used), max: max === undefined ? null : Number(max) };
}

/**
 * Converte a recusa do banco (`ENTITLEMENT:<motivo>`) em erro da API com codigo do
 * contrato. Qualquer outro erro passa intacto. So o motivo, o consumo e o limite saem:
 * nada da Stripe, nada de outra comunidade.
 */
export function translateEntitlementError(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return error;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== 'string' || !message.startsWith('ENTITLEMENT:')) return error;

  const reason = message.slice('ENTITLEMENT:'.length).trim();
  if (!REASONS.has(reason)) return error;
  const motivo = reason as EntitlementReason;
  const { used, max } = parseDetail((error as { detail?: unknown }).detail);
  return new ApiError(apiErrorCodeForEntitlement(motivo), ENTITLEMENT_REASON_MESSAGES[motivo], {
    reason: motivo,
    ...(used !== null ? { used } : {}),
    ...(max !== null ? { max } : {}),
  });
}

/** Roda uma operacao que pode ser barrada pelo banco e devolve o erro ja traduzido. */
export async function withEntitlementErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw translateEntitlementError(error);
  }
}

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

/**
 * Situacao comercial da comunidade, para EXIBICAO. Sem lock: e uma fotografia.
 * O `canSubmitDraws` daqui e a resposta de agora; a autorizacao real acontece no envio.
 */
export async function readEntitlements(client: PoolClient, tenantId: string): Promise<EntitlementsResponse> {
  const { rows } = await client.query<{
    state: BillingState;
    plan_code: string | null;
    max_active_draws: number | null;
    max_team_members: number | null;
    features: string[] | null;
    enforcement_enabled: boolean;
    grace_ends_at: Date | null;
    draws_used: number;
    team_used: number;
  }>('SELECT * FROM app.tenant_entitlements($1)', [tenantId]);
  const e = rows[0];
  if (!e) throw ApiError.notFound('Comunidade não encontrada.');

  const { rows: verdict } = await client.query<{ allowed: boolean; reason: EntitlementReason }>(
    'SELECT allowed, reason FROM app.draw_submission_verdict($1)',
    [tenantId],
  );
  return {
    state: e.state,
    enforcementEnabled: e.enforcement_enabled,
    planCode: e.plan_code,
    features: e.features ?? [],
    activeDraws: { used: e.draws_used, max: e.max_active_draws },
    teamMembers: { used: e.team_used, max: e.max_team_members },
    graceEndsAt: iso(e.grace_ends_at),
    canSubmitDraws: verdict[0]!.allowed,
    reason: verdict[0]!.reason,
  };
}

/** Veredito de uma funcionalidade do plano (leitura). Nao concede nada: veja `requireFeature`. */
export async function checkFeature(
  client: PoolClient,
  tenantId: string,
  feature: string,
): Promise<Pick<EntitlementCheck, 'allowed' | 'reason'>> {
  const { rows } = await client.query<{ allowed: boolean; reason: EntitlementReason }>(
    'SELECT allowed, reason FROM app.tenant_feature_verdict($1, $2)',
    [tenantId, feature],
  );
  return rows[0] ?? { allowed: false, reason: 'FORBIDDEN' };
}

/**
 * Exige o direito comercial a uma funcionalidade. E a SEGUNDA condicao de acesso: o
 * chamador ja precisa ter passado pela permissao de papel (`authorizeRoute`). Rotas de
 * funcionalidades pagas chamam isto dentro da transacao da operacao.
 */
export async function requireFeature(client: PoolClient, tenantId: string, feature: string): Promise<void> {
  const verdict = await checkFeature(client, tenantId, feature);
  if (verdict.allowed) return;
  throw new ApiError(apiErrorCodeForEntitlement(verdict.reason), ENTITLEMENT_REASON_MESSAGES[verdict.reason], {
    reason: verdict.reason,
  });
}
