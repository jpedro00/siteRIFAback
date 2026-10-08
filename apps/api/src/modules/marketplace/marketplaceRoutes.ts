import type { Request, RequestHandler, Response } from 'express';
import { withTenant, withoutContext } from '@clubedarifa/db';
import type {
  MarketplaceCreatorListResponse,
  MarketplaceCreatorProfile,
  MarketplaceDraw,
  MarketplaceDrawListResponse,
} from '@clubedarifa/shared';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';
import { getPublicDrawSummariesByIds } from '../draws/drawService.js';

/**
 * Marketplace universal: leitura PUBLICA entre comunidades.
 *
 * Nao le tabela de negocio fora do contexto de uma comunidade. A escolha de QUAIS rifas entram
 * na pagina vem de `app.marketplace_page` (SECURITY DEFINER, projecao minima: so ids e ordem);
 * o resumo de cada rifa e montado depois, DENTRO do contexto da propria comunidade (RLS), pelo
 * mesmo codigo da vitrine por comunidade. Nenhum dado de comprador, pedido ou pagamento passa
 * por aqui.
 */

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
/** Instante em texto do PostgreSQL ("2026-09-29 16:30:00.123456+00"), que ele mesmo le de volta. */
const INSTANTE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,6})?(?:[+-][0-9]{2}(?::[0-9]{2})?|Z)$/;

/** Cursor da pagina: "<faixa>|<created_at>|<uuid>" em base64url. */
function encodePageCursor(band: number, t: string, id: string): string {
  return Buffer.from(`${band}|${t}|${id}`, 'utf8').toString('base64url');
}
function decodePageCursor(raw: unknown): { band: number; t: string; id: string } | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 200) throw ApiError.badRequest('Cursor inválido.');
  const [b, t, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  const band = Number(b);
  if (!Number.isInteger(band) || band < 0 || band > 1 || !t || !INSTANTE_RE.test(t) || !id || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw ApiError.badRequest('Cursor inválido.');
  }
  return { band, t, id };
}

/** Texto de busca saneado: tamanho limitado e curingas do LIKE escapados (busca literal). */
function parseSearch(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const limpo = raw.trim().slice(0, 80);
  if (limpo === '') return null;
  return limpo.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function parseLimit(raw: unknown, padrao = 24, max = 48): number {
  const n = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(n)) return padrao;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

interface PageRow {
  tenant_id: string;
  tenant_slug: string;
  tenant_name: string;
  logo_url: string | null;
  draw_id: string;
  band: number;
  cursor_t: string;
}

/** Uma pagina do marketplace: escolhe as rifas (funcao) e monta os resumos por comunidade (RLS). */
async function drawsPage(
  deps: AppDeps,
  input: { search: string | null; tenantSlug: string | null; cursor: ReturnType<typeof decodePageCursor>; limit: number },
): Promise<MarketplaceDrawListResponse> {
  const rows = await withoutContext(deps.pool, async (client) => {
    const r = await client.query<PageRow>(
      'SELECT * FROM app.marketplace_page($1, $2, $3, $4, $5, $6)',
      [input.search, input.tenantSlug, input.cursor?.band ?? null, input.cursor?.t ?? null, input.cursor?.id ?? null, input.limit + 1],
    );
    return r.rows;
  });

  const temMais = rows.length > input.limit;
  const pagina = temMais ? rows.slice(0, input.limit) : rows;

  // Agrupa por comunidade: um contexto (RLS) por comunidade, nunca uma consulta global.
  const porComunidade = new Map<string, string[]>();
  for (const row of pagina) {
    const ids = porComunidade.get(row.tenant_id) ?? [];
    ids.push(row.draw_id);
    porComunidade.set(row.tenant_id, ids);
  }
  const resumos = new Map<string, Awaited<ReturnType<typeof getPublicDrawSummariesByIds>>>();
  for (const [tenantId, ids] of porComunidade) {
    resumos.set(tenantId, await getPublicDrawSummariesByIds(deps, tenantId, ids));
  }

  const draws: MarketplaceDraw[] = [];
  for (const row of pagina) {
    const resumo = resumos.get(row.tenant_id)?.get(row.draw_id);
    if (!resumo) continue; // mudou de estado entre as duas leituras: nao entra na pagina
    draws.push({ ...resumo, tenantSlug: row.tenant_slug, tenantName: row.tenant_name, tenantLogoUrl: row.logo_url });
  }

  const ultima = pagina[pagina.length - 1];
  return {
    draws,
    nextCursor: temMais && ultima ? encodePageCursor(ultima.band, ultima.cursor_t, ultima.draw_id) : null,
  };
}

export function buildMarketplaceHandlers(deps: AppDeps): Record<string, RequestHandler> {
  return {
    marketplaceDraws: asyncHandler(async (req, res) => {
      const resposta = await drawsPage(deps, {
        search: parseSearch(req.query['search']),
        tenantSlug: null,
        cursor: decodePageCursor(req.query['cursor']),
        limit: parseLimit(req.query['limit']),
      });
      res.status(200).set('Cache-Control', 'no-cache').json(resposta);
    }),

    marketplaceCreators: asyncHandler(async (req, res) => {
      const limit = parseLimit(req.query['limit']);
      const cursorRaw = req.query['cursor'];
      let afterName: string | null = null;
      let afterSlug: string | null = null;
      if (typeof cursorRaw === 'string' && cursorRaw !== '') {
        const [n, s] = Buffer.from(cursorRaw.slice(0, 300), 'base64url').toString('utf8').split('|');
        if (!n || !s || !SLUG_RE.test(s)) throw ApiError.badRequest('Cursor inválido.');
        afterName = n;
        afterSlug = s;
      }
      const rows = await withoutContext(deps.pool, async (client) => {
        const r = await client.query<{
          tenant_slug: string;
          display_name: string;
          logo_url: string | null;
          description: string | null;
          public_draws: number;
          active_draws: number;
        }>('SELECT * FROM app.marketplace_creators($1, $2, $3, $4)', [parseSearch(req.query['search']), afterName, afterSlug, limit + 1]);
        return r.rows;
      });
      const temMais = rows.length > limit;
      const pagina = temMais ? rows.slice(0, limit) : rows;
      const ultimo = pagina[pagina.length - 1];
      const resposta: MarketplaceCreatorListResponse = {
        creators: pagina.map((r) => ({
          slug: r.tenant_slug,
          name: r.display_name,
          logoUrl: r.logo_url,
          description: r.description,
          publicDraws: r.public_draws,
          activeDraws: r.active_draws,
        })),
        nextCursor: temMais && ultimo ? Buffer.from(`${ultimo.display_name}|${ultimo.tenant_slug}`, 'utf8').toString('base64url') : null,
      };
      res.status(200).set('Cache-Control', 'no-cache').json(resposta);
    }),

    marketplaceCreator: asyncHandler(async (req, res) => {
      const slug = String(req.params['tenantSlug'] ?? '').trim().toLowerCase();
      if (!SLUG_RE.test(slug) || slug.length > 63) throw ApiError.notFound('Criador não encontrado.');

      const tenant = await withoutContext(deps.pool, async (client) => {
        const r = await client.query<{ tenant_id: string; slug: string; name: string; status: string }>(
          'SELECT tenant_id, slug, name, status::text AS status FROM app.resolve_tenant_by_slug($1)',
          [slug],
        );
        return r.rows[0] ?? null;
      });
      if (!tenant || tenant.status !== 'ACTIVE') throw ApiError.notFound('Criador não encontrado.');

      const branding = await withTenant(deps.pool, { tenantId: tenant.tenant_id }, async (client) => {
        const r = await client.query<{
          public_name: string | null;
          logo_light_url: string | null;
          banner_url: string | null;
          description: string | null;
          contact: Record<string, string> | null;
        }>('SELECT public_name, logo_light_url, banner_url, description, contact FROM tenant_branding WHERE tenant_id = $1', [tenant.tenant_id]);
        return r.rows[0] ?? null;
      });

      const page = await drawsPage(deps, {
        search: null,
        tenantSlug: tenant.slug,
        cursor: decodePageCursor(req.query['cursor']),
        limit: parseLimit(req.query['limit']),
      });
      const activeDraws = page.draws.filter((d) => d.status === 'ATIVA').length;

      const resposta: MarketplaceCreatorProfile = {
        creator: {
          slug: tenant.slug,
          name: branding?.public_name?.trim() || tenant.name,
          logoUrl: branding?.logo_light_url ?? null,
          description: branding?.description ?? null,
          bannerUrl: branding?.banner_url ?? null,
          contact: branding?.contact ?? {},
          publicDraws: page.draws.length,
          activeDraws,
        },
        draws: page.draws,
        nextCursor: page.nextCursor,
      };
      res.status(200).set('Cache-Control', 'no-cache').json(resposta);
    }),
  };
}
