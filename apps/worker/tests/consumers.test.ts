import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { handleMessage } from '../src/dispatch.js';
import type { QueueMessage } from '../src/queue.js';
import {
  hasDb,
  openBench,
  seedDraw,
  seedOutboxEvent,
  seedPaidNumbers,
  seedPendingOrder,
  seedTenant,
  skipReason,
  statusOf,
  type Bench,
} from './helpers/seed.js';

/**
 * Consumidores dos eventos de sorteio e pagamento, pelo MESMO caminho do worker
 * (`handleMessage`), contra PostgreSQL real.
 *
 * NENHUM envia mensagem: o que se prova e o REGISTRO em `notifications_sent`, uma
 * vez so, e o efeito de fechar/avancar o sorteio.
 */
describe.skipIf(!hasDb)(`Consumidores de eventos ${hasDb ? '' : skipReason}`, () => {
  let bench: Bench;
  let tenantId: string;

  beforeAll(async () => {
    bench = await openBench('test-consumers');
    tenantId = await seedTenant(bench.owner);
  }, 120_000);

  afterAll(async () => {
    await bench?.close();
  });

  /** Grava o evento na outbox (como a API) e o entrega ao dispatch (como a fila). */
  async function entregar(eventType: string, payload: Record<string, unknown>): Promise<string> {
    const outboxEventId = await seedOutboxEvent(bench.owner, tenantId, eventType, payload);
    const message: QueueMessage = { outboxEventId, tenantId, eventType, payload };
    await handleMessage(bench.worker, message);
    return outboxEventId;
  }

  async function reentregar(outboxEventId: string, eventType: string, payload: Record<string, unknown>) {
    await handleMessage(bench.worker, { outboxEventId, tenantId, eventType, payload });
  }

  async function avisos(drawId: string): Promise<string[]> {
    const { rows } = await bench.owner.query<{ dedupe_key: string }>(
      'SELECT dedupe_key FROM notifications_sent WHERE draw_id = $1 ORDER BY dedupe_key',
      [drawId],
    );
    return rows.map((r) => r.dedupe_key.replace(`draw:${drawId}:`, ''));
  }

  const numeros = (de: number, ate: number) => Array.from({ length: ate - de + 1 }, (_, i) => de + i);

  /** Payload de `order.paid` para um pedido recem-pago de N numeros. */
  const orderPaid = (drawId: string, quantity: number) => ({
    tenantId,
    orderId: '00000000-0000-4000-8000-000000000001',
    drawId,
    paymentId: null,
    quantity,
    totalCents: quantity * 1000,
  });

  // -------------------------------------------------------------------------
  describe('order.paid · limiares "faltam X" (RN18)', () => {
    it('avisa quando o pedido CRUZA um limiar, e so entao', async () => {
      const draw = await seedDraw(bench.owner, tenantId);
      await seedPaidNumbers(bench.owner, tenantId, draw, numeros(0, 69)); // 30 restantes

      // +5 -> 25 restantes: cruza o 25.
      await seedPaidNumbers(bench.owner, tenantId, draw, numeros(70, 74));
      await entregar('order.paid', orderPaid(draw, 5));
      expect(await avisos(draw)).toEqual(['remaining:25']);

      // +10 -> 15 restantes: nenhum limiar novo.
      await seedPaidNumbers(bench.owner, tenantId, draw, numeros(75, 84));
      await entregar('order.paid', orderPaid(draw, 10));
      expect(await avisos(draw)).toEqual(['remaining:25']);

      // +7 -> 8 restantes: cruza o 10.
      await seedPaidNumbers(bench.owner, tenantId, draw, numeros(85, 91));
      await entregar('order.paid', orderPaid(draw, 7));
      expect(await avisos(draw)).toEqual(['remaining:10', 'remaining:25']);
    });

    it('um pedido grande que pula dois limiares dispara os dois', async () => {
      const draw = await seedDraw(bench.owner, tenantId);
      await seedPaidNumbers(bench.owner, tenantId, draw, numeros(0, 59)); // 40 restantes
      await seedPaidNumbers(bench.owner, tenantId, draw, numeros(60, 91)); // +32 -> 8 restantes
      await entregar('order.paid', orderPaid(draw, 32));
      expect(await avisos(draw)).toEqual(['remaining:10', 'remaining:25']);
    });

    it('RN18: reserva e pendencia NAO contam como vendidas', async () => {
      const draw = await seedDraw(bench.owner, tenantId);
      await seedPaidNumbers(bench.owner, tenantId, draw, numeros(0, 49)); // 50 restantes
      // 30 numeros PENDENTES: nao mudam o "faltam".
      await seedPendingOrder(bench.owner, tenantId, draw, numeros(50, 79), { payment: false, reservationExpiresAgo: '-10 minutes' });
      await entregar('order.paid', orderPaid(draw, 1));
      expect(await avisos(draw)).toEqual([]);
    });

    it('os limiares vem do sorteio (nao sao fixos)', async () => {
      const draw = await seedDraw(bench.owner, tenantId, { thresholds: [50, 20, 5] });
      await seedPaidNumbers(bench.owner, tenantId, draw, numeros(0, 55)); // 44 restantes
      await entregar('order.paid', orderPaid(draw, 56)); // saiu de 100 para 44: cruza 50
      expect(await avisos(draw)).toEqual(['remaining:50']);
    });

    it('idempotente: o mesmo evento entregue de novo nao registra outra vez', async () => {
      const draw = await seedDraw(bench.owner, tenantId);
      await seedPaidNumbers(bench.owner, tenantId, draw, numeros(0, 74)); // 25
      const payload = orderPaid(draw, 5);
      const id = await entregar('order.paid', payload);
      await reentregar(id, 'order.paid', payload);
      await reentregar(id, 'order.paid', payload);
      expect(await avisos(draw)).toEqual(['remaining:25']);
      const { rows } = await bench.owner.query(
        "SELECT count(*)::int AS n FROM event_consumptions WHERE event_id = $1 AND consumer = 'order-paid-thresholds'",
        [id],
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('dois EVENTOS diferentes dizendo a mesma coisa: a dedupe_key impede o segundo aviso', async () => {
      const draw = await seedDraw(bench.owner, tenantId);
      await seedPaidNumbers(bench.owner, tenantId, draw, numeros(0, 74));
      await entregar('order.paid', orderPaid(draw, 5));
      await entregar('order.paid', orderPaid(draw, 5));
      expect(await avisos(draw)).toEqual(['remaining:25']);
    });

    it('esgotou: avisa "esgotado" e FECHA as vendas quando o modo permite', async () => {
      const draw = await seedDraw(bench.owner, tenantId, { closeMode: 'AO_ESGOTAR' });
      await seedPaidNumbers(bench.owner, tenantId, draw, numeros(0, 99));
      await entregar('order.paid', orderPaid(draw, 3));

      expect(await avisos(draw)).toContain('sold_out');
      expect(['VENDAS ENCERRADAS', 'APURAÇÃO']).toContain(await statusOf(bench.owner, 'draws', draw));
      const { rows } = await bench.owner.query(
        "SELECT count(*)::int AS n FROM outbox WHERE payload->>'drawId' = $1 AND event_type = 'draw.sales_closed'",
        [draw],
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('esgotou em modo POR_DATA: avisa, mas NAO fecha (a data manda)', async () => {
      const draw = await seedDraw(bench.owner, tenantId, {
        closeMode: 'POR_DATA',
        closeAt: new Date(Date.now() + 9e6).toISOString(),
      });
      await seedPaidNumbers(bench.owner, tenantId, draw, numeros(0, 99));
      await entregar('order.paid', orderPaid(draw, 3));
      expect(await avisos(draw)).toContain('sold_out');
      expect(await statusOf(bench.owner, 'draws', draw)).toBe('ATIVA');
    });

    it('sorteio que nao existe mais: conclui sem erro (repetir so entupiria a fila)', async () => {
      await expect(
        entregar('order.paid', orderPaid('00000000-0000-4000-8000-0000000000aa', 1)),
      ).resolves.toBeDefined();
    });

    it('payload invalido falha (a fila tenta de novo e a dead-letter o expoe)', async () => {
      await expect(entregar('order.paid', { drawId: 'nao-e-uuid' })).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  describe('draw.activated e draw.result_published', () => {
    const lifecycle = (drawId: string, from: string, to: string) => ({
      tenantId, drawId, from, to, actorUserId: null, actorType: 'SYSTEM', reason: null,
    });

    it('draw.activated registra o aviso de abertura, uma vez', async () => {
      const draw = await seedDraw(bench.owner, tenantId);
      const payload = lifecycle(draw, 'AGENDADA', 'ATIVA');
      const id = await entregar('draw.activated', payload);
      await reentregar(id, 'draw.activated', payload);
      await entregar('draw.activated', payload);
      expect(await avisos(draw)).toEqual(['activated']);
    });

    it('draw.result_published registra o aviso do resultado; a CORRECAO nao reavisa', async () => {
      const draw = await seedDraw(bench.owner, tenantId);
      const resultado = {
        tenantId, drawId: draw, resultId: '00000000-0000-4000-8000-000000000002',
        version: 1, winningNumber: 42, proofSha256: 'a'.repeat(64),
      };
      await entregar('draw.result_published', resultado);
      await entregar('draw.result_corrected', { ...resultado, version: 2 });
      expect(await avisos(draw)).toEqual(['result_published']);
    });

    it('eventos conhecidos sem consumidor nao lancam', async () => {
      const draw = await seedDraw(bench.owner, tenantId);
      for (const tipo of ['draw.submitted', 'draw.approved', 'draw.rejected', 'draw.paused', 'draw.resumed', 'payment.refund_required']) {
        await expect(entregar(tipo, lifecycle(draw, 'ATIVA', 'PAUSADA')), tipo).resolves.toBeDefined();
      }
    });

    it('evento DESCONHECIDO continua falhando (nao some em silencio)', async () => {
      await expect(entregar('draw.inventado', {})).rejects.toThrow(/sem consumidor/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('draw.sales_closed · avanca ja, sem esperar o job', () => {
    const closed = (drawId: string) => ({
      tenantId, drawId, from: 'ATIVA', to: 'VENDAS ENCERRADAS', actorUserId: null, actorType: 'SYSTEM', reason: null,
    });

    it('sem pendencia: congela o retrato e abre a apuracao', async () => {
      const draw = await seedDraw(bench.owner, tenantId, { status: 'VENDAS ENCERRADAS' });
      await seedPaidNumbers(bench.owner, tenantId, draw, [3, 4]);
      await entregar('draw.sales_closed', closed(draw));
      expect(await statusOf(bench.owner, 'draws', draw)).toBe('APURAÇÃO');
    });

    it('com pendencia: espera (o job continua tentando)', async () => {
      const draw = await seedDraw(bench.owner, tenantId, { status: 'VENDAS ENCERRADAS' });
      await seedPendingOrder(bench.owner, tenantId, draw, [7], { payment: false, reservationExpiresAgo: '-10 minutes' });
      await entregar('draw.sales_closed', closed(draw));
      expect(await statusOf(bench.owner, 'draws', draw)).toBe('VENDAS ENCERRADAS');
    });

    it('idempotente: reentregar nao repete o avanco', async () => {
      const draw = await seedDraw(bench.owner, tenantId, { status: 'VENDAS ENCERRADAS' });
      await seedPaidNumbers(bench.owner, tenantId, draw, [1]);
      const id = await entregar('draw.sales_closed', closed(draw));
      await reentregar(id, 'draw.sales_closed', closed(draw));
      const { rows } = await bench.owner.query(
        "SELECT count(*)::int AS n FROM outbox WHERE payload->>'drawId' = $1 AND event_type = 'draw.apuration_started'",
        [draw],
      );
      expect(rows[0]!.n).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('logs estruturados', () => {
    it('cada linha e JSON com event_id, event_type e tenant_id, e nao carrega dado pessoal', async () => {
      const linhas: Record<string, unknown>[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((l: unknown) => {
        linhas.push(JSON.parse(String(l)));
      });
      try {
        const draw = await seedDraw(bench.owner, tenantId);
        await seedPaidNumbers(bench.owner, tenantId, draw, numeros(0, 74));
        const id = await entregar('order.paid', orderPaid(draw, 5));

        expect(linhas.length).toBeGreaterThanOrEqual(2);
        for (const l of linhas) {
          expect(l).toMatchObject({ service: 'worker', event_id: id, event_type: 'order.paid', tenant_id: tenantId });
        }
        expect(linhas.map((l) => l['msg'])).toEqual(['evento iniciado', 'evento concluido']);
        const texto = JSON.stringify(linhas);
        expect(texto).not.toContain('Joao');
        expect(texto).not.toContain('99876');
      } finally {
        spy.mockRestore();
      }
    });
  });
});
