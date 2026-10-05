import type { Request, RequestHandler, Response } from 'express';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';
import { decodeCursor, parseLimit } from '../../lib/cursor.js';
import { exportDrawOrders, getDashboard, listDrawOrders } from './panelService.js';

/** Painel do organizador: indicadores e pedidos. Permissoes vem do contrato. */

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

const requireTenant = (req: Request) => {
  if (!req.tenant) throw ApiError.tenantNotResolved();
  return req.tenant;
};
const requireSession = (req: Request) => {
  if (!req.session) throw ApiError.unauthenticated();
  return req.session;
};

export function buildPanelHandlers(deps: AppDeps): Record<string, RequestHandler> {
  return {
    tenantDashboard: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      res.status(200).json(
        await getDashboard(deps, {
          tenantId: tenant.tenantId,
          userId: session.userId,
          // Valores em dinheiro: direito proprio, nao herdado de "ver o painel".
          canSeeMoney: tenant.permissions.has('payment:read:full'),
        }),
      );
    }),

    organizerDrawOrders: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      const drawId = req.params['id'];
      if (!drawId) throw ApiError.badRequest('Parâmetro "id" ausente na rota.');
      res.status(200).json(
        await listDrawOrders(deps, {
          tenantId: tenant.tenantId,
          userId: session.userId,
          drawId,
          cursor: decodeCursor(req.query['cursor']),
          limit: parseLimit(req.query['limit'], 30, 100),
          contactVisible: tenant.permissions.has('buyer:read:full'),
        }),
      );
    }),

    exportDrawOrders: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      const drawId = req.params['id'];
      if (!drawId) throw ApiError.badRequest('Parâmetro "id" ausente na rota.');
      res.status(200).json(
        await exportDrawOrders(deps, {
          tenantId: tenant.tenantId,
          userId: session.userId,
          drawId,
          origin: { ip: req.context?.ip ?? null, userAgent: req.context?.userAgent ?? null },
        }),
      );
    }),
  };
}
