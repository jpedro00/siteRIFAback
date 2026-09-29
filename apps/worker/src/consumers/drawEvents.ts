import type { DbPool, PoolClient } from '@clubedarifa/db';
import {
  drawLifecyclePayloadSchema,
  drawResultPayloadSchema,
  orderPaidPayloadSchema,
} from '@clubedarifa/shared';
import { avancarEncerrados } from '../jobs/definitions.js';
import type { Logger } from '@clubedarifa/logging';

/**
 * Consumidores dos eventos de sorteio e de pagamento. M05 · M06.
 *
 * NENHUM envia mensagem: o envio real (WhatsApp, e-mail) e da Fase 8. O que
 * existe aqui e o REGISTRO, em `notifications_sent`, de que um aviso deveria sair
 * — uma vez so, pela chave `dedupe_key`.
 *
 * IDEMPOTENCIA: o mesmo padrao de `provisionTenantBranding`. O consumidor
 * reivindica o evento em `event_consumptions` NA MESMA transacao do efeito;
 * reprocessar colide na chave e nao repete nada. E, alem disso, cada aviso tem a
 * propria `dedupe_key`, que protege inclusive contra dois eventos diferentes
 * dizendo a mesma coisa.
 */

export const CONSUMERS = {
  orderPaid: 'order-paid-thresholds',
  drawActivated: 'draw-activated-notification',
  resultPublished: 'result-published-notification',
  salesClosed: 'sales-closed-advance',
} as const;

export interface ConsumeResult {
  readonly applied: boolean;
  readonly reason?: 'already_consumed' | 'draw_missing';
}

/** Reivindica o evento e roda o efeito na MESMA transacao. */
async function consumeOnce(
  pool: DbPool,
  eventId: string,
  consumer: string,
  efeito: (client: PoolClient) => Promise<ConsumeResult['reason'] | void>,
): Promise<ConsumeResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO event_consumptions (event_id, consumer) VALUES ($1, $2)
       ON CONFLICT (event_id, consumer) DO NOTHING`,
      [eventId, consumer],
    );
    if ((claim.rowCount ?? 0) === 0) {
      await client.query('COMMIT');
      return { applied: false, reason: 'already_consumed' };
    }

    const motivo = await efeito(client);
    await client.query('COMMIT');
    return motivo ? { applied: false, reason: motivo } : { applied: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.query('RESET ALL').catch(() => undefined);
    client.release();
  }
}

async function registrarAviso(
  client: PoolClient,
  aviso: {
    tenantId: string;
    drawId: string;
    kind: string;
    dedupeKey: string;
    payload: Record<string, unknown>;
  },
): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO notifications_sent (tenant_id, draw_id, kind, dedupe_key, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [aviso.tenantId, aviso.drawId, aviso.kind, aviso.dedupeKey, JSON.stringify(aviso.payload)],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * `order.paid`: confere esgotamento e limiares ("faltam X").
 *
 * "Faltam X" = total - numeros PAGO (RN18): reserva e pendencia nunca contam. Um
 * limiar so avisa quando ESTE pedido o cruzou — `restantes <= limiar` e, antes
 * dele, `restantes + quantidade > limiar` —, entao um pedido grande que pula do
 * 30 para o 8 dispara o 25 e o 10, e um pedido pequeno depois nao repete.
 */
export async function consumeOrderPaid(
  pool: DbPool,
  input: { eventId: string; payload: unknown },
): Promise<ConsumeResult> {
  const p = orderPaidPayloadSchema.parse(input.payload);

  return consumeOnce(pool, input.eventId, CONSUMERS.orderPaid, async (client) => {
    const { rows } = await client.query<{
      total_numbers: number;
      thresholds: number[];
      status: string;
      close_mode: string;
    }>('SELECT total_numbers, thresholds, status::text AS status, close_mode::text AS close_mode FROM draws WHERE id = $1', [
      p.drawId,
    ]);
    const draw = rows[0];
    if (!draw) return 'draw_missing';

    const { rows: pagos } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM draw_numbers WHERE draw_id = $1 AND status = 'PAGO'",
      [p.drawId],
    );
    const restantes = draw.total_numbers - pagos[0]!.n;

    for (const limiar of draw.thresholds) {
      if (restantes <= limiar && restantes + p.quantity > limiar) {
        await registrarAviso(client, {
          tenantId: p.tenantId,
          drawId: p.drawId,
          kind: 'DRAW_REMAINING_THRESHOLD',
          dedupeKey: `draw:${p.drawId}:remaining:${limiar}`,
          payload: { remaining: restantes, threshold: limiar },
        });
      }
    }

    if (restantes === 0) {
      await registrarAviso(client, {
        tenantId: p.tenantId,
        drawId: p.drawId,
        kind: 'DRAW_SOLD_OUT',
        dedupeKey: `draw:${p.drawId}:sold_out`,
        payload: { totalNumbers: draw.total_numbers },
      });

      // Esgotou e o modo de fechamento permite: fecha JA, sem esperar o proximo
      // ciclo do job (que continua como rede de seguranca).
      const fechaAoEsgotar = draw.close_mode === 'AO_ESGOTAR' || draw.close_mode === 'O_QUE_VIER_PRIMEIRO';
      if (fechaAoEsgotar && (draw.status === 'ATIVA' || draw.status === 'PAUSADA')) {
        await client.query("SELECT app.worker_transition_draw($1, 'VENDAS ENCERRADAS', $2)", [
          p.drawId,
          'grade esgotada',
        ]);
      }
    }
  });
}

/** `draw.activated`: registra o aviso de abertura (a Fase 8 decide como avisar). */
export async function consumeDrawActivated(
  pool: DbPool,
  input: { eventId: string; payload: unknown },
): Promise<ConsumeResult> {
  const p = drawLifecyclePayloadSchema.parse(input.payload);
  return consumeOnce(pool, input.eventId, CONSUMERS.drawActivated, async (client) => {
    await registrarAviso(client, {
      tenantId: p.tenantId,
      drawId: p.drawId,
      kind: 'DRAW_ACTIVATED',
      dedupeKey: `draw:${p.drawId}:activated`,
      payload: { from: p.from },
    });
  });
}

/** `draw.result_published`: registra o aviso do resultado. Uma correcao nao reavisa. */
export async function consumeResultPublished(
  pool: DbPool,
  input: { eventId: string; payload: unknown },
): Promise<ConsumeResult> {
  const p = drawResultPayloadSchema.parse(input.payload);
  return consumeOnce(pool, input.eventId, CONSUMERS.resultPublished, async (client) => {
    await registrarAviso(client, {
      tenantId: p.tenantId,
      drawId: p.drawId,
      kind: 'RESULT_PUBLISHED',
      dedupeKey: `draw:${p.drawId}:result_published`,
      payload: { winningNumber: p.winningNumber, proofSha256: p.proofSha256 },
    });
  });
}

/**
 * `draw.sales_closed`: tenta congelar o retrato e abrir a apuracao JA, em vez de
 * esperar o proximo ciclo do job. Se ainda ha pendencia, nao faz nada — o job
 * `fechar-sorteios` continua tentando a cada minuto.
 */
export async function consumeSalesClosed(
  pool: DbPool,
  log: Logger,
  input: { eventId: string; payload: unknown },
): Promise<ConsumeResult> {
  const p = drawLifecyclePayloadSchema.parse(input.payload);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO event_consumptions (event_id, consumer) VALUES ($1, $2)
       ON CONFLICT (event_id, consumer) DO NOTHING`,
      [input.eventId, CONSUMERS.salesClosed],
    );
    await client.query('COMMIT');
    if ((claim.rowCount ?? 0) === 0) return { applied: false, reason: 'already_consumed' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  // Fora da transacao de reivindicacao: cada funcao do banco tem a sua. Falhar
  // aqui nao perde nada — o job repete.
  await avancarEncerrados(pool, log, p.drawId);
  return { applied: true };
}
