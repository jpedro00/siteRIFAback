import type { Request, RequestHandler, Response } from 'express';
import {
  createDrawRequestSchema,
  createOrderRequestSchema,
  createReservationRequestSchema,
  reviewDrawRequestSchema,
  updateDrawRequestSchema,
  updateDrawStatusRequestSchema,
} from '@clubedarifa/shared';
import type { AppDeps } from '../../deps.js';
import { log } from '../../lib/log.js';
import { decodeCursor, parseLimit } from '../../lib/cursor.js';
import { devConfirmPayment, ensurePixPayment } from '../payments/paymentService.js';
import { ApiError } from '../../lib/apiError.js';
import {
  createDraw,
  createOrder,
  createReservation,
  getDrawNumbers,
  getOrder,
  getOrganizerDraw,
  getPublicDraw,
  listOrganizerDraws,
  listPublicDraws,
  listReviewQueue,
  reviewDraw,
  updateDraw,
  updateDrawStatus,
} from './drawService.js';

/** M02/M03/M04 · rotas de sorteio, reserva e pedido. */

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

function requireTenant(req: Request) {
  const tenant = req.tenant;
  if (!tenant) throw ApiError.tenantNotResolved();
  return tenant;
}

function requireSession(req: Request) {
  const session = req.session;
  if (!session) throw ApiError.unauthenticated();
  return session;
}

/** IP e agente de quem fez a acao, para a trilha de auditoria (RN11). */
function originOf(req: Request) {
  return { ip: req.context?.ip ?? null, userAgent: req.context?.userAgent ?? null };
}

/** Parametro de caminho obrigatorio. Ausente e erro de requisicao, nao 500. */
function pathParam(req: Request, nome: string): string {
  const valor = req.params[nome];
  if (typeof valor !== 'string' || valor === '') {
    throw ApiError.badRequest(`Parâmetro "${nome}" ausente na rota.`);
  }
  return valor;
}

export function buildDrawHandlers(deps: AppDeps): Record<string, RequestHandler> {
  return {
    // -----------------------------------------------------------------------
    // Vitrine
    // -----------------------------------------------------------------------
    publicDraws: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const resposta = await listPublicDraws(deps, tenant.tenantId, {
        cursor: decodeCursor(req.query['cursor'], { banded: true }),
        limit: parseLimit(req.query['limit'], 30, 60),
      });
      res.status(200).json(resposta);
    }),

    publicDraw: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const draw = await getPublicDraw(deps, tenant.tenantId, pathParam(req, 'slug'));
      res.status(200).json(draw);
    }),

    publicDrawNumbers: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const numbers = await getDrawNumbers(deps, tenant.tenantId, pathParam(req, 'id'));
      // A grade muda a cada compra: o navegador pode guardar a resposta, mas precisa
      // REVALIDAR antes de usar. O Express poe o ETag e responde 304 a `If-None-Match`
      // igual — o polling de 3s custa uma consulta e nenhum corpo quando nada mudou.
      res.setHeader('Cache-Control', 'no-cache');
      res.status(200).json(numbers);
    }),

    createReservation: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const body = createReservationRequestSchema.parse(req.body);
      const reservation = await createReservation(deps, {
        tenantId: tenant.tenantId,
        drawId: pathParam(req, 'id'),
        numbers: body.numbers,
      });
      res.status(201).json(reservation);
    }),

    createOrder: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const body = createOrderRequestSchema.parse(req.body);
      const order = await createOrder(deps, {
        tenantId: tenant.tenantId,
        reservationId: body.reservationId,
        buyer: body.buyer,
        // Rota publica: a sessao e OPCIONAL. Quem esta logado leva o pedido
        // para a conta; quem nao esta compra do mesmo jeito.
        userId: req.session?.userId ?? null,
        messagingConsent: body.messagingConsent === true,
      });

      // O PIX e gerado logo apos o pedido, FORA da transacao dele. Se o provedor
      // estiver fora (ou nao configurado), o pedido existe e os numeros seguem
      // segurados: a resposta traz `payment: null` e a pessoa tenta de novo por
      // POST /api/public/orders/:id/payment — idempotente.
      try {
        const comPix = await ensurePixPayment(deps, {
          tenantId: tenant.tenantId,
          tenantSlug: tenant.slug,
          orderId: order.orderId,
        });
        res.status(201).json(comPix);
        return;
      } catch (falha) {
        if (!(falha instanceof ApiError) || falha.code !== 'PAYMENT_PROVIDER_UNAVAILABLE') throw falha;
      }
      res.status(201).json(order);
    }),

    publicOrder: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const order = await getOrder(deps, tenant.tenantId, pathParam(req, 'id'));
      res.status(200).json(order);
    }),

    /**
     * Confirmacao de pagamento SEM provedor.
     *
     * A recusa e a PRIMEIRA linha do handler, antes de ler parametro, tocar o
     * banco ou validar qualquer coisa. Uma rota que transforma um pedido em "pago" sem
     * cobrar ninguem nao pode depender de a verificacao estar em algum lugar
     * mais adiante do fluxo.
     *
     * A lista e de ambientes PERMITIDOS, nao de proibidos: um `NODE_ENV` novo
     * — `qa`, `preview`, `demo` — nasce recusado. Barrar apenas `production`
     * deixaria cada ambiente futuro aberto por omissao.
     */
    devConfirmPayment: asyncHandler(async (req, res) => {
      const AMBIENTES_PERMITIDOS = ['development', 'test'];
      if (!AMBIENTES_PERMITIDOS.includes(deps.config.NODE_ENV)) {
        throw ApiError.notFound('Recurso indisponível.');
      }

      const tenant = requireTenant(req);
      const order = await devConfirmPayment(deps, tenant.tenantId, pathParam(req, 'id'));
      log.warn('pagamento confirmado SEM provedor (rota de desenvolvimento)', {
        request_id: req.context?.requestId ?? null,
        tenant_id: tenant.tenantId,
        order_id: order.orderId,
        environment: deps.config.NODE_ENV,
      });
      res.status(200).json(order);
    }),

    // -----------------------------------------------------------------------
    // Organizador
    //
    // A permissao de cada rota vem do contrato compartilhado e e aplicada pelo
    // `authorizeRoute`. O que estes handlers fazem e usar o tenant JA validado
    // pelo middleware — nunca um identificador vindo do corpo da requisicao.
    // -----------------------------------------------------------------------
    organizerDraws: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      const resposta = await listOrganizerDraws(deps, tenant.tenantId, session.userId, {
        cursor: decodeCursor(req.query['cursor']),
        limit: parseLimit(req.query['limit'], 30, 100),
      });
      res.status(200).json(resposta);
    }),

    organizerDraw: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      const draw = await getOrganizerDraw(
        deps,
        tenant.tenantId,
        session.userId,
        pathParam(req, 'id'),
      );
      res.status(200).json(draw);
    }),

    createDraw: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      const body = createDrawRequestSchema.parse(req.body);
      const draw = await createDraw(deps, {
        tenantId: tenant.tenantId,
        userId: session.userId,
        data: body,
        origin: originOf(req),
      });
      res.status(201).json(draw);
    }),

    updateDraw: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      const body = updateDrawRequestSchema.parse(req.body);
      const draw = await updateDraw(deps, {
        tenantId: tenant.tenantId,
        userId: session.userId,
        drawId: pathParam(req, 'id'),
        data: body,
        origin: originOf(req),
      });
      res.status(200).json(draw);
    }),

    updateDrawStatus: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      const body = updateDrawStatusRequestSchema.parse(req.body);
      const draw = await updateDrawStatus(deps, {
        tenantId: tenant.tenantId,
        userId: session.userId,
        drawId: pathParam(req, 'id'),
        status: body.status,
        origin: originOf(req),
      });
      res.status(200).json(draw);
    }),

    // -----------------------------------------------------------------------
    // Super Admin · revisao de compliance (RN02)
    //
    // `platform:review:read` e `platform:review:decide` sao aplicadas pelo
    // `authorizeRoute`, a partir do contrato, junto com o MFA (RN12).
    // -----------------------------------------------------------------------
    platformReviewQueue: asyncHandler(async (req, res) => {
      const session = requireSession(req);
      res.status(200).json(
        await listReviewQueue(deps, session.userId, {
          cursor: decodeCursor(req.query['cursor']),
          limit: parseLimit(req.query['limit'], 30, 100),
        }),
      );
    }),

    platformReviewDecide: asyncHandler(async (req, res) => {
      const session = requireSession(req);
      const body = reviewDrawRequestSchema.parse(req.body);
      const draw = await reviewDraw(deps, {
        userId: session.userId,
        drawId: pathParam(req, 'id'),
        to: body.to,
        reason: body.reason,
        origin: originOf(req),
      });
      res.status(200).json(draw);
    }),
  };
}
