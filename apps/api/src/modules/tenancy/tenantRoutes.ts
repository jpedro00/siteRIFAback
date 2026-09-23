import type { Request, RequestHandler, Response } from 'express';
import { withPlatform, withTenant } from '@campaigns/db';
import {
  createTenantRequestSchema,
  type AuditListResponse,
  type PublicTenantBranding,
  type TenantContextResponse,
  type TenantListResponse,
} from '@campaigns/shared';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';
import { isUniqueViolation } from '../../lib/pgError.js';
import { listTenantAuditEvents, recordAuditEvent } from '../audit/auditService.js';
import { enqueueOutboxEvent } from '../outbox/outboxService.js';

/** M01 · comunidade e contexto. M11 · criacao da comunidade pelo Super Admin. */

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

export function buildTenantHandlers(deps: AppDeps): Record<string, RequestHandler> {
  return {
    /**
     * Marca publica da comunidade resolvida.
     * Sem sessao. Devolve APENAS projecao de marca — nenhum dado de negocio,
     * nenhum dado pessoal.
     */
    publicTenantBranding: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);

      const branding = await withTenant(
        deps.pool,
        { tenantId: tenant.tenantId },
        async (client) => {
          const { rows } = await client.query<{
            public_name: string | null;
            logo_light_url: string | null;
            logo_dark_url: string | null;
            favicon_url: string | null;
            colors: Record<string, string>;
            fonts: Record<string, string>;
            contact: Record<string, string>;
          }>(
            `SELECT public_name, logo_light_url, logo_dark_url, favicon_url, colors, fonts, contact
               FROM tenant_branding
              WHERE tenant_id = $1`,
            [tenant.tenantId],
          );
          return rows[0] ?? null;
        },
      );

      const response: PublicTenantBranding = {
        tenantId: tenant.tenantId,
        slug: tenant.slug,
        name: tenant.name,
        publicName: branding?.public_name ?? null,
        logoLightUrl: branding?.logo_light_url ?? null,
        logoDarkUrl: branding?.logo_dark_url ?? null,
        faviconUrl: branding?.favicon_url ?? null,
        colors: branding?.colors ?? {},
        fonts: branding?.fonts ?? {},
        contact: branding?.contact ?? {},
      };
      res.status(200).json(response);
    }),

    /**
     * Contexto da comunidade para o painel.
     * Os papeis e as permissoes vem do vinculo JA verificado no banco pelo
     * middleware de comunidade, nao de nada enviado pelo cliente.
     */
    tenantContext: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const response: TenantContextResponse = {
        tenantId: tenant.tenantId,
        slug: tenant.slug,
        name: tenant.name,
        roles: [...tenant.roles],
        permissions: [...tenant.permissions],
      };
      res.status(200).json(response);
    }),

    tenantAudit: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      const limit = Number(req.query['limit'] ?? 50);

      const events = await withTenant(
        deps.pool,
        { tenantId: tenant.tenantId, userId: session.userId },
        async (client) => listTenantAuditEvents(client, { limit: Number.isFinite(limit) ? limit : 50 }),
      );

      const response: AuditListResponse = {
        events: events.map((event) => ({
          id: event.id,
          occurredAt: event.occurred_at,
          action: event.action,
          actorUserId: event.actor_user_id,
          targetType: event.target_type,
          targetId: event.target_id,
          ip: event.ip,
        })),
      };
      res.status(200).json(response);
    }),

    platformTenants: asyncHandler(async (req, res) => {
      const session = requireSession(req);

      const tenants = await withPlatform(deps.pool, { userId: session.userId }, async (client) => {
        const { rows } = await client.query<{
          id: string;
          slug: string;
          name: string;
          status: string;
          created_at: string;
        }>('SELECT id, slug, name, status::text AS status, created_at FROM tenants ORDER BY created_at DESC LIMIT 200');
        return rows;
      });

      const response: TenantListResponse = {
        tenants: tenants.map((tenant) => ({
          id: tenant.id,
          slug: tenant.slug,
          name: tenant.name,
          status: tenant.status,
          createdAt: tenant.created_at,
        })),
      };
      res.status(200).json(response);
    }),

    /**
     * Cria a comunidade. DOC-01 secao 2, passo 1.
     *
     * Mudanca, trilha e evento saem na MESMA transacao (RN11 e RN21). Se
     * qualquer um falhar, nada fica: nao existe comunidade sem trilha, nem
     * evento anunciando comunidade que nao foi criada.
     *
     * A marca padrao NAO e criada aqui: e o consumidor do evento
     * `tenant.created` que a provisiona, e e ele que da o fluxo real de
     * outbox -> fila -> efeito idempotente desta fase.
     */
    platformCreateTenant: asyncHandler(async (req, res) => {
      const session = requireSession(req);
      const body = createTenantRequestSchema.parse(req.body);

      const created = await withPlatform(deps.pool, { userId: session.userId }, async (client) => {
        const existing = await client.query('SELECT 1 FROM tenants WHERE slug = $1', [body.slug]);
        if ((existing.rowCount ?? 0) > 0) {
          throw ApiError.conflict('Já existe uma comunidade com esse identificador.');
        }

        // A verificacao acima resolve o caso comum, mas nao GARANTE nada: entre
        // ela e o INSERT cabe outra transacao. Quem garante e o indice unico
        // `tenants_slug_key`, e a corrida perdida e um conflito de negocio —
        // 409 —, nao uma falha interna.
        let tenant: {
          id: string;
          slug: string;
          name: string;
          status: string;
          created_at: string;
        };
        try {
          const { rows } = await client.query<typeof tenant>(
            `INSERT INTO tenants (slug, name)
             VALUES ($1, $2)
             RETURNING id, slug, name, status::text AS status, created_at`,
            [body.slug, body.name],
          );
          tenant = rows[0]!;
        } catch (error) {
          if (isUniqueViolation(error, 'tenants_slug_key')) {
            throw ApiError.conflict('Já existe uma comunidade com esse identificador.');
          }
          throw error;
        }

        await recordAuditEvent(client, {
          tenantId: null,
          actorUserId: session.userId,
          actorType: 'PLATFORM',
          action: 'tenant.created',
          targetType: 'tenant',
          targetId: tenant.id,
          after: { slug: tenant.slug, name: tenant.name },
          ip: req.context?.ip ?? null,
          userAgent: req.context?.userAgent ?? null,
        });

        await enqueueOutboxEvent(client, {
          tenantId: null,
          eventType: 'tenant.created',
          payload: {
            tenantId: tenant.id,
            slug: tenant.slug,
            name: tenant.name,
            createdByUserId: session.userId,
          },
        });

        return tenant;
      });

      res.status(201).json({
        id: created.id,
        slug: created.slug,
        name: created.name,
        status: created.status,
        createdAt: created.created_at,
      });
    }),
  };
}
