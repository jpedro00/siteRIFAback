import type { DbPool } from '@campaigns/db';
import { tenantCreatedPayloadSchema } from '@campaigns/shared';

/**
 * Consumidor do evento `tenant.created`: provisiona a marca padrao da
 * comunidade recem-criada.
 *
 * E o evento REAL da fundacao usado para verificar o fluxo
 * outbox -> fila -> efeito. Nao ha cobranca nem envio comercial aqui: a fase 1
 * nao executa nada disso.
 *
 * IDEMPOTENCIA — como funciona, na ordem exata:
 *
 *   1. Tenta INSERIR em `event_consumptions` (event_id, consumer).
 *   2. Se a insercao NAO afetou linha, este consumidor ja concluiu este evento
 *      antes. Retorna sem repetir o efeito.
 *   3. Se afetou, executa o efeito NA MESMA TRANSACAO da marca de conclusao.
 *
 *   A marca e o efeito vivem ou morrem juntos. Nao existe "marcado como feito
 *   sem ter feito", nem "feito sem marcar" — que causaria repeticao.
 *
 *   A chave inclui o nome do consumidor: outro consumidor do mesmo evento e
 *   outro trabalho, e precisa acontecer tambem.
 */
export const CONSUMER_NAME = 'provision-tenant-branding';

/** Marca padrao da plataforma. Campos que a comunidade nao definiu herdam daqui. */
const DEFAULT_COLORS = {
  primary: '#2F6FDB',
  secondary: '#1E88A8',
  background: '#F3F5F8',
  text: '#16202E',
} as const;

const DEFAULT_FONTS = {
  heading: 'Bricolage Grotesque',
  body: 'Atkinson Hyperlegible',
} as const;

export interface ConsumeResult {
  readonly applied: boolean;
  readonly reason?: 'already_consumed' | 'tenant_missing';
}

export async function provisionTenantBranding(
  pool: DbPool,
  input: { eventId: string; payload: unknown },
): Promise<ConsumeResult> {
  const payload = tenantCreatedPayloadSchema.parse(input.payload);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Passo 1 e 2: reivindicar o evento.
    const claim = await client.query(
      `INSERT INTO event_consumptions (event_id, consumer)
       VALUES ($1, $2)
       ON CONFLICT (event_id, consumer) DO NOTHING`,
      [input.eventId, CONSUMER_NAME],
    );

    if ((claim.rowCount ?? 0) === 0) {
      await client.query('COMMIT');
      return { applied: false, reason: 'already_consumed' };
    }

    // A comunidade pode ter sido removida entre a publicacao e o consumo.
    const tenant = await client.query('SELECT 1 FROM tenants WHERE id = $1', [payload.tenantId]);
    if ((tenant.rowCount ?? 0) === 0) {
      // O evento fica marcado como concluido: nao ha trabalho pendente para
      // uma comunidade que nao existe mais, e repetir a tentativa para sempre
      // so entupiria a fila.
      await client.query('COMMIT');
      return { applied: false, reason: 'tenant_missing' };
    }

    // Passo 3: o efeito, na mesma transacao.
    // `ON CONFLICT DO NOTHING` protege o caso de a marca ja ter sido criada
    // por outro caminho — e NAO sobrescreve o que a comunidade ja personalizou.
    await client.query(
      `INSERT INTO tenant_branding (tenant_id, public_name, colors, fonts)
       VALUES ($1, $2, $3::jsonb, $4::jsonb)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [
        payload.tenantId,
        payload.name,
        JSON.stringify(DEFAULT_COLORS),
        JSON.stringify(DEFAULT_FONTS),
      ],
    );

    await client.query(
      `INSERT INTO audit_events (tenant_id, actor_user_id, actor_type, action, target_type, target_id, after)
       VALUES ($1, NULL, 'SYSTEM', 'tenant.branding_provisioned', 'tenant', $2, $3::jsonb)`,
      [
        payload.tenantId,
        payload.tenantId,
        JSON.stringify({ colors: DEFAULT_COLORS, fonts: DEFAULT_FONTS }),
      ],
    );

    await client.query('COMMIT');
    return { applied: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.query('RESET ALL').catch(() => undefined);
    client.release();
  }
}
