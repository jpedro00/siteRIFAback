import type { Request, RequestHandler, Response } from 'express';
import { connectPaymentAccountRequestSchema, setPaymentMethodRequestSchema } from '@clubedarifa/shared';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';
import {
  connectPaymentAccount,
  disconnectPaymentAccount,
  getPaymentMethods,
  setMethodEnabled,
  handleOAuthCallback,
  listPaymentAccounts,
} from './paymentAccountService.js';

/**
 * Fase 7 · recebimentos por comunidade. As permissoes `payment_account:read` e
 * `payment_account:manage` (e o MFA) vem do contrato e sao aplicadas antes destes handlers.
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

export function buildPaymentAccountHandlers(deps: AppDeps): Record<string, RequestHandler> {
  return {
    tenantPaymentAccounts: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      res.status(200).json(await listPaymentAccounts(deps, { tenantId: tenant.tenantId, userId: session.userId }));
    }),

    tenantPaymentMethods: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      res.status(200).set('Cache-Control', 'no-store').json(await getPaymentMethods(deps, { tenantId: tenant.tenantId }));
    }),

    setTenantPaymentMethod: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      const body = setPaymentMethodRequestSchema.parse(req.body);
      await setMethodEnabled(deps, {
        tenantId: tenant.tenantId,
        userId: session.userId,
        method: body.method,
        enabled: body.enabled,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      });
      res.status(200).set('Cache-Control', 'no-store').json(await getPaymentMethods(deps, { tenantId: tenant.tenantId }));
    }),

    connectPaymentAccount: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      // So o provedor. Qualquer campo de token no corpo e ignorado pelo schema.
      connectPaymentAccountRequestSchema.parse(req.body);
      res.status(200).json(await connectPaymentAccount(deps, { tenantId: tenant.tenantId, userId: session.userId }));
    }),

    /**
     * Retorno do OAuth. Nao confia so na sessao: a tentativa persistida (state, PKCE, usuario,
     * comunidade) e que autoriza. Responde com um REDIRECT para o painel.
     */
    paymentAccountOAuthCallback: asyncHandler(async (req, res) => {
      const session = requireSession(req);
      const destino = await handleOAuthCallback(deps, {
        state: req.query['state'],
        code: req.query['code'],
        error: req.query['error'],
        sessionUserId: session.userId,
      });
      // O `code` e o `state` nao voltam para a pagina e nao ficam em cache.
      res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer').redirect(302, destino);
    }),

    disconnectPaymentAccount: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      const id = req.params['id'];
      if (typeof id !== 'string' || id === '') throw ApiError.badRequest('Parâmetro "id" ausente na rota.');
      res.status(200).json(
        await disconnectPaymentAccount(deps, { tenantId: tenant.tenantId, userId: session.userId, accountId: id }),
      );
    }),
  };
}
