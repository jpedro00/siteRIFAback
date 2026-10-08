import type { PoolClient } from '@clubedarifa/db';

/**
 * Meios de pagamento que o CRIADOR desligou (vazio = nenhum).
 *
 * Tolerante a migration pendente: se a tabela `tenant_payment_preferences` (migration 0026) ainda
 * nao existe no banco, o resultado e "nada desligado" — o comportamento anterior. Assim o codigo
 * pode ser publicado antes da migration sem derrubar a reserva nem o PIX. Usa SAVEPOINT porque, no
 * PostgreSQL, uma consulta que falha aborta a transacao inteira.
 */
export async function creatorDisabledMethods(client: PoolClient, tenantId: string): Promise<string[]> {
  await client.query('SAVEPOINT payment_prefs_read');
  try {
    const { rows } = await client.query<{ disabled_methods: string[] }>(
      'SELECT disabled_methods FROM tenant_payment_preferences WHERE tenant_id = $1',
      [tenantId],
    );
    await client.query('RELEASE SAVEPOINT payment_prefs_read');
    return rows[0]?.disabled_methods ?? [];
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT payment_prefs_read');
    // 42P01 = undefined_table: a migration ainda nao foi aplicada.
    if ((error as { code?: string }).code === '42P01') return [];
    throw error;
  }
}
