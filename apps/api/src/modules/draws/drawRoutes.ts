import type { Request, RequestHandler, Response } from 'express';
import {
  createDrawRequestSchema,
  createOrderRequestSchema,
  createReservationRequestSchema,
  updateDrawStatusRequestSchema,
} from '@campaigns/shared';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';
import {
  createDraw,
  createOrder,
  createReservation,
  devConfirmPayment,
  getDrawNumbers,
  getOrder,
  getOrganizerDraw,
  getPublicDraw,
  listOrganizerDraws,
  listPublicDraws,
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
      const draws = await listPublicDraws(deps, tenant.tenantId);
      res.status(200).json({ draws });
    }),

    publicDraw: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const draw = await getPublicDraw(deps, tenant.tenantId, pathParam(req, 'slug'));
      res.status(200).json(draw);
    }),

    publicDrawNumbers: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const numbers = await getDrawNumbers(deps, tenant.tenantId, pathParam(req, 'id'));
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
      });
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
      console.warn(
        `[dev] pagamento confirmado SEM provedor: pedido=${order.orderId} ` +
          `ambiente=${deps.config.NODE_ENV}`,
      );
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
      const draws = await listOrganizerDraws(deps, tenant.tenantId, session.userId);
      res.status(200).json({ draws });
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
      });
      res.status(201).json(draw);
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
      });
      res.status(200).json(draw);
    }),
  };
}
