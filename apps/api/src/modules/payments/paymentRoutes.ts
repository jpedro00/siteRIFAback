import type { Request, RequestHandler, Response } from 'express';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';
import { ensurePixPayment, handlePspWebhook } from './paymentService.js';

/** M05 · rotas de pagamento PIX e webhook do Mercado Pago. */

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

function pathParam(req: Request, nome: string): string {
  const valor = req.params[nome];
  if (typeof valor !== 'string' || valor === '') {
    throw ApiError.badRequest(`Parâmetro "${nome}" ausente na rota.`);
  }
  return valor;
}

/** Cabecalhos e query como mapa de texto simples, para o adaptador do PSP. */
function flatten(source: Record<string, unknown>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [chave, valor] of Object.entries(source)) {
    out[chave.toLowerCase()] = Array.isArray(valor) ? String(valor[0]) : valor === undefined ? undefined : String(valor);
  }
  return out;
}

export function buildPaymentHandlers(deps: AppDeps): Record<string, RequestHandler> {
  return {
    /**
     * Gera (ou devolve) o PIX do pedido. Rota publica: o pedido e identificado
     * pelo id, dentro da comunidade resolvida — como o comprovante.
     */
    publicOrderPayment: asyncHandler(async (req, res) => {
      const tenant = req.tenant;
      if (!tenant) throw ApiError.tenantNotResolved();
      const order = await ensurePixPayment(deps, {
        tenantId: tenant.tenantId,
        tenantSlug: tenant.slug,
        orderId: pathParam(req, 'id'),
      });
      res.status(200).json(order);
    }),

    /**
     * Webhook do Mercado Pago. Sem sessao: a autenticidade vem da ASSINATURA, e
     * o que vale vem da CONSULTA ao PSP. Responde 200 a aviso valido, mesmo o
     * que nao pede acao.
     */
    mercadopagoWebhook: asyncHandler(async (req, res) => {
      await handlePspWebhook(deps, {
        tenantSlug: pathParam(req, 'tenant'),
        headers: flatten(req.headers),
        query: flatten(req.query as Record<string, unknown>),
        body: req.body,
      });
      res.status(200).json({ received: true });
    }),
  };
}
