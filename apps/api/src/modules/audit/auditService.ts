import type { PoolClient } from '@campaigns/db';

/**
 * M12 · trilha de auditoria. RN11.
 *
 * Recebe o CLIENT da transacao, nunca o pool: a trilha e gravada na MESMA
 * transacao da acao auditada. Se a acao sofrer rollback, a trilha nao fica
 * afirmando que algo aconteceu.
 *
 * Senha, token e segredo nao entram em `before`/`after`. Alem da disciplina no
 * chamador, o banco recusa chaves sensiveis (app.assert_no_secrets, 0001).
 */
export interface AuditInput {
  /** NULO para acao de plataforma, que nao pertence a nenhuma comunidade. */
  readonly tenantId: string | null;
  readonly actorUserId: string | null;
  readonly actorType?: 'USER' | 'PLATFORM' | 'SYSTEM';
  readonly action: string;
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

/**
 * Grava um evento na trilha.
 *
 * SEM `RETURNING`, de proposito. `INSERT ... RETURNING` faz a linha recem
 * inserida passar tambem pela policy de SELECT — nao apenas pela de INSERT. Numa
 * tabela somente-insercao isso acopla escrita a leitura pelo pior motivo: obriga
 * a abrir leitura sobre um registro so para confirmar que ele foi escrito.
 *
 * Foi exatamente o que manteve `audit_identity_insert` (0007) inoperante. A
 * policy de insercao autorizava o evento de identidade, mas a de leitura
 * (`audit_events_select`) so enxerga o que pertence a uma comunidade; a linha
 * era aceita na escrita e recusada no `RETURNING`, e o PostgreSQL relata os dois
 * casos com a MESMA mensagem ("new row violates row-level security policy"),
 * o que faz o erro parecer recusa de escrita.
 *
 * Nenhum chamador usa o identificador devolvido. Ele existia por habito.
 */
export async function recordAuditEvent(client: PoolClient, input: AuditInput): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (tenant_id, actor_user_id, actor_type, action, target_type, target_id, before, after, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::inet, $10)`,
    [
      input.tenantId,
      input.actorUserId,
      input.actorType ?? 'USER',
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.ip ?? null,
      input.userAgent ?? null,
    ],
  );
}

export interface AuditEventRow {
  id: string;
  occurred_at: string;
  action: string;
  actor_user_id: string | null;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
}

/**
 * Lista a trilha da comunidade do contexto.
 *
 * `before` e `after` NAO sao devolvidos nesta listagem: podem conter dado
 * pessoal do comprador, e ler a trilha nao e o mesmo direito que ler dado
 * pessoal (DOC-01 secao 3 separa os dois).
 */
export async function listTenantAuditEvents(
  client: PoolClient,
  options: { limit: number },
): Promise<AuditEventRow[]> {
  const { rows } = await client.query<AuditEventRow>(
    `SELECT id, occurred_at, action, actor_user_id, target_type, target_id, host(ip) AS ip
       FROM audit_events
      ORDER BY occurred_at DESC
      LIMIT $1`,
    [Math.min(Math.max(options.limit, 1), 200)],
  );
  return rows;
}
