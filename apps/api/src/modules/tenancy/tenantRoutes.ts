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

        /**
         * DONO, NA MESMA TRANSACAO.
         *
         * Uma comunidade sem dono e uma comunidade que ninguem opera: o Super
         * Admin cria e nao administra, e nao ha a quem entregar. Antes desta
         * fase ela nascia assim, e o vinculo era um passo manual que alguem
         * precisava lembrar de dar.
         *
         * O `withPlatform` ja abriu UMA transacao — os dois INSERTs e a
         * auditoria vivem dentro dela. Se o e-mail nao corresponder a conta
         * nenhuma, o `throw` abaixo derruba tudo: nao sobra comunidade orfa
         * esperando dono.
         *
         * A busca passa por `app.find_user_by_email` porque `users_select` so
         * mostra ao Super Admin quem ele ja administra — e este, por
         * definicao, ainda nao administra ninguem nesta comunidade.
         */
        const { rows: donos } = await client.query<{
          user_id: string;
          email: string;
          display_name: string;
          status: string;
        }>(
          'SELECT user_id, email, display_name, status::text AS status FROM app.find_user_by_email($1)',
          [body.ownerEmail],
        );
        const dono = donos[0];
        if (!dono) {
          throw ApiError.badRequest(
            'Não existe conta com esse e-mail. O dono precisa ter cadastro antes de a comunidade ser criada.',
          );
        }
        if (dono.status !== 'ACTIVE') {
          throw ApiError.badRequest('A conta indicada como dona não está ativa.');
        }

        await client.query(
          `INSERT INTO memberships (tenant_id, user_id, role, accepted_at, created_by)
           VALUES ($1, $2, 'OWNER', now(), $3)`,
          [tenant.id, dono.user_id, session.userId],
        );

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

        // Evento proprio: "comunidade criada" e "fulano virou dono" respondem
        // perguntas diferentes na trilha, e quem audita concessao de poder nao
        // deveria ter de inferi-la de um evento de criacao.
        //
        // `tenantId: null` — escopo de PLATAFORMA, e nao da comunidade nova.
        // `audit_events_insert` exige exatamente isso de um ator de
        // plataforma, porque nesse contexto `app.current_tenant_id()` e nulo:
        // o Super Admin nao "esta dentro" da comunidade que acabou de criar.
        // A comunidade nao se perde — vai em `after`, junto do papel concedido.
        await recordAuditEvent(client, {
          tenantId: null,
          actorUserId: session.userId,
          actorType: 'PLATFORM',
          action: 'membership.owner_provisioned',
          targetType: 'user',
          targetId: dono.user_id,
          after: { role: 'OWNER', email: dono.email, tenantId: tenant.id, tenantSlug: tenant.slug },
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

        return { tenant, dono };
      });

      res.status(201).json({
        id: created.tenant.id,
        slug: created.tenant.slug,
        name: created.tenant.name,
        status: created.tenant.status,
        createdAt: created.tenant.created_at,
        owner: {
          userId: created.dono.user_id,
          email: created.dono.email,
          displayName: created.dono.display_name,
        },
      });
    }),
  };
}
