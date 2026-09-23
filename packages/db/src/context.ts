import type { DbPool, PoolClient } from './pool.js';

/**
 * Contexto de execucao de uma transacao.
 *
 * RN01. Tudo o que a RLS usa para decidir o que a transacao enxerga vem daqui
 * — e SOMENTE daqui. Nenhuma consulta de negocio roda fora de um contexto.
 */
export interface DbContext {
  /** Usuario autenticado. Ausente em rota publica. */
  readonly userId?: string | null;
  /** Comunidade resolvida e JA validada contra o vinculo do usuario. */
  readonly tenantId?: string | null;
  /**
   * Acesso de plataforma. So deve ser ligado depois que a API verificou papel
   * de plataforma E segundo fator satisfeito (RN12).
   */
  readonly platformAccess?: boolean;
}

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, field: string): void {
  if (!UUID_RE.test(value)) {
    throw new TenantContextError(`${field} deve ser um UUID; recebido: ${JSON.stringify(value)}`);
  }
}

/**
 * Executa `fn` dentro de UMA transacao com o contexto aplicado.
 *
 * Por que `set_config(..., true)` e nao `SET`:
 *   o terceiro argumento `true` significa "local a transacao". O valor morre
 *   no COMMIT ou no ROLLBACK. Uma conexao devolvida ao pool e reaproveitada
 *   por outra requisicao NAO carrega o tenant anterior. Com `SET` comum, o
 *   valor sobreviveria na conexao e a requisicao seguinte leria dados da
 *   comunidade errada.
 *
 * Por que `RESET ALL` antes de devolver a conexao:
 *   defesa em profundidade. Se algum codigo futuro executar `SET` em vez de
 *   `SET LOCAL`, o reset apaga o residuo antes de a conexao voltar ao pool.
 *
 * O contexto e passado como PARAMETRO de `set_config`, nunca interpolado em
 * SQL.
 */
export async function withContext<T>(
  pool: DbPool,
  context: DbContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const { userId, tenantId, platformAccess } = context;

  if (userId != null) assertUuid(userId, 'userId');
  if (tenantId != null) assertUuid(tenantId, 'tenantId');

  const client = await pool.connect();
  let released = false;

  try {
    await client.query('BEGIN');

    // Um set_config por chave, sempre local a transacao.
    await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId ?? '']);
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId ?? '']);
    await client.query('SELECT set_config($1, $2, true)', [
      'app.platform_access',
      platformAccess === true ? 'on' : 'off',
    ]);

    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Conexao ja quebrada: destruir em vez de devolver ao pool suja.
      client.release(true);
      released = true;
    }
    throw error;
  } finally {
    if (!released) {
      try {
        await client.query('RESET ALL');
        client.release();
      } catch {
        client.release(true);
      }
    }
  }
}

/**
 * Contexto de comunidade. Recusa chamada sem tenantId em vez de rodar sem
 * filtro: um `withTenant(undefined)` silencioso viraria consulta de plataforma.
 */
export async function withTenant<T>(
  pool: DbPool,
  input: { tenantId: string; userId?: string | null },
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!input.tenantId) {
    throw new TenantContextError(
      'withTenant exige tenantId. Sem contexto de comunidade, o acesso e negado (RN01).',
    );
  }
  return withContext(
    pool,
    { tenantId: input.tenantId, userId: input.userId ?? null, platformAccess: false },
    fn,
  );
}

/**
 * Contexto de plataforma (Super Admin). Exige o usuario identificado: nao
 * existe acao de plataforma anonima — a auditoria precisa do ator (RN11).
 */
export async function withPlatform<T>(
  pool: DbPool,
  input: { userId: string },
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!input.userId) {
    throw new TenantContextError('withPlatform exige userId identificado (RN11).');
  }
  return withContext(pool, { userId: input.userId, tenantId: null, platformAccess: true }, fn);
}

/**
 * Contexto somente de identidade: usuario conhecido, nenhuma comunidade aberta.
 * Usado no login, na sessao e no cadastro de MFA.
 */
export async function withUser<T>(
  pool: DbPool,
  input: { userId: string },
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!input.userId) {
    throw new TenantContextError('withUser exige userId.');
  }
  return withContext(pool, { userId: input.userId, tenantId: null, platformAccess: false }, fn);
}

/**
 * Contexto vazio: sem usuario, sem comunidade, sem plataforma.
 * Usado apenas nos caminhos que rodam ANTES de haver contexto — resolucao de
 * comunidade por dominio e validacao de token de sessao —, que passam por
 * funcoes SECURITY DEFINER de projecao minima.
 */
export async function withoutContext<T>(
  pool: DbPool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withContext(pool, { userId: null, tenantId: null, platformAccess: false }, fn);
}
