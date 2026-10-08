import type { Request, RequestHandler, Response } from 'express';
import { withPlatform, withTenant, withoutContext } from '@clubedarifa/db';
import {
  MEDIA_MAX_BYTES,
  MEDIA_PATH_PREFIX,
  createCreatorCommunityRequestSchema,
  reviewReconciliationRequestSchema,
  updateCommunityRequestSchema,
  uploadMediaRequestSchema,
  type CommunityContent,
  type CreateCreatorCommunityResponse,
  type PublicDrawBuyersResponse,
  type TenantBuyer,
  type TenantBuyersResponse,
  type UploadMediaResponse,
} from '@clubedarifa/shared';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';
import { decodeCursor, paginate, parseLimit } from '../../lib/cursor.js';
import { recordAuditEvent } from '../audit/auditService.js';
import { isUniqueViolation } from '../../lib/pgError.js';

/** M01 · marca, contatos e paginas da comunidade. M02 · imagens. M07 · compradores (lista util). */

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function param(req: Request, name: string): string {
  const v = req.params[name];
  if (typeof v !== 'string' || v === '') throw ApiError.badRequest(`Parâmetro ausente: ${name}.`);
  return v;
}

/** Assinaturas (magic bytes): o tipo declarado precisa bater com o conteudo. */
function matchesSignature(contentType: string, data: Buffer): boolean {
  if (contentType === 'image/png') return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (contentType === 'image/jpeg') return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (contentType === 'image/webp') return data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

/** "Maria Souza Lima" -> "Maria L." — nunca o nome completo, nunca o contato. */
export function maskName(full: string): string {
  const partes = full.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return 'Participante';
  const primeiro = partes[0]!;
  if (partes.length === 1) return primeiro;
  return `${primeiro} ${partes[partes.length - 1]!.charAt(0).toUpperCase()}.`;
}

const vazioParaNulo = (v: string | undefined) => {
  const limpo = v?.trim();
  return limpo ? limpo : null;
};

interface BrandingRow {
  public_name: string | null;
  description: string | null;
  footer_text: string | null;
  logo_light_url: string | null;
  banner_url: string | null;
  colors: Record<string, string> | null;
  contact: Record<string, string> | null;
  pages: Record<string, string> | null;
}

const SELECT_BRANDING = `SELECT public_name, description, footer_text, logo_light_url, banner_url, colors, contact, pages
                           FROM tenant_branding WHERE tenant_id = $1`;

function toContent(row: BrandingRow | undefined): CommunityContent {
  return {
    publicName: row?.public_name ?? null,
    description: row?.description ?? null,
    footerText: row?.footer_text ?? null,
    logoUrl: row?.logo_light_url ?? null,
    bannerUrl: row?.banner_url ?? null,
    primaryColor: row?.colors?.['primary'] ?? null,
    contact: row?.contact ?? {},
    pages: row?.pages ?? {},
  };
}

export function buildCommunityHandlers(deps: AppDeps): Record<string, RequestHandler> {
  return {
    /**
     * Onboarding do criador. A conta e a MESMA do participante: criar a comunidade da ao usuario
     * o vinculo OWNER. Tudo (comunidade, vinculo, marca, auditoria, evento) acontece em UMA
     * transacao dentro de `app.create_own_community`; o usuario vem SEMPRE da sessao.
     */
    createMyCommunity: asyncHandler(async (req, res) => {
      const session = requireSession(req);
      const body = createCreatorCommunityRequestSchema.parse(req.body);
      const contact: Record<string, string> = {};
      for (const [k, v] of Object.entries(body.contact ?? {})) {
        if (typeof v === 'string' && v.trim() !== '') contact[k] = v.trim();
      }

      let row: { tenant_id: string; slug: string; name: string; status: string; created_at: string; created: boolean } | undefined;
      try {
        row = await withoutContext(deps.pool, async (client) => {
          const { rows } = await client.query<NonNullable<typeof row>>(
            'SELECT tenant_id, slug, name, status, created_at, created FROM app.create_own_community($1, $2, $3, $4::jsonb, $5)',
            [session.userId, body.slug, body.name, JSON.stringify(contact), deps.config.CREATOR_MAX_COMMUNITIES],
          );
          return rows[0];
        });
      } catch (error) {
        if (isUniqueViolation(error, 'tenants_slug_key')) {
          throw ApiError.conflict('Já existe uma comunidade com esse endereço. Escolha outro.');
        }
        if ((error as { code?: string }).code === 'P0001') {
          throw ApiError.conflict('Você já atingiu o limite de comunidades da sua conta.');
        }
        throw error;
      }
      if (!row) throw ApiError.badRequest('Não foi possível criar a comunidade.');

      const response: CreateCreatorCommunityResponse = {
        id: row.tenant_id,
        slug: row.slug,
        name: row.name,
        status: row.status,
        createdAt: new Date(row.created_at).toISOString(),
        created: row.created,
      };
      res.status(row.created ? 201 : 200).set('Cache-Control', 'no-store').json(response);
    }),

    tenantCommunity: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const row = await withTenant(deps.pool, { tenantId: tenant.tenantId }, async (client) => {
        const { rows } = await client.query<BrandingRow>(SELECT_BRANDING, [tenant.tenantId]);
        return rows[0];
      });
      res.status(200).set('Cache-Control', 'no-store').json(toContent(row));
    }),

    updateTenantCommunity: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      const body = updateCommunityRequestSchema.parse(req.body);

      const content = await withTenant(
        deps.pool,
        { tenantId: tenant.tenantId, userId: session.userId },
        async (client) => {
          const { rows: antes } = await client.query<BrandingRow>(SELECT_BRANDING, [tenant.tenantId]);
          const atual = toContent(antes[0]);

          // Campo ausente = mantem; texto vazio = apaga.
          const colors = { ...(antes[0]?.colors ?? {}) };
          if (body.primaryColor !== undefined) {
            if (body.primaryColor === '') delete colors['primary'];
            else colors['primary'] = body.primaryColor;
          }
          const contact: Record<string, string> = { ...atual.contact };
          for (const [k, v] of Object.entries(body.contact ?? {})) {
            const limpo = typeof v === 'string' ? v.trim() : '';
            if (limpo) contact[k] = limpo;
            else delete contact[k];
          }
          const pages: Record<string, string> = { ...atual.pages };
          for (const [k, v] of Object.entries(body.pages ?? {})) {
            const limpo = typeof v === 'string' ? v.trim() : '';
            if (limpo) pages[k] = limpo;
            else delete pages[k];
          }

          const publicName = body.publicName !== undefined ? vazioParaNulo(body.publicName) : atual.publicName;
          const description = body.description !== undefined ? vazioParaNulo(body.description) : atual.description;
          const footerText = body.footerText !== undefined ? vazioParaNulo(body.footerText) : atual.footerText;
          const logoUrl = body.logoUrl !== undefined ? vazioParaNulo(body.logoUrl) : atual.logoUrl;
          const bannerUrl = body.bannerUrl !== undefined ? vazioParaNulo(body.bannerUrl) : atual.bannerUrl;

          await client.query(
            `INSERT INTO tenant_branding
               (tenant_id, public_name, description, footer_text, logo_light_url, banner_url, colors, contact, pages)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb)
             ON CONFLICT (tenant_id) DO UPDATE SET
               public_name = EXCLUDED.public_name,
               description = EXCLUDED.description,
               footer_text = EXCLUDED.footer_text,
               logo_light_url = EXCLUDED.logo_light_url,
               banner_url = EXCLUDED.banner_url,
               colors = EXCLUDED.colors,
               contact = EXCLUDED.contact,
               pages = EXCLUDED.pages`,
            [
              tenant.tenantId,
              publicName,
              description,
              footerText,
              logoUrl,
              bannerUrl,
              JSON.stringify(colors),
              JSON.stringify(contact),
              JSON.stringify(pages),
            ],
          );

          await recordAuditEvent(client, {
            tenantId: tenant.tenantId,
            actorUserId: session.userId,
            action: 'tenant.community_updated',
            targetType: 'tenant',
            targetId: tenant.tenantId,
            // So os nomes dos campos: o texto das paginas nao vai para a trilha.
            after: {
              changed: Object.keys(body),
              pages: Object.keys(pages),
            },
            ip: req.ip ?? null,
            userAgent: req.get('user-agent') ?? null,
          });

          const { rows } = await client.query<BrandingRow>(SELECT_BRANDING, [tenant.tenantId]);
          return toContent(rows[0]);
        },
      );
      res.status(200).json(content);
    }),

    uploadMedia: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      const body = uploadMediaRequestSchema.parse(req.body);

      const data = Buffer.from(body.dataBase64, 'base64');
      if (data.length === 0 || data.length > MEDIA_MAX_BYTES) {
        throw ApiError.badRequest('A imagem precisa ter no máximo 2 MB.');
      }
      if (!matchesSignature(body.contentType, data)) {
        throw ApiError.badRequest('O arquivo não parece ser uma imagem do tipo informado.');
      }

      const id = await withTenant(
        deps.pool,
        { tenantId: tenant.tenantId, userId: session.userId },
        async (client) => {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO media_files (tenant_id, content_type, byte_size, data, created_by)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [tenant.tenantId, body.contentType, data.length, data, session.userId],
          );
          const novo = rows[0]!.id;
          await recordAuditEvent(client, {
            tenantId: tenant.tenantId,
            actorUserId: session.userId,
            action: 'media.uploaded',
            targetType: 'media',
            targetId: novo,
            after: { contentType: body.contentType, byteSize: data.length },
            ip: req.ip ?? null,
            userAgent: req.get('user-agent') ?? null,
          });
          return novo;
        },
      );

      const response: UploadMediaResponse = { id, url: `${MEDIA_PATH_PREFIX}${id}`, byteSize: data.length };
      res.status(201).json(response);
    }),

    publicMedia: asyncHandler(async (req, res) => {
      const id = param(req, 'id');
      if (!UUID_RE.test(id)) throw ApiError.notFound('Imagem não encontrada.');
      const { rows } = await deps.pool.query<{ content_type: string; data: Buffer }>(
        'SELECT content_type, data FROM app.public_media($1::uuid)',
        [id],
      );
      const media = rows[0];
      if (!media) throw ApiError.notFound('Imagem não encontrada.');
      res
        .status(200)
        .set({
          'Content-Type': media.content_type,
          // O conteudo de um id nunca muda (trocar a imagem gera outro id).
          'Cache-Control': 'public, max-age=31536000, immutable',
          // <img> de outra origem precisa poder carregar; o conteudo e publico.
          'Cross-Origin-Resource-Policy': 'cross-origin',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        })
        .send(media.data);
    }),

    publicDrawBuyers: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const slug = param(req, 'slug');
      const resposta = await withTenant(deps.pool, { tenantId: tenant.tenantId }, async (client) => {
        const { rows: sorteio } = await client.query<{ id: string; customization: { showBuyers?: boolean } | null }>(
          `SELECT id, customization FROM draws
            WHERE slug = $1 AND status::text IN ('ATIVA','PAUSADA','VENDAS ENCERRADAS','APURAÇÃO','RESULTADO PUBLICADO')`,
          [slug],
        );
        const d = sorteio[0];
        if (!d) throw ApiError.notFound('Sorteio não encontrado.');
        // Sem a autorizacao do organizador, a lista fica vazia (e nao revela que existe).
        if (d.customization?.showBuyers !== true) return { buyers: [] } satisfies PublicDrawBuyersResponse;

        const { rows } = await client.query<{ name: string; quantity: number; paid_at: string }>(
          `SELECT b.name, o.quantity, o.paid_at
             FROM orders o
             JOIN buyers b ON b.id = o.buyer_id
            WHERE o.draw_id = $1 AND o.status = 'PAGO' AND o.paid_at IS NOT NULL
            ORDER BY o.paid_at DESC
            LIMIT 20`,
          [d.id],
        );
        return {
          buyers: rows.map((r) => ({
            name: maskName(r.name),
            quantity: r.quantity,
            paidAt: new Date(r.paid_at).toISOString(),
          })),
        } satisfies PublicDrawBuyersResponse;
      });
      res.status(200).set('Cache-Control', 'no-cache').json(resposta);
    }),

    tenantBuyers: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      const limit = parseLimit(req.query['limit'], 30, 100);
      const cursor = decodeCursor(req.query['cursor']);
      const busca = typeof req.query['search'] === 'string' ? req.query['search'].trim().slice(0, 80) : '';
      const termo = busca ? `%${busca.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;

      const resposta = await withTenant(
        deps.pool,
        { tenantId: tenant.tenantId, userId: session.userId },
        async (client) => {
          const { rows } = await client.query<{
            buyer_id: string;
            name: string;
            phone: string | null;
            email: string | null;
            orders: number;
            paid_orders: number;
            numbers: number;
            total_paid_cents: string | number;
            last_order_at: string | null;
            cursor_t: string;
            draws: { title: string; slug: string }[] | null;
          }>(
            `SELECT b.id AS buyer_id, b.name, b.phone, b.email,
                    count(o.id)::int AS orders,
                    count(o.id) FILTER (WHERE o.status = 'PAGO')::int AS paid_orders,
                    COALESCE(sum(o.quantity) FILTER (WHERE o.status = 'PAGO'), 0)::int AS numbers,
                    COALESCE(sum(o.total_cents) FILTER (WHERE o.status = 'PAGO'), 0) AS total_paid_cents,
                    max(o.created_at) AS last_order_at,
                    max(o.created_at)::text AS cursor_t,
                    (SELECT jsonb_agg(jsonb_build_object('title', x.title, 'slug', x.slug))
                       FROM (SELECT DISTINCT d.title, d.slug FROM orders oo JOIN draws d ON d.id = oo.draw_id
                              WHERE oo.buyer_id = b.id LIMIT 10) x) AS draws
               FROM buyers b
               JOIN orders o ON o.buyer_id = b.id
              WHERE ($1::text IS NULL OR b.name ILIKE $1 OR b.phone ILIKE $1 OR b.email ILIKE $1)
              GROUP BY b.id
             HAVING ($2::timestamptz IS NULL OR (max(o.created_at), b.id) < ($2::timestamptz, $3::uuid))
              ORDER BY max(o.created_at) DESC, b.id DESC
              LIMIT $4`,
            [termo, cursor?.t ?? null, cursor?.id ?? null, limit + 1],
          );
          const { pagina, nextCursor } = paginate(rows, limit, (r) => ({ t: r.cursor_t, id: r.buyer_id }));
          const buyers: TenantBuyer[] = pagina.map((r) => ({
            buyerId: r.buyer_id,
            name: r.name,
            phone: r.phone,
            email: r.email,
            orders: r.orders,
            paidOrders: r.paid_orders,
            numbers: r.numbers,
            totalPaidCents: Number(r.total_paid_cents),
            lastOrderAt: r.last_order_at ? new Date(r.last_order_at).toISOString() : null,
            draws: r.draws ?? [],
          }));
          return { buyers, nextCursor } satisfies TenantBuyersResponse;
        },
      );
      res.status(200).set('Cache-Control', 'no-store').json(resposta);
    }),

    platformReviewReconciliation: asyncHandler(async (req, res) => {
      const session = requireSession(req);
      const id = param(req, 'id');
      if (!UUID_RE.test(id)) throw ApiError.notFound('Divergência não encontrada.');
      const body = reviewReconciliationRequestSchema.parse(req.body);

      const atualizado = await withPlatform(deps.pool, { userId: session.userId }, async (client) => {
        const { rows } = await client.query<{ ok: boolean }>(
          'SELECT app.platform_review_reconciliation($1::uuid, $2, $3, $4::uuid) AS ok',
          [id, body.status, body.note ?? null, session.userId],
        );
        const ok = rows[0]?.ok === true;
        if (ok) {
          await recordAuditEvent(client, {
            tenantId: null,
            actorUserId: session.userId,
            actorType: 'PLATFORM',
            action: 'reconciliation.reviewed',
            targetType: 'reconciliation_issue',
            targetId: id,
            after: { status: body.status, hasNote: Boolean(body.note?.trim()) },
            ip: req.ip ?? null,
            userAgent: req.get('user-agent') ?? null,
          });
        }
        return ok;
      });
      if (!atualizado) throw ApiError.notFound('Divergência não encontrada.');
      res.status(200).json({ updated: true });
    }),
  };
}
