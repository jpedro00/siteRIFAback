import { createPool, migrate, type DbPool } from '@clubedarifa/db';
import { createLogger } from '@clubedarifa/logging';

/**
 * Bancada dos testes de job e de consumidor do worker.
 *
 * Semeia pelo papel DONO (legitimo: o que se prova e o que o WORKER faz, nao a
 * criacao do cenario) e executa com o papel restrito `app_worker`.
 */
export const OWNER_URL = process.env['TEST_MIGRATION_DATABASE_URL'] ?? '';
export const WORKER_URL = process.env['TEST_WORKER_DATABASE_URL'] ?? '';
export const hasDb = OWNER_URL !== '' && WORKER_URL !== '';
export const skipReason =
  'PULADO: defina TEST_MIGRATION_DATABASE_URL e TEST_WORKER_DATABASE_URL para os testes do worker.';

/** Logger silencioso: os testes afirmam sobre o BANCO, nao sobre o texto do log. */
export const silentLog = createLogger({ write: () => undefined });

export function unique(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export interface Bench {
  readonly owner: DbPool;
  readonly worker: DbPool;
  close(): Promise<void>;
}

export async function openBench(applicationName: string): Promise<Bench> {
  await migrate(OWNER_URL);
  const owner = createPool({ connectionString: OWNER_URL, applicationName: `${applicationName}-owner`, max: 4 });
  const worker = createPool({ connectionString: WORKER_URL, applicationName: `${applicationName}-worker`, max: 4 });
  return {
    owner,
    worker,
    async close() {
      await owner.end();
      await worker.end();
    },
  };
}

export async function seedTenant(owner: DbPool, name = 'Comunidade do Worker'): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
    [unique('w-'), name],
  );
  return rows[0]!.id;
}

export interface DrawOptions {
  status?: string;
  total?: number;
  closeMode?: string;
  closeAt?: string | null;
  salesStartAt?: string | null;
  thresholds?: number[];
}

export async function seedDraw(owner: DbPool, tenantId: string, o: DrawOptions = {}): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers, status,
                        close_mode, close_at, sales_start_at, thresholds)
     VALUES ($1, $2, 'Sorteio do Worker', 'Premio', 1000, $3, $4::draw_status,
             $5::draw_close_mode, $6::timestamptz, $7::timestamptz, COALESCE($8::int[], '{25,10}'))
     RETURNING id`,
    [
      tenantId,
      unique('d-'),
      o.total ?? 100,
      o.status ?? 'ATIVA',
      o.closeMode ?? 'AO_ESGOTAR',
      o.closeAt ?? null,
      o.salesStartAt ?? null,
      o.thresholds ?? null,
    ],
  );
  return rows[0]!.id;
}

export interface SeededOrder {
  orderId: string;
  paymentId: string | null;
  providerPaymentId: string | null;
  reservationId: string;
}

/** Pedido PENDENTE com numeros PENDENTE e, por padrao, uma cobranca PIX (FAKE). */
export async function seedPendingOrder(
  owner: DbPool,
  tenantId: string,
  drawId: string,
  numeros: number[],
  o: { payment?: boolean; paymentExpiresAgo?: string; reservationExpiresAgo?: string; provider?: string } = {},
): Promise<SeededOrder> {
  const { rows: b } = await owner.query<{ id: string }>(
    'INSERT INTO buyers (tenant_id, name, phone) VALUES ($1, $2, $3) RETURNING id',
    [tenantId, 'Maria Souza', '+55 11 91234-5678'],
  );
  const reservaVenceHa = o.reservationExpiresAgo ?? '10 minutes';
  const { rows: r } = await owner.query<{ id: string }>(
    `INSERT INTO reservations (tenant_id, draw_id, status, created_at, expires_at, unit_price_cents)
     VALUES ($1, $2, 'CONVERTIDA', now() - interval '40 minutes', now() - $3::interval, 1000) RETURNING id`,
    [tenantId, drawId, reservaVenceHa],
  );
  const { rows: ord } = await owner.query<{ id: string }>(
    `INSERT INTO orders (tenant_id, draw_id, buyer_id, reservation_id, status, unit_price_cents, quantity,
                         total_cents, accepted_terms_at)
     VALUES ($1, $2, $3, $4, 'PENDENTE', 1000, $5, $6, now() - interval '35 minutes') RETURNING id`,
    [tenantId, drawId, b[0]!.id, r[0]!.id, numeros.length, numeros.length * 1000],
  );
  const orderId = ord[0]!.id;
  await owner.query(
    'INSERT INTO order_items (tenant_id, order_id, number, unit_price_cents) SELECT $1, $2, n, 1000 FROM unnest($3::int[]) AS n',
    [tenantId, orderId, numeros],
  );
  await owner.query(
    `INSERT INTO draw_numbers (tenant_id, draw_id, number, status, order_id, reservation_id, expires_at)
     SELECT $1, $2, n, 'PENDENTE', $3, $4, now() FROM unnest($5::int[]) AS n`,
    [tenantId, drawId, orderId, r[0]!.id, numeros],
  );

  let paymentId: string | null = null;
  let providerPaymentId: string | null = null;
  if (o.payment !== false) {
    providerPaymentId = String(900_000_000 + Math.floor(Math.random() * 90_000_000));
    const { rows: p } = await owner.query<{ id: string }>(
      `INSERT INTO payments (tenant_id, order_id, provider, provider_payment_id, status, idempotency_key,
                             amount_cents, expires_at)
       VALUES ($1, $2, $3, $4, 'PENDENTE', $5, $6, now() - $7::interval) RETURNING id`,
      [tenantId, orderId, o.provider ?? 'FAKE', providerPaymentId, orderId, numeros.length * 1000, o.paymentExpiresAgo ?? '10 minutes'],
    );
    paymentId = p[0]!.id;
  }
  return { orderId, paymentId, providerPaymentId, reservationId: r[0]!.id };
}

/** Marca numeros como vendidos (PAGO), de um pedido novo, sem passar pelo fluxo. */
export async function seedPaidNumbers(
  owner: DbPool,
  tenantId: string,
  drawId: string,
  numeros: number[],
): Promise<string> {
  const { rows: b } = await owner.query<{ id: string }>(
    'INSERT INTO buyers (tenant_id, name, phone) VALUES ($1, $2, $3) RETURNING id',
    [tenantId, 'Joao Pereira', '(21) 99876-0001'],
  );
  const { rows: o } = await owner.query<{ id: string }>(
    `INSERT INTO orders (tenant_id, draw_id, buyer_id, status, unit_price_cents, quantity, total_cents,
                         accepted_terms_at, paid_at)
     VALUES ($1, $2, $3, 'PAGO', 1000, $4, $5, now(), now()) RETURNING id`,
    [tenantId, drawId, b[0]!.id, numeros.length, numeros.length * 1000],
  );
  const orderId = o[0]!.id;
  await owner.query(
    'INSERT INTO order_items (tenant_id, order_id, number, unit_price_cents) SELECT $1, $2, n, 1000 FROM unnest($3::int[]) AS n',
    [tenantId, orderId, numeros],
  );
  await owner.query(
    "INSERT INTO draw_numbers (tenant_id, draw_id, number, status, order_id) SELECT $1, $2, n, 'PAGO', $3 FROM unnest($4::int[]) AS n",
    [tenantId, drawId, orderId, numeros],
  );
  return orderId;
}

/** Grava um evento na outbox (o consumidor reivindica por ele) e devolve o id. */
export async function seedOutboxEvent(
  owner: DbPool,
  tenantId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    'INSERT INTO outbox (tenant_id, event_type, payload) VALUES ($1, $2, $3::jsonb) RETURNING id',
    [tenantId, eventType, JSON.stringify(payload)],
  );
  return rows[0]!.id;
}

export async function statusOf(owner: DbPool, table: 'orders' | 'draws' | 'payments' | 'reservations', id: string) {
  const { rows } = await owner.query<{ s: string }>(`SELECT status::text AS s FROM ${table} WHERE id = $1`, [id]);
  return rows[0]!.s;
}

export async function numberStatuses(owner: DbPool, drawId: string): Promise<Map<number, string>> {
  const { rows } = await owner.query<{ number: number; s: string }>(
    'SELECT number, status::text AS s FROM draw_numbers WHERE draw_id = $1',
    [drawId],
  );
  return new Map(rows.map((r) => [r.number, r.s]));
}
