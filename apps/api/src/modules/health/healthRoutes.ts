import type { Request, RequestHandler, Response } from 'express';
import { withPlatform } from '@clubedarifa/db';
import type { HealthResponse, PlatformHealthResponse } from '@clubedarifa/shared';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';

/**
 * M12 · saude.
 *
 * DUAS rotas com publicos diferentes:
 *
 *  GET /api/health            publica, curta, para o Render: o banco responde? o
 *                             worker esta em dia? Nenhum dado de negocio.
 *  GET /api/platform/health   do Super Admin (`platform:health:read`, MFA): o
 *                             ultimo ciclo de cada job, o tamanho da dead-letter e
 *                             as divergencias de conciliacao.
 */

interface PaymentHealthJson {
  authorizationsError: number;
  authorizationsRevoked: number;
  accountsDisconnecting: number;
  unavailableIssuesCount: number;
  unavailableIssues: PlatformHealthResponse['paymentAccounts']['unavailableIssues']['items'];
}

/** Tempo maximo esperando o banco. Um banco lento e, para o Render, um banco fora. */
export const HEALTH_DB_TIMEOUT_MS = 2_000;

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/** Rejeita se `promessa` nao resolver a tempo. O temporizador nao segura o processo. */
async function comPrazo<T>(promessa: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const prazo = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('prazo do banco esgotado')), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promessa, prazo]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Um ciclo e "atrasado" quando nada terminou em mais de 3x o intervalo do job. */
const ATRASADO_SQL = `(last_finished_at IS NULL
   OR last_finished_at < now() - make_interval(secs => interval_seconds * 3))`;

export function buildHealthHandler(deps: AppDeps): Record<string, RequestHandler> {
  return {
    health: asyncHandler(async (_req, res) => {
      let database: HealthResponse['database'] = 'down';
      let worker: HealthResponse['worker'] = 'unknown';

      try {
        await comPrazo(deps.pool.query('SELECT 1'), HEALTH_DB_TIMEOUT_MS);
        database = 'up';
      } catch {
        database = 'down';
      }

      if (database === 'up') {
        try {
          const { rows } = await comPrazo(
            deps.pool.query<{ total: number; atrasados: number }>(
              `SELECT count(*)::int AS total, (count(*) FILTER (WHERE ${ATRASADO_SQL}))::int AS atrasados
                 FROM job_heartbeats`,
            ),
            HEALTH_DB_TIMEOUT_MS,
          );
          const { total, atrasados } = rows[0]!;
          worker = total === 0 ? 'unknown' : atrasados > 0 ? 'stale' : 'ok';
        } catch {
          // Nao conseguir ler o heartbeat nao derruba a API: o banco respondeu.
          worker = 'unknown';
        }
      }

      const status: HealthResponse['status'] =
        database === 'down' ? 'down' : worker === 'stale' ? 'degraded' : 'ok';

      // 503 SO quando a API nao consegue atender (banco fora): e o que faz o Render
      // tirar a instancia da rotacao. Worker atrasado e "degraded" com 200 — reiniciar
      // a API nao conserta o worker.
      res.status(status === 'down' ? 503 : 200).json({ status, database, worker } satisfies HealthResponse);
    }),

    platformHealth: asyncHandler(async (req, res) => {
      const session = req.session;
      if (!session) throw ApiError.unauthenticated();

      const resposta = await withPlatform(deps.pool, { userId: session.userId }, async (client) => {
        const { rows: jobs } = await client.query<{
          job_name: string;
          interval_seconds: number;
          last_started_at: string | null;
          last_finished_at: string | null;
          last_success_at: string | null;
          last_duration_ms: number | null;
          last_count: number | null;
          last_error: string | null;
          consecutive_failures: number;
          atrasado: boolean;
        }>(
          `SELECT job_name, interval_seconds, last_started_at, last_finished_at, last_success_at,
                  last_duration_ms, last_count, last_error, consecutive_failures,
                  ${ATRASADO_SQL} AS atrasado
             FROM job_heartbeats ORDER BY job_name`,
        );

        const { rows: dead } = await client.query<{ n: number; mais_antigo: string | null }>(
          `SELECT count(*)::int AS n, min(dead_lettered_at) AS mais_antigo
             FROM outbox WHERE dead_lettered_at IS NOT NULL`,
        );
        const { rows: pendentes } = await client.query<{ n: number; mais_antigo: string | null }>(
          `SELECT count(*)::int AS n, min(created_at) AS mais_antigo
             FROM outbox WHERE published_at IS NULL AND dead_lettered_at IS NULL`,
        );
        const { rows: conciliacao } = await client.query<{ abertas: number; estornos: number }>(
          `SELECT count(*)::int AS abertas,
                  (count(*) FILTER (WHERE kind = 'MANUAL_REFUND_OPEN'))::int AS estornos
             FROM payment_reconciliation_issues WHERE resolved_at IS NULL`,
        );

        const { rows: stripe } = await client.query<{ failed: number; dead: number; pending: number; oldest: string | null }>(
          `SELECT (count(*) FILTER (WHERE status = 'FAILED'))::int AS failed,
                  (count(*) FILTER (WHERE status = 'DEAD'))::int AS dead,
                  (count(*) FILTER (WHERE status = 'RECEIVED'))::int AS pending,
                  min(received_at) FILTER (WHERE status IN ('FAILED', 'DEAD')) AS oldest
             FROM stripe_webhook_events`,
        );
        // Agregado por funcao SECURITY DEFINER: o papel da API nao le credenciais.
        const { rows: pagamentos } = await client.query<{ r: PaymentHealthJson | null }>(
          'SELECT app.platform_payment_health(20) AS r',
        );
        const pay = pagamentos[0]?.r ?? null;

        const worker: PlatformHealthResponse['worker'] =
          jobs.length === 0 ? 'unknown' : jobs.some((j) => j.atrasado) ? 'stale' : 'ok';

        return {
          generatedAt: new Date().toISOString(),
          worker,
          jobs: jobs.map((j) => ({
            name: j.job_name,
            intervalSeconds: j.interval_seconds,
            lastStartedAt: j.last_started_at,
            lastFinishedAt: j.last_finished_at,
            lastSuccessAt: j.last_success_at,
            lastDurationMs: j.last_duration_ms,
            lastCount: j.last_count,
            lastError: j.last_error,
            consecutiveFailures: j.consecutive_failures,
            stale: j.atrasado,
          })),
          deadLetter: { count: dead[0]!.n, oldestAt: dead[0]!.mais_antigo },
          outboxPending: { count: pendentes[0]!.n, oldestAt: pendentes[0]!.mais_antigo },
          reconciliation: {
            openIssues: conciliacao[0]!.abertas,
            manualRefunds: conciliacao[0]!.estornos,
          },
          stripeEvents: {
            failed: stripe[0]!.failed,
            dead: stripe[0]!.dead,
            pending: stripe[0]!.pending,
            oldestProblemAt: stripe[0]!.oldest,
          },
          paymentAccounts: {
            authorizationsError: pay?.authorizationsError ?? 0,
            authorizationsRevoked: pay?.authorizationsRevoked ?? 0,
            accountsDisconnecting: pay?.accountsDisconnecting ?? 0,
            unavailableIssues: { count: pay?.unavailableIssuesCount ?? 0, items: pay?.unavailableIssues ?? [] },
          },
        } satisfies PlatformHealthResponse;
      });

      res.status(200).json(resposta);
    }),
  };
}
