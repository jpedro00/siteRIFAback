import type { Request, RequestHandler, Response } from 'express';
import {
  correctResultRequestSchema,
  publishResultRequestSchema,
  recordDeliveryRequestSchema,
} from '@clubedarifa/shared';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';
import {
  correctResult,
  getOrganizerResult,
  getPublicResult,
  publishResult,
  recordDelivery,
} from './resultService.js';

/** M06 · rotas de resultado. RN09 · RN20. */

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

function requireTenant(req: Request) {
  if (!req.tenant) throw ApiError.tenantNotResolved();
  return req.tenant;
}

function requireSession(req: Request) {
  if (!req.session) throw ApiError.unauthenticated();
  return req.session;
}

function pathParam(req: Request, nome: string): string {
  const valor = req.params[nome];
  if (typeof valor !== 'string' || valor === '') {
    throw ApiError.badRequest(`Parâmetro "${nome}" ausente na rota.`);
  }
  return valor;
}

function originOf(req: Request) {
  return { ip: req.context?.ip ?? null, userAgent: req.context?.userAgent ?? null };
}

export function buildResultHandlers(deps: AppDeps): Record<string, RequestHandler> {
  return {
    publicDrawResult: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      res.status(200).json(await getPublicResult(deps, tenant.tenantId, pathParam(req, 'slug')));
    }),

    organizerDrawResult: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      res.status(200).json(
        await getOrganizerResult(deps, {
          tenantId: tenant.tenantId,
          userId: session.userId,
          drawId: pathParam(req, 'id'),
        }),
      );
    }),

    publishDrawResult: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      const body = publishResultRequestSchema.parse(req.body);
      res.status(201).json(
        await publishResult(deps, {
          tenantId: tenant.tenantId,
          userId: session.userId,
          drawId: pathParam(req, 'id'),
          data: body,
          origin: originOf(req),
        }),
      );
    }),

    recordDrawDelivery: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      const body = recordDeliveryRequestSchema.parse(req.body);
      res.status(200).json(
        await recordDelivery(deps, {
          tenantId: tenant.tenantId,
          userId: session.userId,
          drawId: pathParam(req, 'id'),
          data: body,
          origin: originOf(req),
        }),
      );
    }),

    correctDrawResult: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      const body = correctResultRequestSchema.parse(req.body);
      res.status(200).json(
        await correctResult(deps, {
          tenantId: tenant.tenantId,
          userId: session.userId,
          drawId: pathParam(req, 'id'),
          data: body,
          origin: originOf(req),
        }),
      );
    }),
  };
}
