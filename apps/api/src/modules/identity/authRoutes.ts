import type { Request, RequestHandler, Response } from 'express';
import { withUser } from '@campaigns/db';
import {
  loginRequestSchema,
  mfaCodeRequestSchema,
  registerRequestSchema,
  type AccountOrder,
  type AccountOrdersResponse,
  type LoginResponse,
  type MembershipRole,
  type MembershipSummary,
  type SessionResponse,
} from '@campaigns/shared';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';
import {
  confirmMfaEnrollment,
  login,
  registerParticipant,
  revokeAllSessions,
  revokeSession,
  startMfaEnrollment,
  verifyMfaForSession,
} from './authService.js';

/** M01 · rotas de identidade. */

function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/**
 * `sameSite` vem da configuracao, e nao fixo no codigo, porque a resposta certa
 * depende da TOPOLOGIA da instalacao: `lax` quando a vitrine e a API
 * compartilham o site, `none` quando estao em sites diferentes (Vercel +
 * Render), caso em que `lax` faria o navegador simplesmente nao enviar o
 * cookie. Quem barra escrita de origem desconhecida e o `originGuard`, que
 * recusa com 403 antes do handler e nao depende de `SameSite`. Ver o comentario
 * de `SESSION_COOKIE_SAMESITE` em config.ts.
 */
function setSessionCookie(deps: AppDeps, res: Response, token: string): void {
  res.cookie(deps.config.SESSION_COOKIE_NAME, token, {
    httpOnly: true, // JavaScript da pagina nao le o token.
    secure: deps.config.SESSION_COOKIE_SECURE,
    sameSite: deps.config.SESSION_COOKIE_SAMESITE,
    path: '/',
    maxAge: deps.config.SESSION_TTL_HOURS * 3600 * 1000,
  });
}

/**
 * Apagar o cookie exige os MESMOS atributos com que ele foi posto. Divergir em
 * `sameSite`, `secure` ou `path` faz o navegador tratar como outro cookie, e o
 * antigo sobrevive ao logout.
 */
function clearSessionCookie(deps: AppDeps, res: Response): void {
  res.clearCookie(deps.config.SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: deps.config.SESSION_COOKIE_SECURE,
    sameSite: deps.config.SESSION_COOKIE_SAMESITE,
    path: '/',
  });
}

function requireSession(req: Request) {
  const session = req.session;
  if (!session) throw ApiError.unauthenticated();
  return session;
}

/** Origem da requisicao, propagada ate a trilha de auditoria (RN11). */
function originOf(req: Request): { ip: string | null; userAgent: string | null } {
  return { ip: req.context?.ip ?? null, userAgent: req.context?.userAgent ?? null };
}

export function buildAuthHandlers(deps: AppDeps): Record<string, RequestHandler> {
  return {
    /**
     * Cadastro. Cria a conta e para por ai — a sessao e assunto do `login`,
     * que ja tem limitador, trilha e a decisao de RN12. A vitrine chama os
     * dois em sequencia; o servidor nao ganha um segundo caminho de
     * autenticacao para manter em dia.
     */
    register: asyncHandler(async (req, res) => {
      const body = registerRequestSchema.parse(req.body);
      const user = await registerParticipant(deps, {
        email: body.email,
        displayName: body.displayName,
        password: body.password,
        ip: req.context?.ip ?? null,
        userAgent: req.context?.userAgent ?? null,
      });
      res.status(201).json({ user });
    }),

    /**
     * Pedidos da conta, em todas as comunidades.
     *
     * A autoridade e `session.userId` — nunca um e-mail, telefone ou id vindo
     * da consulta. Nao ha parametro de identidade a falsificar porque nao ha
     * parametro de identidade: `app.account_orders` le o usuario do contexto
     * da transacao, que foi gravado a partir do token validado.
     */
    accountOrders: asyncHandler(async (req, res) => {
      const session = requireSession(req);

      const limite = Math.min(Math.max(Number(req.query['limit'] ?? 20) || 20, 1), 100);
      // Cursor opaco: "<iso>|<uuid>". Opaco porque a tela nao tem o que
      // decidir com ele — so devolver na proxima pagina.
      const cursor = typeof req.query['cursor'] === 'string' ? req.query['cursor'] : null;
      let antesDe: string | null = null;
      let antesId: string | null = null;
      if (cursor) {
        const [iso, id] = cursor.split('|');
        if (!iso || !id || Number.isNaN(Date.parse(iso))) {
          throw ApiError.badRequest('Cursor inválido.');
        }
        antesDe = iso;
        antesId = id;
      }

      const linhas = await withUser(deps.pool, { userId: session.userId }, async (client) => {
        const { rows } = await client.query(
          'SELECT * FROM app.account_orders($1, $2::timestamptz, $3::uuid)',
          [limite + 1, antesDe, antesId],
        );
        return rows as Array<Record<string, unknown>>;
      });

      // Pedimos um a mais do que cabe: se ele veio, ha proxima pagina. Evita
      // uma segunda consulta so para responder "acabou?".
      const temMais = linhas.length > limite;
      const pagina = temMais ? linhas.slice(0, limite) : linhas;

      const orders: AccountOrder[] = pagina.map((r) => ({
        orderId: r['order_id'] as string,
        status: r['status'] as AccountOrder['status'],
        quantity: r['quantity'] as number,
        unitPriceCents: r['unit_price_cents'] as number,
        totalCents: r['total_cents'] as number,
        createdAt: new Date(r['created_at'] as string).toISOString(),
        paidAt: r['paid_at'] ? new Date(r['paid_at'] as string).toISOString() : null,
        numbers: (r['numbers'] as number[] | null) ?? [],
        labelDigits: (r['label_digits'] as number) === 3 ? 3 : 2,
        drawSlug: r['draw_slug'] as string,
        drawTitle: r['draw_title'] as string,
        tenantSlug: r['tenant_slug'] as string,
        tenantName: r['tenant_name'] as string,
      }));

      const ultimo = orders[orders.length - 1];
      const response: AccountOrdersResponse = {
        orders,
        nextCursor: temMais && ultimo ? `${ultimo.createdAt}|${ultimo.orderId}` : null,
      };
      res.status(200).json(response);
    }),

    login: asyncHandler(async (req, res) => {
      const body = loginRequestSchema.parse(req.body);
      const outcome = await login(deps, {
        email: body.email,
        password: body.password,
        ip: req.context?.ip ?? null,
        userAgent: req.context?.userAgent ?? null,
      });

      setSessionCookie(deps, res, outcome.token);

      const response: LoginResponse = {
        status: outcome.status,
        user: {
          id: outcome.user.id,
          email: outcome.user.email,
          displayName: outcome.user.displayName,
        },
      };
      // O token vai SOMENTE no cookie httpOnly; nunca no corpo da resposta.
      res.status(200).json(response);
    }),

    logout: asyncHandler(async (req, res) => {
      const session = requireSession(req);
      await revokeSession(deps, {
        userId: session.userId,
        sessionId: session.sessionId,
        reason: 'logout',
        origin: originOf(req),
      });
      clearSessionCookie(deps, res);
      res.status(204).end();
    }),

    logoutAll: asyncHandler(async (req, res) => {
      const session = requireSession(req);
      const revoked = await revokeAllSessions(deps, {
        userId: session.userId,
        reason: 'logout_all',
        origin: originOf(req),
      });
      clearSessionCookie(deps, res);
      res.status(200).json({ revoked });
    }),

    session: asyncHandler(async (req, res) => {
      const session = requireSession(req);

      const memberships = await withUser(deps.pool, { userId: session.userId }, async (client) => {
        const { rows } = await client.query<{
          tenant_id: string;
          tenant_slug: string;
          tenant_name: string;
          role: MembershipRole;
        }>('SELECT tenant_id, tenant_slug, tenant_name, role FROM app.my_memberships()');
        return rows;
      });

      // Uma pessoa pode ter varios papeis na mesma comunidade; a resposta
      // agrupa por comunidade.
      const byTenant = new Map<string, MembershipSummary>();
      for (const row of memberships) {
        const current = byTenant.get(row.tenant_id);
        if (current) {
          byTenant.set(row.tenant_id, {
            ...current,
            roles: [...current.roles, row.role],
          });
        } else {
          byTenant.set(row.tenant_id, {
            tenantId: row.tenant_id,
            tenantSlug: row.tenant_slug,
            tenantName: row.tenant_name,
            roles: [row.role],
          });
        }
      }

      const response: SessionResponse = {
        user: {
          id: session.userId,
          email: session.email,
          displayName: session.displayName,
        },
        mfaSatisfied: session.mfaSatisfied,
        mfaRequired: session.mfaRequired,
        mfaEnrolled: session.mfaEnrolled,
        platformRoles: [...session.platformRoles],
        platformPermissions: [...session.platformPermissions],
        memberships: [...byTenant.values()],
      };
      res.status(200).json(response);
    }),

    mfaEnrollStart: asyncHandler(async (req, res) => {
      const session = requireSession(req);
      const enrollment = await startMfaEnrollment(deps, {
        userId: session.userId,
        email: session.email,
        origin: originOf(req),
      });
      // O segredo aparece UMA vez, na tela de cadastro. Nao volta a ser lido.
      res.status(200).json(enrollment);
    }),

    /**
     * Confirmar o cadastro ELEVA a sessao. Por isso a resposta traz um cookie
     * novo: o token entregue antes da elevacao deixa de valer no mesmo
     * instante. Ver `rotateSessionToken` em authService.ts.
     */
    mfaEnrollConfirm: asyncHandler(async (req, res) => {
      const session = requireSession(req);
      const body = mfaCodeRequestSchema.parse(req.body);
      const elevated = await confirmMfaEnrollment(deps, {
        userId: session.userId,
        sessionId: session.sessionId,
        code: body.code,
        origin: originOf(req),
      });
      setSessionCookie(deps, res, elevated.token);
      res.status(200).json({ status: 'authenticated' });
    }),

    mfaVerify: asyncHandler(async (req, res) => {
      const session = requireSession(req);
      const body = mfaCodeRequestSchema.parse(req.body);
      const elevated = await verifyMfaForSession(deps, {
        userId: session.userId,
        sessionId: session.sessionId,
        code: body.code,
        origin: originOf(req),
      });
      setSessionCookie(deps, res, elevated.token);
      res.status(200).json({ status: 'authenticated' });
    }),
  };
}
