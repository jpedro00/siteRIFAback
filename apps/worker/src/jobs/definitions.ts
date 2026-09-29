import { PspRejectedError, PspUnavailableError, type PspPayment } from '@clubedarifa/psp';
import type { DbPool } from '@clubedarifa/db';
import type { JobContext, JobDefinition } from './types.js';

/**
 * Os jobs do worker. P8 · M05 · M06.
 *
 * Cada um decide QUAIS registros olhar e chama a funcao do banco que conferere o
 * estado e faz a transicao (`app.worker_*`, `app.apply_psp_payment`). Nenhum job
 * altera estado por SQL solto: assim a regra existe em UM lugar, e rodar o mesmo
 * job duas vezes e no-op.
 */

/** Folga depois do vencimento antes de mexer: absorve relogio e webhook atrasado. */
const FOLGA_PIX = "interval '2 minutes'";

const LOTE = 1000;

// ---------------------------------------------------------------------------
// expirar-reservas · 1 min
// ---------------------------------------------------------------------------
export const expirarReservas: JobDefinition = {
  name: 'expirar-reservas',
  cron: '* * * * *',
  intervalSeconds: 60,
  async run({ pool }) {
    // A grade ja trata o numero vencido como livre pelo relogio; aqui o STATUS da
    // reserva deixa de mentir. Nunca toca em numero, e portanto nunca em PAGO.
    let total = 0;
    for (let rodada = 0; rodada < 20; rodada += 1) {
      const { rows } = await pool.query<{ n: number }>(
        'SELECT app.worker_expire_reservations($1) AS n',
        [LOTE],
      );
      const n = rows[0]!.n;
      total += n;
      if (n < LOTE) break;
    }
    return total;
  },
};

// ---------------------------------------------------------------------------
// ativar-agendados · 1 min
// ---------------------------------------------------------------------------
export const ativarAgendados: JobDefinition = {
  name: 'ativar-agendados',
  cron: '* * * * *',
  intervalSeconds: 60,
  async run({ pool, log }) {
    const { rows } = await pool.query<{ id: string; tenant_id: string }>(
      `SELECT id, tenant_id FROM draws
        WHERE status = 'AGENDADA' AND sales_start_at IS NOT NULL AND sales_start_at <= now()
        ORDER BY sales_start_at LIMIT 200`,
    );
    let ativados = 0;
    for (const draw of rows) {
      try {
        await pool.query("SELECT app.worker_transition_draw($1, 'ATIVA', $2)", [
          draw.id,
          'sales_start_at chegou',
        ]);
        ativados += 1;
      } catch (error) {
        // Um sorteio que falha nao trava os outros; o proximo ciclo tenta de novo.
        log.error('falha ao ativar sorteio agendado', {
          draw_id: draw.id,
          tenant_id: draw.tenant_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return ativados;
  },
};

// ---------------------------------------------------------------------------
// fechar-sorteios · 1 min
// ---------------------------------------------------------------------------
export const fecharSorteios: JobDefinition = {
  name: 'fechar-sorteios',
  cron: '* * * * *',
  intervalSeconds: 60,
  async run({ pool, log }) {
    let trabalhados = 0;

    // A) Vendas que devem fechar: data de fechamento vencida, ou grade esgotada.
    const { rows: aFechar } = await pool.query<{ id: string; tenant_id: string; motivo: string }>(
      `SELECT d.id, d.tenant_id,
              CASE WHEN d.close_mode IN ('POR_DATA', 'O_QUE_VIER_PRIMEIRO')
                        AND d.close_at IS NOT NULL AND d.close_at <= now()
                   THEN 'close_at vencido' ELSE 'grade esgotada' END AS motivo
         FROM draws d
        WHERE d.status IN ('ATIVA', 'PAUSADA')
          AND (
            (d.close_mode IN ('POR_DATA', 'O_QUE_VIER_PRIMEIRO')
              AND d.close_at IS NOT NULL AND d.close_at <= now())
            OR (d.close_mode IN ('AO_ESGOTAR', 'O_QUE_VIER_PRIMEIRO')
              AND (SELECT count(*) FROM draw_numbers n
                    WHERE n.draw_id = d.id AND n.status = 'PAGO') >= d.total_numbers)
          )
        LIMIT 200`,
    );
    for (const draw of aFechar) {
      try {
        await pool.query("SELECT app.worker_transition_draw($1, 'VENDAS ENCERRADAS', $2)", [
          draw.id,
          draw.motivo,
        ]);
        trabalhados += 1;
      } catch (error) {
        log.error('falha ao fechar vendas', {
          draw_id: draw.id,
          tenant_id: draw.tenant_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // B) Vendas ja encerradas: congela o retrato (RN20) e abre a apuracao quando
    //    nao ha mais pendencia. Com pendencia, o retrato devolve nulo e o proximo
    //    ciclo tenta de novo.
    trabalhados += await avancarEncerrados(pool, log);
    return trabalhados;
  },
};

/** VENDAS ENCERRADAS -> snapshot -> APURACAO, para os sorteios sem pendencia. */
export async function avancarEncerrados(
  pool: DbPool,
  log: JobContext['log'],
  somenteSorteio?: string,
): Promise<number> {
  const { rows } = await pool.query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id FROM draws
      WHERE status = 'VENDAS ENCERRADAS' AND ($1::uuid IS NULL OR id = $1::uuid)
      ORDER BY updated_at LIMIT 200`,
    [somenteSorteio ?? null],
  );
  let avancados = 0;
  for (const draw of rows) {
    try {
      const { rows: s } = await pool.query<{ id: string | null }>(
        'SELECT app.worker_create_draw_snapshot($1) AS id',
        [draw.id],
      );
      if (s[0]!.id === null) continue; // ainda ha pendencia
      await pool.query("SELECT app.worker_transition_draw($1, 'APURAÇÃO', $2)", [
        draw.id,
        'snapshot criado',
      ]);
      avancados += 1;
    } catch (error) {
      log.error('falha ao avancar sorteio encerrado', {
        draw_id: draw.id,
        tenant_id: draw.tenant_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return avancados;
}

// ---------------------------------------------------------------------------
// expirar-pix · 5 min
// ---------------------------------------------------------------------------

interface PixVencido {
  payment_id: string;
  order_id: string;
  provider: string;
  provider_payment_id: string;
  tenant_id: string;
}

/** Aplica no banco o que o PSP respondeu. Mesma funcao que o webhook usa. */
export async function aplicarPagamentoDoPsp(
  pool: DbPool,
  provider: string,
  remoto: PspPayment,
): Promise<string> {
  const { rows } = await pool.query<{ r: string }>(
    'SELECT app.apply_psp_payment($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb) AS r',
    [
      provider,
      remoto.providerPaymentId,
      remoto.status,
      remoto.amountCents,
      remoto.externalReference,
      remoto.paidAt,
      JSON.stringify(remoto.raw ?? null),
    ],
  );
  return rows[0]!.r;
}

export const expirarPix: JobDefinition = {
  name: 'expirar-pix',
  cron: '*/5 * * * *',
  intervalSeconds: 300,
  async run({ pool, psp, log }) {
    let liberados = 0;

    // 1) PIX vencido: CONSULTA o PSP antes de liberar. Se ele diz "pago", a venda
    //    se conclui; so se ele NAO confirma os numeros voltam para a grade. Se o PSP
    //    nao responde, nada e liberado — liberar no escuro venderia duas vezes um
    //    numero que alguem acabou de pagar.
    const { rows: vencidos } = await pool.query<PixVencido>(
      `SELECT p.id AS payment_id, p.order_id, p.provider, p.provider_payment_id, p.tenant_id
         FROM payments p
         JOIN orders o ON o.id = p.order_id
        WHERE p.status = 'PENDENTE' AND o.status = 'PENDENTE'
          AND p.expires_at < now() - ${FOLGA_PIX}
        ORDER BY p.expires_at
        LIMIT 100`,
    );

    for (const pagamento of vencidos) {
      const campos = {
        order_id: pagamento.order_id,
        payment_id: pagamento.payment_id,
        tenant_id: pagamento.tenant_id,
      };

      if (!psp || psp.provider !== pagamento.provider) {
        log.warn('PIX vencido, mas nao ha provedor para consultar; nada liberado', campos);
        continue;
      }

      let remoto: PspPayment;
      try {
        remoto = await psp.getPayment(pagamento.provider_payment_id);
      } catch (error) {
        if (error instanceof PspUnavailableError || error instanceof PspRejectedError) {
          log.warn('PSP nao respondeu a consulta; nada liberado', {
            ...campos,
            error: error.message,
          });
          continue;
        }
        throw error;
      }

      const resultado = await aplicarPagamentoDoPsp(pool, psp.provider, remoto);
      if (resultado === 'paid' || resultado === 'refund_required' || resultado === 'mismatch') {
        // Pago (venda concluida ou estorno manual marcado) ou dado divergente: nao se libera.
        log.info('PIX vencido, mas o PSP informou outra situacao', { ...campos, resultado });
        continue;
      }

      const { rows } = await pool.query<{ r: string }>(
        'SELECT app.worker_release_order($1, $2) AS r',
        [pagamento.order_id, 'PIX vencido sem pagamento'],
      );
      if (rows[0]!.r === 'RELEASED') liberados += 1;
    }

    // 2) Pedido pendente, reserva vencida, e nenhuma cobranca ativa (o PSP estava
    //    fora quando o pedido nasceu, ou a cobranca ja fechou): nada a consultar.
    const { rows: semCobranca } = await pool.query<{ id: string }>(
      `SELECT o.id
         FROM orders o
         JOIN reservations r ON r.id = o.reservation_id
        WHERE o.status = 'PENDENTE'
          AND r.expires_at < now() - ${FOLGA_PIX}
          AND NOT EXISTS (
            SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status IN ('PENDENTE', 'APROVADO')
          )
        ORDER BY r.expires_at
        LIMIT 100`,
    );
    for (const pedido of semCobranca) {
      const { rows } = await pool.query<{ r: string }>(
        'SELECT app.worker_release_order($1, $2) AS r',
        [pedido.id, 'reserva vencida sem cobranca ativa'],
      );
      if (rows[0]!.r === 'RELEASED') liberados += 1;
    }

    return liberados;
  },
};

// ---------------------------------------------------------------------------
// conciliacao · diario
// ---------------------------------------------------------------------------
export const conciliacao: JobDefinition = {
  name: 'conciliacao',
  cron: '0 3 * * *',
  intervalSeconds: 86_400,
  async run({ pool, psp, log }) {
    // 1) Local: pagamentos x pedidos.
    const { rows } = await pool.query<{ n: number }>("SELECT app.worker_reconcile_local('7 days') AS n");
    let divergencias = rows[0]!.n;

    // 2) PSP x banco: cobrancas que o PSP pode ter aprovado sem o webhook chegar.
    if (!psp) return divergencias;
    const { rows: abertos } = await pool.query<{
      id: string;
      provider: string;
      provider_payment_id: string;
    }>(
      `SELECT id, provider, provider_payment_id FROM payments
        WHERE status IN ('PENDENTE', 'EXPIRADO', 'CANCELADO')
          AND provider = $1 AND created_at >= now() - interval '3 days'
        ORDER BY created_at DESC LIMIT 200`,
      [psp.provider],
    );
    for (const pagamento of abertos) {
      try {
        const remoto = await psp.getPayment(pagamento.provider_payment_id);
        if (remoto.status !== 'APROVADO') continue;

        // O PSP recebeu e nos nao sabiamos: registra a divergencia E cura.
        const { rows: criada } = await pool.query<{ r: boolean }>(
          'SELECT app.worker_record_reconciliation_issue($1, $2, $3::jsonb) AS r',
          [pagamento.id, 'PSP_APPROVED_LOCAL_PENDING', JSON.stringify({ providerStatus: remoto.status })],
        );
        if (criada[0]!.r) divergencias += 1;
        await aplicarPagamentoDoPsp(pool, psp.provider, remoto);
      } catch (error) {
        if (error instanceof PspUnavailableError || error instanceof PspRejectedError) {
          log.warn('conciliacao: PSP nao respondeu para um pagamento', {
            payment_id: pagamento.id,
            error: error.message,
          });
          continue;
        }
        throw error;
      }
    }
    return divergencias;
  },
};

// ---------------------------------------------------------------------------
// limpeza-outbox · diario
// ---------------------------------------------------------------------------
export const limpezaOutbox: JobDefinition = {
  name: 'limpeza-outbox',
  cron: '30 3 * * *',
  intervalSeconds: 86_400,
  async run({ pool }) {
    // Arquiva o que foi publicado ha mais de 30 dias. NUNCA apaga `audit_events`
    // (so-insercao) e nunca arquiva dead-letter (precisa de inspecao).
    let total = 0;
    for (let rodada = 0; rodada < 20; rodada += 1) {
      const { rows } = await pool.query<{ n: number }>('SELECT app.worker_archive_outbox(30, 5000) AS n');
      const n = rows[0]!.n;
      total += n;
      if (n < 5000) break;
    }
    return total;
  },
};

export const JOBS: readonly JobDefinition[] = Object.freeze([
  expirarReservas,
  ativarAgendados,
  fecharSorteios,
  expirarPix,
  conciliacao,
  limpezaOutbox,
]);
