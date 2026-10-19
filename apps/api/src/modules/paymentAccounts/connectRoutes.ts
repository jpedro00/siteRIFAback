import type { Request, RequestHandler, Response } from 'express';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';
import { beginStripeOnboarding, handleConnectWebhook, refreshStripeAccount } from './connectService.js';

/**
 * Stripe Connect: cadastro da conta do criador, releitura do estado e webhook. A permissao
 * `payment_account:manage` (e o MFA do cadastro) vem do contrato e e aplicada antes destes
 * handlers. Nenhum handler le id de conta ou de comunidade do CORPO.
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

export function buildConnectHandlers(deps: AppDeps): Record<string, RequestHandler> {
  return {
    connectStripeAccount: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      const { url } = await beginStripeOnboarding(deps, { tenantId: tenant.tenantId, userId: session.userId });
      // O link e de uso unico e expira: nao fica em cache.
      res.status(200).set('Cache-Control', 'no-store').json({ url });
    }),

    refreshStripeAccount: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      res
        .status(200)
        .set('Cache-Control', 'no-store')
        .json(await refreshStripeAccount(deps, { tenantId: tenant.tenantId, userId: session.userId }));
    }),

    /**
     * Webhook do Stripe Connect. Sem sessao: a autenticidade vem da ASSINATURA sobre o corpo
     * bruto. Responde 2xx so depois de gravar e processar; falha transitoria = 503 (a Stripe
     * reenvia, e o evento continua pendente).
     */
    stripeConnectWebhook: asyncHandler(async (req, res) => {
      const result = await handleConnectWebhook(deps, {
        rawBody: (req as Request & { rawBody?: Buffer }).rawBody,
        signature: typeof req.headers['stripe-signature'] === 'string' ? req.headers['stripe-signature'] : undefined,
      });
      res.status(200).json({ received: true, result });
    }),
  };
}
