import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/context.js';
import type { DbPool } from '../src/pool.js';
import {
  appPool,
  describeSkipReason,
  ensureMigrated,
  hasTestDatabase,
  ownerPool,
  resetFoundationTables,
  seedTenant,
  unique,
  workerPool,
} from './helpers/testDb.js';

/**
 * 0015 · as funcoes de estado do pagamento e as do worker.
 *
 * O que se prova: (1) a transicao para PAGO e UMA so, idempotente e escopada por
 * comunidade; (2) so o worker executa o que e do worker; (3) nada toca em numero
 * PAGO; (4) arquivar nunca apaga a trilha de auditoria.
 */
describe.skipIf(!hasTestDatabase)(`0015 · automacao ${hasTestDatabase ? '' : describeSkipReason()}`, () => {
  let owner: DbPool;
  let app: DbPool;
  let worker: DbPool;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    await ensureMigrated();
    owner = ownerPool();
    app = appPool();
    worker = workerPool();
    await resetFoundationTables();
    tenantA = (await seedTenant(owner, unique('auto-a-'), 'A')).tenantId;
    tenantB = (await seedTenant(owner, unique('auto-b-'), 'B')).tenantId;
  }, 120_000);

  afterAll(async () => {
    await owner?.end();
    await app?.end();
    await worker?.end();
  });

  // ---- cenario ------------------------------------------------------------

  async function sorteio(tenant = tenantA, status = 'ATIVA', total = 100): Promise<string> {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers, status)
       VALUES ($1, $2, 'S', 'P', 1000, $3, $4::draw_status) RETURNING id`,
      [tenant, unique('s-'), total, status],
    );
    return rows[0]!.id;
  }

  /** Pedido PENDENTE com os numeros PENDENTE e, se pedido, uma cobranca. */
  async function pedido(
    drawId: string,
    numeros: number[],
    opts: { tenant?: string; comCobranca?: boolean; expiraEm?: string; provider?: string } = {},
  ) {
    const tenant = opts.tenant ?? tenantA;
    const { rows: b } = await owner.query<{ id: string }>(
      'INSERT INTO buyers (tenant_id, name, phone) VALUES ($1, $2, $3) RETURNING id',
      [tenant, 'Maria Souza', '+55 11 91234-5678'],
    );
    const { rows: r } = await owner.query<{ id: string }>(
      `INSERT INTO reservations (tenant_id, draw_id, status, expires_at, unit_price_cents)
       VALUES ($1, $2, 'CONVERTIDA', now() + interval '20 minutes', 1000) RETURNING id`,
      [tenant, drawId],
    );
    const { rows: o } = await owner.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, draw_id, buyer_id, reservation_id, status, unit_price_cents,
                           quantity, total_cents, accepted_terms_at)
       VALUES ($1, $2, $3, $4, 'PENDENTE', 1000, $5, $6, now()) RETURNING id`,
      [tenant, drawId, b[0]!.id, r[0]!.id, numeros.length, numeros.length * 1000],
    );
    const orderId = o[0]!.id;
    await owner.query(
      'INSERT INTO order_items (tenant_id, order_id, number, unit_price_cents) SELECT $1, $2, n, 1000 FROM unnest($3::int[]) AS n',
      [tenant, orderId, numeros],
    );
    await owner.query(
      `INSERT INTO draw_numbers (tenant_id, draw_id, number, status, order_id, reservation_id, expires_at)
       SELECT $1, $2, n, 'PENDENTE', $3, $4, now() + interval '20 minutes' FROM unnest($5::int[]) AS n`,
      [tenant, drawId, orderId, r[0]!.id, numeros],
    );
    let paymentId: string | null = null;
    let providerPaymentId: string | null = null;
    if (opts.comCobranca !== false) {
      providerPaymentId = String(Math.floor(Math.random() * 1e9));
      const { rows: p } = await owner.query<{ id: string }>(
        `INSERT INTO payments (tenant_id, order_id, provider, provider_payment_id, status, idempotency_key,
                               amount_cents, expires_at)
         VALUES ($1, $2, $3, $4, 'PENDENTE', $5, $6, COALESCE($7::timestamptz, now() + interval '20 minutes'))
         RETURNING id`,
        [tenant, orderId, opts.provider ?? 'FAKE', providerPaymentId, orderId, numeros.length * 1000, opts.expiraEm ?? null],
      );
      paymentId = p[0]!.id;
    }
    return { orderId, paymentId, providerPaymentId, reservationId: r[0]!.id };
  }

  const statusPedido = async (id: string) =>
    (await owner.query<{ s: string }>('SELECT status::text AS s FROM orders WHERE id = $1', [id])).rows[0]!.s;
  const numerosDoPedido = async (id: string) =>
    (await owner.query<{ s: string }>('SELECT status::text AS s FROM draw_numbers WHERE order_id = $1 ORDER BY number', [id])).rows.map((r) => r.s);

  const settleComoWorker = (orderId: string, paymentId: string | null) =>
    worker.query<{ r: string }>('SELECT app.settle_order_paid($1, $2, $3) AS r', [orderId, paymentId, 'TESTE']);

  const aplicar = (provider: string, id: string, status: string, cents: number, ref: string) =>
    worker.query<{ r: string }>(
      'SELECT app.apply_psp_payment($1, $2, $3, $4, $5, NULL, $6::jsonb) AS r',
      [provider, id, status, cents, ref, '{}'],
    );

  // -------------------------------------------------------------------------
  describe('quem executa o que', () => {
    it('o worker executa as suas funcoes; a aplicacao NAO', async () => {
      const funcoes = [
        ['app.worker_expire_reservations(10)'],
        ["app.worker_archive_outbox(30, 10)"],
        ["app.worker_reconcile_local('7 days')"],
        ["app.worker_release_order('00000000-0000-4000-8000-000000000000', 'x')"],
        ["app.worker_record_job_run('t', 60, now(), now(), 0, NULL)"],
      ];
      for (const [f] of funcoes) {
        await expect(worker.query(`SELECT ${f}`), `worker → ${f}`).resolves.toBeDefined();
        await expect(app.query(`SELECT ${f}`), `app_user → ${f}`).rejects.toThrow(/permission denied/i);
      }
    });

    it('aplicacao e worker executam AS MESMAS funcoes de pagamento', async () => {
      const id = '00000000-0000-4000-8000-000000000000';
      await expect(
        withTenant(app, { tenantId: tenantA }, (c) => c.query('SELECT app.apply_psp_payment($1, $2, $3, 1, NULL, NULL, NULL)', ['FAKE', 'x', 'PENDENTE'])),
      ).resolves.toBeDefined();
      await expect(worker.query('SELECT app.settle_order_paid($1, NULL, $2)', [id, 'x'])).rejects.toThrow(/inexistente/);
    });

    it('o worker le pedidos e pagamentos, mas nao os altera nem le compradores', async () => {
      await expect(worker.query('SELECT count(*) FROM orders')).resolves.toBeDefined();
      await expect(worker.query('SELECT count(*) FROM payments')).resolves.toBeDefined();
      await expect(worker.query("UPDATE orders SET status = 'PAGO'")).rejects.toThrow(/permission denied/i);
      await expect(worker.query("UPDATE payments SET status = 'APROVADO'")).rejects.toThrow(/permission denied/i);
      await expect(worker.query('SELECT count(*) FROM buyers')).rejects.toThrow(/permission denied/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('settle_order_paid · a unica porta para PAGO', () => {
    it('conclui a venda: pedido e numeros PAGO, auditoria e order.paid', async () => {
      const draw = await sorteio();
      const p = await pedido(draw, [1, 2]);
      const r = await settleComoWorker(p.orderId, p.paymentId);

      expect(r.rows[0]!.r).toBe('PAID');
      expect(await statusPedido(p.orderId)).toBe('PAGO');
      expect(await numerosDoPedido(p.orderId)).toEqual(['PAGO', 'PAGO']);
      const { rows } = await owner.query(
        "SELECT event_type FROM outbox WHERE payload->>'orderId' = $1",
        [p.orderId],
      );
      expect(rows.map((x) => x.event_type)).toEqual(['order.paid']);
    });

    it('idempotente: a segunda chamada devolve ALREADY_PAID e nada se repete', async () => {
      const draw = await sorteio();
      const p = await pedido(draw, [3]);
      await settleComoWorker(p.orderId, p.paymentId);
      const r = await settleComoWorker(p.orderId, p.paymentId);
      expect(r.rows[0]!.r).toBe('ALREADY_PAID');
      const { rows } = await owner.query(
        "SELECT count(*)::int AS n FROM outbox WHERE payload->>'orderId' = $1 AND event_type = 'order.paid'",
        [p.orderId],
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('escopo: a aplicacao de OUTRA comunidade nao conclui a venda', async () => {
      const draw = await sorteio();
      const p = await pedido(draw, [4]);
      await expect(
        withTenant(app, { tenantId: tenantB }, (c) => c.query('SELECT app.settle_order_paid($1, NULL, $2)', [p.orderId, 'X'])),
      ).rejects.toThrow(/inexistente/);
      expect(await statusPedido(p.orderId)).toBe('PENDENTE');
    });

    it('sem contexto de comunidade, a aplicacao tambem nao conclui', async () => {
      const draw = await sorteio();
      const p = await pedido(draw, [5]);
      await expect(app.query('SELECT app.settle_order_paid($1, NULL, $2)', [p.orderId, 'X'])).rejects.toThrow(/inexistente/);
    });

    it('a propria comunidade conclui (caminho da API)', async () => {
      const draw = await sorteio();
      const p = await pedido(draw, [6]);
      const r = await withTenant(app, { tenantId: tenantA }, (c) =>
        c.query<{ r: string }>('SELECT app.settle_order_paid($1, $2, $3) AS r', [p.orderId, p.paymentId, 'PSP']),
      );
      expect(r.rows[0]!.r).toBe('PAID');
    });

    it('sorteio ja APURADO: nao vende; marca estorno manual e nao mexe no retrato (RN20)', async () => {
      const draw = await sorteio(tenantA, 'VENDAS ENCERRADAS');
      const p = await pedido(draw, [7]);
      // O retrato so existe sem pendencia; aqui o proprio pedido e a pendencia — entao
      // simula-se o cenario de sorteio ja apurado movendo o estado direto.
      await owner.query("UPDATE draws SET status = 'APURAÇÃO' WHERE id = $1", [draw]);

      const r = await settleComoWorker(p.orderId, p.paymentId);

      expect(r.rows[0]!.r).toBe('REFUND_REQUIRED');
      expect(await statusPedido(p.orderId)).toBe('PENDENTE');
      const { rows } = await owner.query('SELECT needs_manual_refund, refund_reason FROM payments WHERE id = $1', [p.paymentId]);
      expect(rows[0]!.needs_manual_refund).toBe(true);
      expect(rows[0]!.refund_reason).toContain('apurado');
    });

    it('confirmacao sem pagamento nao pode virar estorno: erro claro', async () => {
      const draw = await sorteio(tenantA, 'APURAÇÃO');
      const p = await pedido(draw, [8], { comCobranca: false });
      await expect(settleComoWorker(p.orderId, null)).rejects.toThrow(/nao estao mais disponiveis/);
    });
  });

  // -------------------------------------------------------------------------
  describe('apply_psp_payment', () => {
    it('aprovado com valor e referencia certos: conclui a venda', async () => {
      const draw = await sorteio();
      const p = await pedido(draw, [10]);
      const r = await aplicar('FAKE', p.providerPaymentId!, 'APROVADO', 1000, p.orderId);
      expect(r.rows[0]!.r).toBe('paid');
      expect(await statusPedido(p.orderId)).toBe('PAGO');
    });

    it('repetir o mesmo aviso: already_processed, sem segundo order.paid', async () => {
      const draw = await sorteio();
      const p = await pedido(draw, [11]);
      await aplicar('FAKE', p.providerPaymentId!, 'APROVADO', 1000, p.orderId);
      for (let i = 0; i < 4; i += 1) {
        expect((await aplicar('FAKE', p.providerPaymentId!, 'APROVADO', 1000, p.orderId)).rows[0]!.r).toBe('already_processed');
      }
      const { rows } = await owner.query(
        "SELECT count(*)::int AS n FROM outbox WHERE payload->>'orderId' = $1 AND event_type = 'order.paid'",
        [p.orderId],
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('valor ou referencia diferentes: mismatch, nada paga', async () => {
      const draw = await sorteio();
      const p = await pedido(draw, [12]);
      expect((await aplicar('FAKE', p.providerPaymentId!, 'APROVADO', 1, p.orderId)).rows[0]!.r).toBe('mismatch');
      expect((await aplicar('FAKE', p.providerPaymentId!, 'APROVADO', 1000, '00000000-0000-4000-8000-000000000000')).rows[0]!.r).toBe('mismatch');
      expect(await statusPedido(p.orderId)).toBe('PENDENTE');
    });

    it('pagamento desconhecido, ou de outra comunidade para a aplicacao: unknown_payment', async () => {
      expect((await aplicar('FAKE', 'nao-existe', 'APROVADO', 1000, 'x')).rows[0]!.r).toBe('unknown_payment');
      const draw = await sorteio();
      const p = await pedido(draw, [13]);
      const r = await withTenant(app, { tenantId: tenantB }, (c) =>
        c.query<{ r: string }>('SELECT app.apply_psp_payment($1, $2, $3, $4, $5, NULL, NULL) AS r', ['FAKE', p.providerPaymentId, 'APROVADO', 1000, p.orderId]),
      );
      expect(r.rows[0]!.r).toBe('unknown_payment');
      expect(await statusPedido(p.orderId)).toBe('PENDENTE');
    });

    it('expirado e cancelado fecham a cobranca sem tocar no pedido', async () => {
      const draw = await sorteio();
      const p = await pedido(draw, [14]);
      expect((await aplicar('FAKE', p.providerPaymentId!, 'EXPIRADO', 1000, p.orderId)).rows[0]!.r).toBe('closed');
      const { rows } = await owner.query('SELECT status::text AS s FROM payments WHERE id = $1', [p.paymentId]);
      expect(rows[0]!.s).toBe('EXPIRADO');
      expect(await statusPedido(p.orderId)).toBe('PENDENTE');
    });

    it('estornado grava paid_at (o pagamento FOI pago) e audita', async () => {
      const draw = await sorteio();
      const p = await pedido(draw, [15]);
      await aplicar('FAKE', p.providerPaymentId!, 'APROVADO', 1000, p.orderId);
      // Simula o estorno sobre um pagamento que ja esteve aprovado.
      await owner.query("UPDATE payments SET status = 'PENDENTE', paid_at = NULL WHERE id = $1", [p.paymentId]);
      const r = await aplicar('FAKE', p.providerPaymentId!, 'ESTORNADO', 1000, p.orderId);
      expect(r.rows[0]!.r).toBe('refunded');
      const { rows } = await owner.query('SELECT status::text AS s, paid_at FROM payments WHERE id = $1', [p.paymentId]);
      expect(rows[0]!.s).toBe('ESTORNADO');
      expect(rows[0]!.paid_at).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('worker_release_order', () => {
    it('devolve os numeros a grade, cancela o pedido, expira a cobranca e audita', async () => {
      const draw = await sorteio();
      const p = await pedido(draw, [20, 21]);
      const r = await worker.query<{ r: string }>('SELECT app.worker_release_order($1, $2) AS r', [p.orderId, 'teste']);

      expect(r.rows[0]!.r).toBe('RELEASED');
      expect(await statusPedido(p.orderId)).toBe('CANCELADO');
      const { rows: nums } = await owner.query(
        'SELECT status::text AS s, order_id, reservation_id, expires_at < now() AS vencido FROM draw_numbers WHERE draw_id = $1 ORDER BY number',
        [draw],
      );
      // "Livre" e o que a grade e a reserva entendem como vencido: RESERVADO com prazo passado.
      expect(nums.map((n) => [n.s, n.order_id, n.reservation_id, n.vencido])).toEqual([
        ['RESERVADO', null, null, true],
        ['RESERVADO', null, null, true],
      ]);
      const { rows: pay } = await owner.query('SELECT status::text AS s FROM payments WHERE id = $1', [p.paymentId]);
      expect(pay[0]!.s).toBe('EXPIRADO');
      const { rows: audit } = await owner.query("SELECT actor_type FROM audit_events WHERE action = 'order.expired' AND target_id = $1", [p.orderId]);
      expect(audit[0]!.actor_type).toBe('SYSTEM');
    });

    it('NUNCA toca em pedido pago nem em numero PAGO', async () => {
      const draw = await sorteio();
      const p = await pedido(draw, [22]);
      await settleComoWorker(p.orderId, p.paymentId);

      const r = await worker.query<{ r: string }>('SELECT app.worker_release_order($1, $2) AS r', [p.orderId, 'x']);

      expect(r.rows[0]!.r).toBe('NOT_PENDING');
      expect(await statusPedido(p.orderId)).toBe('PAGO');
      expect(await numerosDoPedido(p.orderId)).toEqual(['PAGO']);
    });

    it('idempotente e tolerante a pedido inexistente', async () => {
      const draw = await sorteio();
      const p = await pedido(draw, [23]);
      await worker.query('SELECT app.worker_release_order($1, $2)', [p.orderId, 'x']);
      expect((await worker.query<{ r: string }>('SELECT app.worker_release_order($1, $2) AS r', [p.orderId, 'x'])).rows[0]!.r).toBe('NOT_PENDING');
      expect(
        (await worker.query<{ r: string }>("SELECT app.worker_release_order('00000000-0000-4000-8000-000000000000', 'x') AS r")).rows[0]!.r,
      ).toBe('NOT_FOUND');
    });

    it('depois de liberado, outra pessoa pode reservar os mesmos numeros', async () => {
      const draw = await sorteio();
      const p = await pedido(draw, [24]);
      await worker.query('SELECT app.worker_release_order($1, $2)', [p.orderId, 'x']);
      // O caminho da reserva "retoma" o numero vencido.
      const { rowCount } = await owner.query(
        `UPDATE draw_numbers SET status = 'RESERVADO', expires_at = now() + interval '30 minutes'
          WHERE draw_id = $1 AND number = 24 AND status = 'RESERVADO' AND expires_at <= now()`,
        [draw],
      );
      expect(rowCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('worker_expire_reservations · P8', () => {
    async function reserva(status: string, expira: string): Promise<string> {
      const draw = await sorteio();
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO reservations (tenant_id, draw_id, status, expires_at, created_at)
         VALUES ($1, $2, $3::reservation_status, now() + $4::interval, now() - interval '2 hours') RETURNING id`,
        [tenantA, draw, status, expira],
      );
      return rows[0]!.id;
    }
    const statusReserva = async (id: string) =>
      (await owner.query<{ s: string }>('SELECT status::text AS s FROM reservations WHERE id = $1', [id])).rows[0]!.s;

    it('ATIVA vencida vira EXPIRADA; ATIVA no prazo, CONVERTIDA e CANCELADA ficam', async () => {
      const vencida = await reserva('ATIVA', '-5 minutes');
      const noPrazo = await reserva('ATIVA', '10 minutes');
      const convertida = await reserva('CONVERTIDA', '-5 minutes');
      const cancelada = await reserva('CANCELADA', '-5 minutes');

      await worker.query('SELECT app.worker_expire_reservations(1000)');

      expect(await statusReserva(vencida)).toBe('EXPIRADA');
      expect(await statusReserva(noPrazo)).toBe('ATIVA');
      expect(await statusReserva(convertida)).toBe('CONVERTIDA');
      expect(await statusReserva(cancelada)).toBe('CANCELADA');
    });

    it('idempotente: a segunda rodada nao encontra nada', async () => {
      await reserva('ATIVA', '-5 minutes');
      await worker.query('SELECT app.worker_expire_reservations(1000)');
      const r = await worker.query<{ n: number }>('SELECT app.worker_expire_reservations(1000) AS n');
      expect(r.rows[0]!.n).toBe(0);
    });

    it('nao mexe em numeros: PAGO continua PAGO', async () => {
      const draw = await sorteio();
      const p = await pedido(draw, [30]);
      await settleComoWorker(p.orderId, p.paymentId);
      await owner.query("UPDATE reservations SET status = 'ATIVA', expires_at = now() - interval '1 minute', created_at = now() - interval '2 hours' WHERE id = $1", [p.reservationId]);

      await worker.query('SELECT app.worker_expire_reservations(1000)');

      expect(await numerosDoPedido(p.orderId)).toEqual(['PAGO']);
    });

    it('respeita o limite do lote', async () => {
      for (let i = 0; i < 3; i += 1) await reserva('ATIVA', '-5 minutes');
      const r = await worker.query<{ n: number }>('SELECT app.worker_expire_reservations(2) AS n');
      expect(r.rows[0]!.n).toBeLessThanOrEqual(2);
    });
  });

  // -------------------------------------------------------------------------
  describe('worker_archive_outbox', () => {
    async function evento(publicadoHa: string | null, extra = ''): Promise<string> {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO outbox (tenant_id, event_type, payload, published_at ${extra ? ', dead_lettered_at' : ''})
         VALUES ($1, 'draw.paused', '{}'::jsonb, ${publicadoHa ? `now() - interval '${publicadoHa}'` : 'NULL'} ${extra ? ', now()' : ''})
         RETURNING id`,
        [tenantA],
      );
      return rows[0]!.id;
    }
    const naOutbox = async (id: string) => (await owner.query('SELECT 1 FROM outbox WHERE id = $1', [id])).rowCount === 1;
    const noArquivo = async (id: string) => (await owner.query('SELECT 1 FROM outbox_archive WHERE id = $1', [id])).rowCount === 1;

    it('arquiva o publicado ha mais de 30 dias; mantem o recente, o pendente e o dead-letter', async () => {
      const antigo = await evento('40 days');
      const recente = await evento('5 days');
      const pendente = await evento(null);
      const dead = await evento(null, 'dead');

      const r = await worker.query<{ n: number }>('SELECT app.worker_archive_outbox(30, 5000) AS n');

      expect(r.rows[0]!.n).toBeGreaterThanOrEqual(1);
      expect(await naOutbox(antigo)).toBe(false);
      expect(await noArquivo(antigo)).toBe(true);
      expect(await naOutbox(recente)).toBe(true);
      expect(await naOutbox(pendente)).toBe(true);
      expect(await naOutbox(dead)).toBe(true);
    });

    it('NUNCA apaga audit_events', async () => {
      await evento('60 days');
      const antes = (await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_events')).rows[0]!.n;
      await worker.query('SELECT app.worker_archive_outbox(30, 5000)');
      const depois = (await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_events')).rows[0]!.n;
      expect(depois).toBe(antes);
    });

    it('idempotente, e o arquivo continua legivel para a comunidade dona', async () => {
      const id = await evento('45 days');
      await worker.query('SELECT app.worker_archive_outbox(30, 5000)');
      const r = await worker.query<{ n: number }>('SELECT app.worker_archive_outbox(30, 5000) AS n');
      expect(r.rows[0]!.n).toBe(0);

      const dona = await withTenant(app, { tenantId: tenantA }, (c) => c.query('SELECT id FROM outbox_archive WHERE id = $1', [id]));
      const outra = await withTenant(app, { tenantId: tenantB }, (c) => c.query('SELECT id FROM outbox_archive WHERE id = $1', [id]));
      expect(dona.rowCount).toBe(1);
      expect(outra.rowCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('heartbeat e notificacoes', () => {
    it('worker_record_job_run: sucesso, falha, reposicao', async () => {
      const job = unique('job-');
      const t0 = new Date(Date.now() - 2_000).toISOString();
      const t1 = new Date().toISOString();

      await worker.query('SELECT app.worker_record_job_run($1, 60, $2, $3, 5, NULL)', [job, t0, t1]);
      let h = (await owner.query('SELECT * FROM job_heartbeats WHERE job_name = $1', [job])).rows[0]!;
      expect(h).toMatchObject({ last_count: 5, last_error: null, consecutive_failures: 0, interval_seconds: 60 });
      expect(h.last_success_at).not.toBeNull();
      expect(h.last_duration_ms).toBeGreaterThanOrEqual(1_900);

      await worker.query("SELECT app.worker_record_job_run($1, 60, $2, $3, 0, 'boom')", [job, t0, t1]);
      await worker.query("SELECT app.worker_record_job_run($1, 60, $2, $3, 0, 'boom')", [job, t0, t1]);
      h = (await owner.query('SELECT * FROM job_heartbeats WHERE job_name = $1', [job])).rows[0]!;
      expect(h).toMatchObject({ last_error: 'boom', consecutive_failures: 2 });
      // A falha nao apaga a ultima vez que deu certo.
      expect(h.last_success_at).not.toBeNull();

      await worker.query('SELECT app.worker_record_job_run($1, 60, $2, $3, 1, NULL)', [job, t0, t1]);
      h = (await owner.query('SELECT * FROM job_heartbeats WHERE job_name = $1', [job])).rows[0]!;
      expect(h).toMatchObject({ last_error: null, consecutive_failures: 0 });
    });

    it('a aplicacao le o heartbeat mas nao o escreve', async () => {
      await expect(app.query('SELECT count(*) FROM job_heartbeats')).resolves.toBeDefined();
      await expect(app.query("INSERT INTO job_heartbeats (job_name, interval_seconds) VALUES ('x', 1)")).rejects.toThrow(/permission denied/i);
    });

    it('notifications_sent: dedupe_key unica; a aplicacao le so o da propria comunidade e nao escreve', async () => {
      const draw = await sorteio();
      const chave = unique('dedupe-');
      const inserir = () =>
        worker.query(
          `INSERT INTO notifications_sent (tenant_id, draw_id, kind, dedupe_key) VALUES ($1, $2, 'DRAW_ACTIVATED', $3)`,
          [tenantA, draw, chave],
        );
      await inserir();
      await expect(inserir()).rejects.toThrow(/notifications_sent_dedupe_key/);

      const a = await withTenant(app, { tenantId: tenantA }, (c) => c.query('SELECT id FROM notifications_sent WHERE dedupe_key = $1', [chave]));
      const b = await withTenant(app, { tenantId: tenantB }, (c) => c.query('SELECT id FROM notifications_sent WHERE dedupe_key = $1', [chave]));
      expect([a.rowCount, b.rowCount]).toEqual([1, 0]);
      await expect(
        withTenant(app, { tenantId: tenantA }, (c) =>
          c.query("INSERT INTO notifications_sent (tenant_id, draw_id, kind, dedupe_key) VALUES ($1, $2, 'DRAW_ACTIVATED', 'x')", [tenantA, draw]),
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it('so aceita tipos de aviso conhecidos', async () => {
      const draw = await sorteio();
      await expect(
        worker.query("INSERT INTO notifications_sent (tenant_id, draw_id, kind, dedupe_key) VALUES ($1, $2, 'INVENTADO', $3)", [tenantA, draw, unique('k-')]),
      ).rejects.toThrow(/notifications_sent_kind_known/);
    });
  });

  // -------------------------------------------------------------------------
  describe('conciliacao local', () => {
    it('detecta pagamento aprovado com pedido nao pago, e fecha quando resolve', async () => {
      const draw = await sorteio();
      const p = await pedido(draw, [40]);
      await owner.query("UPDATE payments SET status = 'APROVADO', paid_at = now() WHERE id = $1", [p.paymentId]);

      const primeira = await worker.query<{ n: number }>("SELECT app.worker_reconcile_local('7 days') AS n");
      expect(primeira.rows[0]!.n).toBeGreaterThanOrEqual(1);
      const abertas = await owner.query(
        "SELECT kind FROM payment_reconciliation_issues WHERE payment_id = $1 AND resolved_at IS NULL",
        [p.paymentId],
      );
      expect(abertas.rows.map((r) => r.kind)).toEqual(['APPROVED_ORDER_NOT_PAID']);

      // Rodar de novo nao duplica a divergencia aberta.
      await worker.query("SELECT app.worker_reconcile_local('7 days')");
      expect((await owner.query('SELECT count(*)::int AS n FROM payment_reconciliation_issues WHERE payment_id = $1', [p.paymentId])).rows[0]!.n).toBe(1);

      // Resolve o pedido: a proxima conciliacao fecha a divergencia.
      await settleComoWorker(p.orderId, p.paymentId);
      await worker.query("SELECT app.worker_reconcile_local('7 days')");
      const depois = await owner.query('SELECT resolved_at FROM payment_reconciliation_issues WHERE payment_id = $1', [p.paymentId]);
      expect(depois.rows[0]!.resolved_at).not.toBeNull();
    });

    it('estorno manual em aberto aparece e nao some sozinho', async () => {
      const draw = await sorteio(tenantA, 'APURAÇÃO');
      const p = await pedido(draw, [41]);
      await settleComoWorker(p.orderId, p.paymentId); // sorteio apurado -> REFUND_REQUIRED
      await worker.query("SELECT app.worker_reconcile_local('7 days')");
      const r = await owner.query("SELECT kind FROM payment_reconciliation_issues WHERE payment_id = $1 AND resolved_at IS NULL", [p.paymentId]);
      expect(r.rows.map((x) => x.kind)).toContain('MANUAL_REFUND_OPEN');
    });

    it('RLS: a comunidade B nao enxerga divergencia da A', async () => {
      const draw = await sorteio();
      const p = await pedido(draw, [42]);
      await owner.query("UPDATE payments SET status = 'APROVADO', paid_at = now() WHERE id = $1", [p.paymentId]);
      await worker.query("SELECT app.worker_reconcile_local('7 days')");
      const a = await withTenant(app, { tenantId: tenantA }, (c) => c.query('SELECT id FROM payment_reconciliation_issues WHERE payment_id = $1', [p.paymentId]));
      const b = await withTenant(app, { tenantId: tenantB }, (c) => c.query('SELECT id FROM payment_reconciliation_issues WHERE payment_id = $1', [p.paymentId]));
      expect([a.rowCount, b.rowCount]).toEqual([1, 0]);
    });
  });
});
