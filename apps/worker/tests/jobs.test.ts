import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakePsp } from '@clubedarifa/psp/testing';
import {
  ativarAgendados,
  conciliacao,
  expirarPix,
  expirarReservas,
  fecharSorteios,
  limpezaOutbox,
  JOBS,
} from '../src/jobs/definitions.js';
import { runJob } from '../src/jobs/runner.js';
import type { JobContext, JobDefinition } from '../src/jobs/types.js';
import {
  hasDb,
  numberStatuses,
  openBench,
  seedDraw,
  seedPaidNumbers,
  seedPendingOrder,
  seedTenant,
  silentLog,
  skipReason,
  statusOf,
  unique,
  type Bench,
} from './helpers/seed.js';

/**
 * Jobs do worker, contra PostgreSQL real, com o papel restrito `app_worker`.
 *
 * O que cada bloco prova: o job faz o que deve, NAO faz o que nao deve (nunca
 * toca em PAGO, nunca libera no escuro) e e IDEMPOTENTE — rodar duas vezes seguidas
 * nao muda o resultado da primeira.
 */
describe.skipIf(!hasDb)(`Jobs do worker ${hasDb ? '' : skipReason}`, () => {
  let bench: Bench;
  let psp: FakePsp;
  let tenantId: string;
  let ctx: JobContext;

  beforeAll(async () => {
    bench = await openBench('test-jobs');
    psp = new FakePsp();
    tenantId = await seedTenant(bench.owner);
    ctx = { pool: bench.worker, log: silentLog, psp };
  }, 120_000);

  afterAll(async () => {
    await bench?.close();
  });

  const agora = (offset: string) => `now() ${offset}`;
  void agora;

  // -------------------------------------------------------------------------
  describe('catalogo', () => {
    it('os seis jobs, com nome, cron e intervalo coerentes', () => {
      expect(JOBS.map((j) => j.name)).toEqual([
        'expirar-reservas',
        'ativar-agendados',
        'fechar-sorteios',
        'expirar-pix',
        'conciliacao',
        'limpeza-outbox',
      ]);
      const porNome = Object.fromEntries(JOBS.map((j) => [j.name, j]));
      expect(porNome['expirar-reservas']).toMatchObject({ cron: '* * * * *', intervalSeconds: 60 });
      expect(porNome['ativar-agendados']).toMatchObject({ cron: '* * * * *', intervalSeconds: 60 });
      expect(porNome['fechar-sorteios']).toMatchObject({ cron: '* * * * *', intervalSeconds: 60 });
      expect(porNome['expirar-pix']).toMatchObject({ cron: '*/5 * * * *', intervalSeconds: 300 });
      expect(porNome['conciliacao']?.intervalSeconds).toBe(86_400);
      expect(porNome['limpeza-outbox']?.intervalSeconds).toBe(86_400);
    });
  });

  // -------------------------------------------------------------------------
  describe('expirar-reservas', () => {
    it('reserva ATIVA vencida vira EXPIRADA; a do prazo continua; e idempotente', async () => {
      const draw = await seedDraw(bench.owner, tenantId);
      const { rows: v } = await bench.owner.query<{ id: string }>(
        `INSERT INTO reservations (tenant_id, draw_id, status, created_at, expires_at)
         VALUES ($1, $2, 'ATIVA', now() - interval '2 hours', now() - interval '1 minute') RETURNING id`,
        [tenantId, draw],
      );
      const { rows: ok } = await bench.owner.query<{ id: string }>(
        `INSERT INTO reservations (tenant_id, draw_id, status, expires_at)
         VALUES ($1, $2, 'ATIVA', now() + interval '10 minutes') RETURNING id`,
        [tenantId, draw],
      );

      const primeira = await expirarReservas.run(ctx);
      expect(primeira).toBeGreaterThanOrEqual(1);
      expect(await statusOf(bench.owner, 'reservations', v[0]!.id)).toBe('EXPIRADA');
      expect(await statusOf(bench.owner, 'reservations', ok[0]!.id)).toBe('ATIVA');

      expect(await expirarReservas.run(ctx)).toBe(0);
    });

    it('nunca toca em numero PAGO', async () => {
      const draw = await seedDraw(bench.owner, tenantId);
      await seedPaidNumbers(bench.owner, tenantId, draw, [1, 2, 3]);
      await expirarReservas.run(ctx);
      expect([...(await numberStatuses(bench.owner, draw)).values()]).toEqual(['PAGO', 'PAGO', 'PAGO']);
    });
  });

  // -------------------------------------------------------------------------
  describe('ativar-agendados', () => {
    it('AGENDADA cuja hora chegou vira ATIVA; a que ainda nao chegou fica', async () => {
      const chegou = await seedDraw(bench.owner, tenantId, {
        status: 'AGENDADA',
        salesStartAt: new Date(Date.now() - 60_000).toISOString(),
      });
      const naoChegou = await seedDraw(bench.owner, tenantId, {
        status: 'AGENDADA',
        salesStartAt: new Date(Date.now() + 3_600_000).toISOString(),
      });

      const n = await ativarAgendados.run(ctx);

      expect(n).toBeGreaterThanOrEqual(1);
      expect(await statusOf(bench.owner, 'draws', chegou)).toBe('ATIVA');
      expect(await statusOf(bench.owner, 'draws', naoChegou)).toBe('AGENDADA');
    });

    it('publica draw.activated e audita; rodar de novo nao repete', async () => {
      const draw = await seedDraw(bench.owner, tenantId, {
        status: 'AGENDADA',
        salesStartAt: new Date(Date.now() - 60_000).toISOString(),
      });
      await ativarAgendados.run(ctx);
      await ativarAgendados.run(ctx);

      const { rows } = await bench.owner.query(
        "SELECT event_type FROM outbox WHERE payload->>'drawId' = $1",
        [draw],
      );
      expect(rows.map((r) => r.event_type)).toEqual(['draw.activated']);
    });
  });

  // -------------------------------------------------------------------------
  describe('fechar-sorteios', () => {
    it('close_at vencido fecha as vendas (POR_DATA e O_QUE_VIER_PRIMEIRO)', async () => {
      const vencido = new Date(Date.now() - 60_000).toISOString();
      const porData = await seedDraw(bench.owner, tenantId, { closeMode: 'POR_DATA', closeAt: vencido });
      const primeiro = await seedDraw(bench.owner, tenantId, { closeMode: 'O_QUE_VIER_PRIMEIRO', closeAt: vencido });
      const aoEsgotar = await seedDraw(bench.owner, tenantId, { closeMode: 'AO_ESGOTAR', closeAt: vencido });
      const futuro = await seedDraw(bench.owner, tenantId, {
        closeMode: 'POR_DATA',
        closeAt: new Date(Date.now() + 3_600_000).toISOString(),
      });

      await fecharSorteios.run(ctx);

      // O job seguinte no mesmo ciclo pode ate avancar para APURACAO; o que importa e que fechou.
      for (const id of [porData, primeiro]) {
        expect(['VENDAS ENCERRADAS', 'APURAÇÃO']).toContain(await statusOf(bench.owner, 'draws', id));
      }
      // AO_ESGOTAR ignora a data; data futura nao fecha.
      expect(await statusOf(bench.owner, 'draws', aoEsgotar)).toBe('ATIVA');
      expect(await statusOf(bench.owner, 'draws', futuro)).toBe('ATIVA');
    });

    it('grade esgotada fecha as vendas', async () => {
      const draw = await seedDraw(bench.owner, tenantId, { closeMode: 'AO_ESGOTAR' });
      await seedPaidNumbers(bench.owner, tenantId, draw, Array.from({ length: 100 }, (_, i) => i));

      await fecharSorteios.run(ctx);

      expect(['VENDAS ENCERRADAS', 'APURAÇÃO']).toContain(await statusOf(bench.owner, 'draws', draw));
    });

    it('grade NAO esgotada em modo POR_DATA sem data vencida nao fecha', async () => {
      const draw = await seedDraw(bench.owner, tenantId, { closeMode: 'POR_DATA', closeAt: new Date(Date.now() + 9e6).toISOString() });
      await seedPaidNumbers(bench.owner, tenantId, draw, Array.from({ length: 100 }, (_, i) => i));
      await fecharSorteios.run(ctx);
      expect(await statusOf(bench.owner, 'draws', draw)).toBe('ATIVA');
    });

    it('vendas encerradas SEM pendencia: congela o retrato e abre a apuracao', async () => {
      const draw = await seedDraw(bench.owner, tenantId, { status: 'VENDAS ENCERRADAS' });
      await seedPaidNumbers(bench.owner, tenantId, draw, [5, 6]);

      const n = await fecharSorteios.run(ctx);

      expect(n).toBeGreaterThanOrEqual(1);
      expect(await statusOf(bench.owner, 'draws', draw)).toBe('APURAÇÃO');
      const { rows } = await bench.owner.query('SELECT paid_count FROM draw_snapshots WHERE draw_id = $1', [draw]);
      expect(rows[0]!.paid_count).toBe(2);
    });

    it('vendas encerradas COM pendencia esperam; quando a pendencia some, avancam', async () => {
      const draw = await seedDraw(bench.owner, tenantId, { status: 'VENDAS ENCERRADAS' });
      // Reserva ainda valida: o pedido esta pendente e o retrato tem de esperar.
      const p = await seedPendingOrder(bench.owner, tenantId, draw, [9], {
        payment: false,
        reservationExpiresAgo: '-10 minutes',
      });

      await fecharSorteios.run(ctx);
      expect(await statusOf(bench.owner, 'draws', draw)).toBe('VENDAS ENCERRADAS');
      const { rows: antes } = await bench.owner.query('SELECT 1 FROM draw_snapshots WHERE draw_id = $1', [draw]);
      expect(antes).toHaveLength(0);

      // A reserva vence e o pedido e liberado: a pendencia acabou.
      await bench.owner.query(
        "UPDATE reservations SET expires_at = now() - interval '10 minutes' WHERE id = $1",
        [p.reservationId],
      );
      await expirarPix.run(ctx);
      await fecharSorteios.run(ctx);
      expect(await statusOf(bench.owner, 'draws', draw)).toBe('APURAÇÃO');
    });

    it('idempotente: a segunda rodada nao repete evento', async () => {
      const draw = await seedDraw(bench.owner, tenantId, {
        closeMode: 'POR_DATA',
        closeAt: new Date(Date.now() - 60_000).toISOString(),
      });
      await fecharSorteios.run(ctx);
      await fecharSorteios.run(ctx);
      const { rows } = await bench.owner.query(
        "SELECT event_type FROM outbox WHERE payload->>'drawId' = $1 ORDER BY event_type",
        [draw],
      );
      expect(rows.map((r) => r.event_type)).toEqual(['draw.apuration_started', 'draw.sales_closed']);
    });
  });

  // -------------------------------------------------------------------------
  describe('expirar-pix · consulta o PSP antes de liberar', () => {
    it('PSP diz PENDENTE depois do prazo: libera, cancela o pedido e devolve os numeros', async () => {
      const draw = await seedDraw(bench.owner, tenantId);
      const p = await seedPendingOrder(bench.owner, tenantId, draw, [10, 11]);
      await psp.createPixCharge({
        idempotencyKey: p.orderId, amountCents: 2000, description: 'x', externalReference: p.orderId,
        payerEmail: null, payerName: 'M', expiresAt: new Date(), notificationUrl: null,
      });
      // O PSP falso gera o proprio id; alinha o do banco.
      await bench.owner.query('UPDATE payments SET provider_payment_id = $2 WHERE id = $1', [p.paymentId, psp.idDoPedido(p.orderId)]);

      const n = await expirarPix.run(ctx);

      expect(n).toBeGreaterThanOrEqual(1);
      expect(await statusOf(bench.owner, 'orders', p.orderId)).toBe('CANCELADO');
      expect(await statusOf(bench.owner, 'payments', p.paymentId!)).toBe('EXPIRADO');
      const nums = await numberStatuses(bench.owner, draw);
      expect([nums.get(10), nums.get(11)]).toEqual(['RESERVADO', 'RESERVADO']); // vencidos = livres para a grade
    });

    it('PSP diz APROVADO: conclui a venda e NAO libera', async () => {
      const draw = await seedDraw(bench.owner, tenantId);
      const p = await seedPendingOrder(bench.owner, tenantId, draw, [12]);
      await psp.createPixCharge({
        idempotencyKey: p.orderId, amountCents: 1000, description: 'x', externalReference: p.orderId,
        payerEmail: null, payerName: 'M', expiresAt: new Date(), notificationUrl: null,
      });
      await bench.owner.query('UPDATE payments SET provider_payment_id = $2 WHERE id = $1', [p.paymentId, psp.idDoPedido(p.orderId)]);
      psp.approve(p.orderId);

      await expirarPix.run(ctx);

      expect(await statusOf(bench.owner, 'orders', p.orderId)).toBe('PAGO');
      expect((await numberStatuses(bench.owner, draw)).get(12)).toBe('PAGO');
    });

    it('PSP FORA DO AR: NADA e liberado (liberar no escuro venderia duas vezes)', async () => {
      const draw = await seedDraw(bench.owner, tenantId);
      const p = await seedPendingOrder(bench.owner, tenantId, draw, [13]);
      await psp.createPixCharge({
        idempotencyKey: p.orderId, amountCents: 1000, description: 'x', externalReference: p.orderId,
        payerEmail: null, payerName: 'M', expiresAt: new Date(), notificationUrl: null,
      });
      await bench.owner.query('UPDATE payments SET provider_payment_id = $2 WHERE id = $1', [p.paymentId, psp.idDoPedido(p.orderId)]);
      psp.consultaIndisponivel = true;
      try {
        await expirarPix.run(ctx);
      } finally {
        psp.consultaIndisponivel = false;
      }

      expect(await statusOf(bench.owner, 'orders', p.orderId)).toBe('PENDENTE');
      expect((await numberStatuses(bench.owner, draw)).get(13)).toBe('PENDENTE');
    });

    it('SEM provedor configurado: cobranca vencida nao e liberada', async () => {
      const draw = await seedDraw(bench.owner, tenantId);
      const p = await seedPendingOrder(bench.owner, tenantId, draw, [14]);
      await expirarPix.run({ ...ctx, psp: null });
      expect(await statusOf(bench.owner, 'orders', p.orderId)).toBe('PENDENTE');
    });

    it('cobranca de OUTRO provedor nao e consultada nem liberada', async () => {
      const draw = await seedDraw(bench.owner, tenantId);
      const p = await seedPendingOrder(bench.owner, tenantId, draw, [15], { provider: 'MERCADO_PAGO' });
      await expirarPix.run(ctx); // o PSP do contexto e o FAKE
      expect(await statusOf(bench.owner, 'orders', p.orderId)).toBe('PENDENTE');
    });

    it('ainda dentro do prazo (mais a folga): nao mexe', async () => {
      const draw = await seedDraw(bench.owner, tenantId);
      const p = await seedPendingOrder(bench.owner, tenantId, draw, [16], { paymentExpiresAgo: '30 seconds', reservationExpiresAgo: '-5 minutes' });
      await expirarPix.run(ctx);
      expect(await statusOf(bench.owner, 'orders', p.orderId)).toBe('PENDENTE');
    });

    it('pedido sem cobranca e reserva vencida (PSP estava fora ao criar): libera sem consultar', async () => {
      const draw = await seedDraw(bench.owner, tenantId);
      const p = await seedPendingOrder(bench.owner, tenantId, draw, [17], { payment: false });

      await expirarPix.run(ctx);

      // Nao ha cobranca a consultar: o pedido e liberado pela reserva vencida.
      expect(await statusOf(bench.owner, 'orders', p.orderId)).toBe('CANCELADO');
      const { rows } = await bench.owner.query('SELECT 1 FROM payments WHERE order_id = $1', [p.orderId]);
      expect(rows).toHaveLength(0);
    });

    it('pedido sem cobranca com a reserva AINDA valida: nao libera', async () => {
      const draw = await seedDraw(bench.owner, tenantId);
      const p = await seedPendingOrder(bench.owner, tenantId, draw, [18], { payment: false, reservationExpiresAgo: '-10 minutes' });
      await expirarPix.run(ctx);
      expect(await statusOf(bench.owner, 'orders', p.orderId)).toBe('PENDENTE');
    });

    it('nunca toca em pedido PAGO nem em numero PAGO', async () => {
      const draw = await seedDraw(bench.owner, tenantId);
      const pago = await seedPaidNumbers(bench.owner, tenantId, draw, [19, 20]);
      await expirarPix.run(ctx);
      expect(await statusOf(bench.owner, 'orders', pago)).toBe('PAGO');
      const nums = await numberStatuses(bench.owner, draw);
      expect([nums.get(19), nums.get(20)]).toEqual(['PAGO', 'PAGO']);
    });

    it('idempotente: a segunda rodada nao libera de novo', async () => {
      const draw = await seedDraw(bench.owner, tenantId);
      await seedPendingOrder(bench.owner, tenantId, draw, [21], { payment: false });
      await expirarPix.run(ctx);
      const n2 = await expirarPix.run(ctx);
      expect(n2).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('conciliacao', () => {
    it('cobranca aprovada no PSP que o webhook perdeu: registra a divergencia e CURA a venda', async () => {
      const draw = await seedDraw(bench.owner, tenantId);
      const p = await seedPendingOrder(bench.owner, tenantId, draw, [30], { paymentExpiresAgo: '-10 minutes' });
      await psp.createPixCharge({
        idempotencyKey: p.orderId, amountCents: 1000, description: 'x', externalReference: p.orderId,
        payerEmail: null, payerName: 'M', expiresAt: new Date(), notificationUrl: null,
      });
      await bench.owner.query('UPDATE payments SET provider_payment_id = $2 WHERE id = $1', [p.paymentId, psp.idDoPedido(p.orderId)]);
      psp.approve(p.orderId);

      const n = await conciliacao.run(ctx);

      expect(n).toBeGreaterThanOrEqual(1);
      expect(await statusOf(bench.owner, 'orders', p.orderId)).toBe('PAGO');
      const { rows } = await bench.owner.query(
        "SELECT kind FROM payment_reconciliation_issues WHERE payment_id = $1 AND kind = 'PSP_APPROVED_LOCAL_PENDING'",
        [p.paymentId],
      );
      expect(rows).toHaveLength(1);
    });

    it('sem provedor, so a conciliacao local roda', async () => {
      const draw = await seedDraw(bench.owner, tenantId);
      const p = await seedPendingOrder(bench.owner, tenantId, draw, [31]);
      await bench.owner.query("UPDATE payments SET status = 'APROVADO', paid_at = now() WHERE id = $1", [p.paymentId]);
      const n = await conciliacao.run({ ...ctx, psp: null });
      expect(n).toBeGreaterThanOrEqual(1);
    });

    it('PSP fora do ar durante a conciliacao nao derruba o job', async () => {
      const draw = await seedDraw(bench.owner, tenantId);
      await seedPendingOrder(bench.owner, tenantId, draw, [32], { paymentExpiresAgo: '-10 minutes' });
      psp.consultaIndisponivel = true;
      try {
        await expect(conciliacao.run(ctx)).resolves.toBeGreaterThanOrEqual(0);
      } finally {
        psp.consultaIndisponivel = false;
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('limpeza-outbox', () => {
    it('arquiva publicado ha mais de 30 dias, mantem o resto, e nao apaga auditoria', async () => {
      const velho = await bench.owner.query<{ id: string }>(
        `INSERT INTO outbox (tenant_id, event_type, payload, published_at)
         VALUES ($1, 'draw.paused', '{}'::jsonb, now() - interval '50 days') RETURNING id`,
        [tenantId],
      );
      const novo = await bench.owner.query<{ id: string }>(
        `INSERT INTO outbox (tenant_id, event_type, payload, published_at)
         VALUES ($1, 'draw.paused', '{}'::jsonb, now() - interval '1 day') RETURNING id`,
        [tenantId],
      );
      const auditoriaAntes = (await bench.owner.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_events')).rows[0]!.n;

      const n = await limpezaOutbox.run(ctx);

      expect(n).toBeGreaterThanOrEqual(1);
      expect((await bench.owner.query('SELECT 1 FROM outbox WHERE id = $1', [velho.rows[0]!.id])).rowCount).toBe(0);
      expect((await bench.owner.query('SELECT 1 FROM outbox_archive WHERE id = $1', [velho.rows[0]!.id])).rowCount).toBe(1);
      expect((await bench.owner.query('SELECT 1 FROM outbox WHERE id = $1', [novo.rows[0]!.id])).rowCount).toBe(1);
      expect((await bench.owner.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_events')).rows[0]!.n).toBe(auditoriaAntes);
      expect(await limpezaOutbox.run(ctx)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('runJob · log e heartbeat', () => {
    function job(nome: string, run: JobDefinition['run']): JobDefinition {
      return { name: nome, cron: '* * * * *', intervalSeconds: 60, run };
    }

    it('grava o heartbeat com contagem e duracao e devolve a contagem', async () => {
      const nome = unique('hb-ok-');
      const n = await runJob(job(nome, async () => 7), ctx);
      expect(n).toBe(7);
      const { rows } = await bench.owner.query('SELECT * FROM job_heartbeats WHERE job_name = $1', [nome]);
      expect(rows[0]).toMatchObject({ last_count: 7, last_error: null, consecutive_failures: 0, interval_seconds: 60 });
      expect(rows[0]!.last_success_at).not.toBeNull();
    });

    it('a falha do job sobe (a fila registra) E fica no heartbeat', async () => {
      const nome = unique('hb-erro-');
      await expect(runJob(job(nome, async () => { throw new Error('quebrou'); }), ctx)).rejects.toThrow('quebrou');
      const { rows } = await bench.owner.query('SELECT * FROM job_heartbeats WHERE job_name = $1', [nome]);
      expect(rows[0]).toMatchObject({ last_error: 'quebrou', consecutive_failures: 1 });
    });

    it('registra inicio e fim no log, com job, duracao e contagem', async () => {
      const linhas: Record<string, unknown>[] = [];
      const { createLogger } = await import('@clubedarifa/logging');
      const log = createLogger({ write: (l) => linhas.push(JSON.parse(l)) });
      await runJob(job(unique('hb-log-'), async () => 3), { ...ctx, log });
      expect(linhas.map((l) => l['msg'])).toEqual(['job iniciado', 'job concluido']);
      expect(linhas[1]).toMatchObject({ count: 3 });
      expect(typeof linhas[1]!['duration_ms']).toBe('number');
      expect(linhas[0]!['job']).toBeDefined();
    });

    it('falha ao gravar o heartbeat NAO derruba o job', async () => {
      const pool = { query: async () => { throw new Error('banco fora'); } } as unknown as JobContext['pool'];
      await expect(runJob(job('x', async () => 1), { ...ctx, pool })).resolves.toBe(1);
    });
  });
});
