import type { Request, RequestHandler, Response } from 'express';
import { withPlatform } from '@clubedarifa/db';
import type {
  PlatformCreatorListResponse,
  PlatformMetrics,
  PlatformUserListResponse,
} from '@clubedarifa/shared';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';
import { decodeCursor, paginate, parseLimit } from '../../lib/cursor.js';

/**
 * Super Admin · usuarios, criadores e metricas.
 *
 * Tudo roda em `withPlatform` (RLS libera a leitura para quem tem acesso de plataforma), sem
 * funcao SECURITY DEFINER nova e sem migration. As colunas escolhidas deixam de fora tudo que
 * e segredo: `user_credentials`, `user_mfa_factors`, `sessions` e `tenant_payment_accounts`
 * (so o ESTADO da conta aparece, nunca token ou chave).
 *
 * Os numeros vem de consultas reais. Nao ha visita, conversao ou trafego porque nao existe
 * analytics que os produza.
 */

const PUBLIC_DRAW_STATUSES = ['ATIVA', 'PAUSADA', 'VENDAS ENCERRADAS', 'APURAÇÃO', 'RESULTADO PUBLICADO'];
const USER_STATUSES = ['ACTIVE', 'DISABLED'];

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

function requireSession(req: Request) {
  const session = req.session;
  if (!session) throw ApiError.unauthenticated();
  return session;
}

const escapeLike = (valor: string) => valor.replace(/[\\%_]/g, (c) => `\\${c}`);

/** `?q=`: texto curto; vazio vira "sem filtro". */
function parseSearch(raw: unknown): string | null {
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 100) throw ApiError.badRequest('Busca inválida.');
  const texto = raw.trim();
  return texto === '' ? null : `%${escapeLike(texto)}%`;
}

export function buildPlatformAdminHandlers(deps: AppDeps): Record<string, RequestHandler> {
  return {
    platformUsers: asyncHandler(async (req, res) => {
      const session = requireSession(req);
      const limit = parseLimit(req.query['limit'], 30, 100);
      const cursor = decodeCursor(req.query['cursor']);
      const busca = parseSearch(req.query['q']);
      const statusRaw = req.query['status'];
      if (statusRaw !== undefined && (typeof statusRaw !== 'string' || !USER_STATUSES.includes(statusRaw))) {
        throw ApiError.badRequest('Situação inválida.');
      }
      const status = typeof statusRaw === 'string' ? statusRaw : null;

      const linhas = await withPlatform(deps.pool, { userId: session.userId }, async (client) => {
        const { rows } = await client.query<{
          id: string;
          display_name: string;
          email: string;
          status: string;
          created_at: string;
          cursor_t: string;
          memberships_count: number;
          orders_count: number;
          platform_roles: string[];
        }>(
          `SELECT u.id, u.display_name, u.email, u.status::text AS status, u.created_at,
                  u.created_at::text AS cursor_t,
                  (SELECT count(*) FROM memberships m
                    WHERE m.user_id = u.id AND m.revoked_at IS NULL)::int AS memberships_count,
                  (SELECT count(*) FROM orders o WHERE o.user_id = u.id)::int AS orders_count,
                  COALESCE((SELECT array_agg(pa.role::text ORDER BY pa.role::text)
                              FROM platform_admins pa
                             WHERE pa.user_id = u.id AND pa.revoked_at IS NULL), '{}') AS platform_roles
             FROM users u
            WHERE ($1::text IS NULL
                   OR u.email ILIKE $1 ESCAPE '\\'
                   OR u.display_name ILIKE $1 ESCAPE '\\')
              AND ($2::text IS NULL OR u.status::text = $2)
              AND ($3::timestamptz IS NULL OR (u.created_at, u.id) < ($3::timestamptz, $4::uuid))
            ORDER BY u.created_at DESC, u.id DESC
            LIMIT $5`,
          [busca, status, cursor?.t ?? null, cursor?.id ?? null, limit + 1],
        );
        return rows;
      });
      const { pagina, nextCursor } = paginate(linhas, limit, (u) => ({ t: u.cursor_t, id: u.id }));

      const response: PlatformUserListResponse = {
        nextCursor,
        users: pagina.map((u) => ({
          id: u.id,
          displayName: u.display_name,
          email: u.email,
          status: u.status,
          createdAt: u.created_at,
          membershipsCount: u.memberships_count,
          ordersCount: u.orders_count,
          platformRoles: u.platform_roles,
        })),
      };
      res.status(200).json(response);
    }),

    platformCreators: asyncHandler(async (req, res) => {
      const session = requireSession(req);
      const limit = parseLimit(req.query['limit'], 30, 100);
      const cursor = decodeCursor(req.query['cursor']);
      const busca = parseSearch(req.query['q']);

      const linhas = await withPlatform(deps.pool, { userId: session.userId }, async (client) => {
        const { rows } = await client.query<{
          id: string;
          slug: string;
          name: string;
          status: string;
          created_at: string;
          cursor_t: string;
          owners: { userId: string; displayName: string; email: string }[];
          plan_name: string | null;
          subscription_status: string | null;
          payment_account_status: string | null;
          public_draws: number;
          active_draws: number;
        }>(
          `SELECT t.id, t.slug, t.name, t.status::text AS status, t.created_at,
                  t.created_at::text AS cursor_t,
                  COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                     'userId', u.id, 'displayName', u.display_name, 'email', u.email)
                                   ORDER BY m.created_at)
                              FROM memberships m JOIN users u ON u.id = m.user_id
                             WHERE m.tenant_id = t.id AND m.role = 'OWNER' AND m.revoked_at IS NULL),
                           '[]'::jsonb) AS owners,
                  sub.plan_name,
                  sub.status AS subscription_status,
                  (SELECT a.status::text FROM tenant_payment_accounts a
                    WHERE a.tenant_id = t.id
                    ORDER BY (a.status = 'CONNECTED') DESC, a.connected_at DESC
                    LIMIT 1) AS payment_account_status,
                  (SELECT count(*) FROM draws d
                    WHERE d.tenant_id = t.id AND d.status::text = ANY($5::text[]))::int AS public_draws,
                  (SELECT count(*) FROM draws d
                    WHERE d.tenant_id = t.id AND d.status::text = 'ATIVA')::int AS active_draws
             FROM tenants t
             LEFT JOIN LATERAL (
               SELECT p.name AS plan_name, s.status::text AS status
                 FROM tenant_subscriptions s JOIN plans p ON p.id = s.plan_id
                WHERE s.tenant_id = t.id
                ORDER BY (s.status IN ('trialing','active','past_due','unpaid','paused')) DESC, s.created_at DESC
                LIMIT 1
             ) sub ON true
            WHERE ($1::text IS NULL OR t.name ILIKE $1 ESCAPE '\\' OR t.slug ILIKE $1 ESCAPE '\\')
              AND ($2::timestamptz IS NULL OR (t.created_at, t.id) < ($2::timestamptz, $3::uuid))
              AND EXISTS (SELECT 1 FROM memberships m
                           WHERE m.tenant_id = t.id AND m.role = 'OWNER' AND m.revoked_at IS NULL)
            ORDER BY t.created_at DESC, t.id DESC
            LIMIT $4`,
          [busca, cursor?.t ?? null, cursor?.id ?? null, limit + 1, PUBLIC_DRAW_STATUSES],
        );
        return rows;
      });
      const { pagina, nextCursor } = paginate(linhas, limit, (t) => ({ t: t.cursor_t, id: t.id }));

      const response: PlatformCreatorListResponse = {
        nextCursor,
        creators: pagina.map((t) => ({
          tenantId: t.id,
          slug: t.slug,
          name: t.name,
          status: t.status,
          createdAt: t.created_at,
          owners: t.owners,
          planName: t.plan_name,
          subscriptionStatus: t.subscription_status,
          paymentAccountStatus: t.payment_account_status,
          publicDraws: t.public_draws,
          activeDraws: t.active_draws,
        })),
      };
      res.status(200).json(response);
    }),

    platformMetrics: asyncHandler(async (req, res) => {
      const session = requireSession(req);
      // Valor financeiro bruto so para quem tem a permissao financeira (menor privilegio).
      const vePagamentos = session.platformPermissions.has('platform:billing:read');

      const dados = await withPlatform(deps.pool, { userId: session.userId }, async (client) => {
        const contagens = await client.query<{
          users_total: number;
          users_active: number;
          tenants_total: number;
          tenants_active: number;
          creators_published: number;
          orders_paid: number;
          gross_paid_cents: string;
        }>(
          `SELECT (SELECT count(*) FROM users)::int AS users_total,
                  (SELECT count(*) FROM users WHERE status::text = 'ACTIVE')::int AS users_active,
                  (SELECT count(*) FROM tenants)::int AS tenants_total,
                  (SELECT count(*) FROM tenants WHERE status::text = 'ACTIVE')::int AS tenants_active,
                  (SELECT count(DISTINCT d.tenant_id) FROM draws d
                     JOIN tenants t ON t.id = d.tenant_id AND t.status::text = 'ACTIVE'
                    WHERE d.status::text = ANY($1::text[]))::int AS creators_published,
                  (SELECT count(*) FROM orders WHERE status::text = 'PAGO')::int AS orders_paid,
                  (SELECT COALESCE(sum(total_cents), 0) FROM orders WHERE status::text = 'PAGO')::text AS gross_paid_cents`,
          [PUBLIC_DRAW_STATUSES],
        );
        const rifas = await client.query<{ status: string; total: number }>(
          `SELECT status::text AS status, count(*)::int AS total FROM draws GROUP BY status`,
        );
        const assinaturas = await client.query<{ status: string; total: number }>(
          `SELECT status::text AS status, count(*)::int AS total FROM tenant_subscriptions GROUP BY status`,
        );
        return { c: contagens.rows[0]!, rifas: rifas.rows, assinaturas: assinaturas.rows };
      });

      const response: PlatformMetrics = {
        generatedAt: new Date().toISOString(),
        users: { total: dados.c.users_total, active: dados.c.users_active },
        communities: { total: dados.c.tenants_total, active: dados.c.tenants_active },
        creatorsWithPublishedDraw: dados.c.creators_published,
        drawsByStatus: Object.fromEntries(dados.rifas.map((r) => [r.status, r.total])),
        subscriptionsByStatus: Object.fromEntries(dados.assinaturas.map((r) => [r.status, r.total])),
        orders: {
          paid: dados.c.orders_paid,
          grossPaidCents: vePagamentos ? Number(dados.c.gross_paid_cents) : null,
        },
      };
      res.status(200).json(response);
    }),
  };
}
