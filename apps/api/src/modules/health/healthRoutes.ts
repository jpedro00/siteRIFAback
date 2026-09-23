import type { Request, RequestHandler, Response } from 'express';
import type { HealthResponse } from '@campaigns/shared';
import type { AppDeps } from '../../deps.js';

/** M12 · diagnostico. Sem sessao, sem contexto de comunidade, sem dado de negocio. */
function asyncHandler(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function buildHealthHandler(deps: AppDeps): Record<string, RequestHandler> {
  return {
    health: asyncHandler(async (_req, res) => {
      let database: HealthResponse['database'] = 'down';
      try {
        await deps.pool.query('SELECT 1');
        database = 'up';
      } catch {
        database = 'down';
      }
      // A rota responde 200 mesmo com o banco fora: quem consome precisa
      // distinguir "API no ar, banco fora" de "API fora".
      const response: HealthResponse = { status: 'ok', database };
      res.status(200).json(response);
    }),
  };
}
