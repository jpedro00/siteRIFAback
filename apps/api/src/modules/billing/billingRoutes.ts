import type { Request, RequestHandler, Response } from 'express';
import { createCheckoutSessionRequestSchema, createPlanRequestSchema, updatePlanRequestSchema } from '@clubedarifa/shared';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';
import {
  createCheckout,
  createPortal,
  getEntitlements,
  getMyBilling,
  listPlans,
  receiveStripeWebhook,
} from './billingService.js';
import { createPlan, listPlatformPlans, listPlatformSubscriptions, updatePlan } from './platformBillingService.js';

/**
 * Fase 7 · assinatura da plataforma (Stripe). As permissoes `billing:read` e
 * `billing:manage` vem do contrato e sao aplicadas antes destes handlers.
 */

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
const originOf = (req: Request) => ({ ip: req.context?.ip ?? null, userAgent: req.context?.userAgent ?? null });

export function buildBillingHandlers(deps: AppDeps): Record<string, RequestHandler> {
  return {
    // ---- Super Admin (PLATFORM_FINANCE): catalogo e assinaturas ----
    platformPlans: asyncHandler(async (req, res) => {
      res.status(200).json(await listPlatformPlans(deps, { userId: requireSession(req).userId }));
    }),

    platformCreatePlan: asyncHandler(async (req, res) => {
      // Nenhum ID da Stripe entra por aqui: o schema nao tem esse campo.
      const body = createPlanRequestSchema.parse(req.body);
      const { plan, created } = await createPlan(deps, { userId: requireSession(req).userId, body, origin: originOf(req) });
      res.status(created ? 201 : 200).json(plan);
    }),

    platformUpdatePlan: asyncHandler(async (req, res) => {
      const id = req.params['id'];
      if (typeof id !== 'string' || id === '') throw ApiError.badRequest('Parâmetro "id" ausente na rota.');
      const body = updatePlanRequestSchema.parse(req.body);
      res.status(200).json(
        await updatePlan(deps, { userId: requireSession(req).userId, planId: id, body, origin: originOf(req) }),
      );
    }),

    platformSubscriptions: asyncHandler(async (req, res) => {
      res.status(200).json(
        await listPlatformSubscriptions(deps, {
          userId: requireSession(req).userId,
          state: req.query['state'],
          q: req.query['q'],
          cursor: req.query['cursor'],
          limit: req.query['limit'],
        }),
      );
    }),

    tenantBillingPlans: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      res.status(200).json(await listPlans(deps, { tenantId: tenant.tenantId, userId: session.userId }));
    }),

    tenantBilling: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      res.status(200).json(
        await getMyBilling(deps, {
          tenantId: tenant.tenantId,
          userId: session.userId,
          cursor: req.query['cursor'],
          limit: req.query['limit'],
        }),
      );
    }),

    tenantEntitlements: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      res.status(200).json(await getEntitlements(deps, { tenantId: tenant.tenantId, userId: session.userId }));
    }),

    tenantBillingCheckout: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      // So o `planId`. Qualquer campo de preco no corpo e ignorado pelo schema.
      const { planId } = createCheckoutSessionRequestSchema.parse(req.body);
      res.status(200).json(
        await createCheckout(deps, {
          tenantId: tenant.tenantId,
          userId: session.userId,
          planId,
          origin: originOf(req),
        }),
      );
    }),

    tenantBillingPortal: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      res.status(200).json(
        await createPortal(deps, { tenantId: tenant.tenantId, userId: session.userId, origin: originOf(req) }),
      );
    }),

    /**
     * Webhook da Stripe. Sem sessao: a autenticidade vem da ASSINATURA sobre o corpo
     * bruto. Responde 2xx so depois de gravar o evento; o processamento roda em seguida,
     * fora da resposta, e o worker recolhe o que falhar.
     */
    stripeWebhook: asyncHandler(async (req, res) => {
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
      const result = await receiveStripeWebhook(deps, {
        rawBody,
        signature: typeof req.headers['stripe-signature'] === 'string' ? req.headers['stripe-signature'] : undefined,
      });
      res.status(200).json({ received: true });
      if (result.schedule) deps.billing!.schedule(result.eventId);
    }),
  };
}
