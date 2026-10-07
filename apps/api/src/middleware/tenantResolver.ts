import type { NextFunction, Request, Response } from 'express';
import { withUser, withoutContext } from '@clubedarifa/db';
import { tenantPermissionsFor, type MembershipRole } from '@clubedarifa/shared';
import type { AppDeps } from '../deps.js';
import { ApiError } from '../lib/apiError.js';

/**
 * Resolucao da comunidade. RN01.
 *
 * O CLIENTE NUNCA ESCOLHE UM tenant_id. Ele traz, no maximo, um NOME —
 * dominio ou slug. O identificador sai do banco, e o acesso so e concedido
 * depois de o vinculo daquele usuario com aquela comunidade ser confirmado.
 *
 * Ordem de resolucao:
 *   1. Host exato em `tenant_domains`, com `verified_at` preenchido.
 *      Dominio registrado e ainda nao verificado NAO resolve.
 *   2. Host no formato {slug}.{APP_BASE_DOMAIN}.
 *   3. ORIGIN, pelos mesmos dois criterios acima. E o caminho da vitrine em
 *      dominio proprio: o navegador chama `api.<plataforma>` a partir de
 *      `rifa.cliente.com`, entao o Host e o da API e quem identifica a comunidade
 *      e a origem. `Origin` e posto pelo navegador e o script da pagina nao o
 *      forja; de qualquer forma ele so SELECIONA a comunidade — vinculo e permissao
 *      continuam sendo conferidos no banco — e ja passou pelo `originGuard`.
 *   4. Cabecalho `x-tenant-slug` — SOMENTE se `TENANT_HEADER_ENABLED` estiver
 *      ligado, o que nao acontece em producao.
 *
 * Por que o cabecalho e gated: ele e um seletor de comunidade controlado pelo
 * CLIENTE. Aceito incondicionalmente, qualquer requisicao — de qualquer host,
 * inclusive um host desconhecido — escolheria a comunidade que quisesse, e a
 * regra "dominio desconhecido devolve 404" viraria letra morta, porque o host
 * deixaria de importar. Ele existe apenas para o desenvolvimento em localhost,
 * onde nao ha subdominio por comunidade.
 *
 * Host desconhecido resulta em 404. NAO existe comunidade padrao de fallback:
 * cair numa comunidade qualquer seria servir a marca e os dados de outro
 * cliente.
 */

interface ResolveRow {
  tenant_id: string;
  slug: string;
  name: string;
  status: string;
}

function hostWithoutPort(host: string | undefined): string | null {
  if (!host) return null;
  const trimmed = host.trim().toLowerCase();
  if (trimmed === '') return null;
  // IPv6 entre colchetes: [::1]:3000
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end === -1 ? trimmed : trimmed.slice(0, end + 1);
  }
  const colon = trimmed.lastIndexOf(':');
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

function slugFromHost(host: string, baseDomain: string): string | null {
  const suffix = `.${baseDomain.toLowerCase()}`;
  if (!host.endsWith(suffix)) return null;
  const slug = host.slice(0, -suffix.length);
  if (slug === '' || slug.includes('.')) return null;
  return slug;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Resolve pelo nome de host: dominio verificado primeiro, depois {slug}.{APP_BASE_DOMAIN}. */
async function resolveByHostName(
  deps: AppDeps,
  host: string,
  by: { domain: 'domain'; slug: 'slug' } | { domain: 'origin'; slug: 'origin' },
): Promise<{ row: ResolveRow; resolvedBy: ResolvedBy } | null> {
  const byDomain = await withoutContext(deps.pool, async (client) => {
    const { rows } = await client.query<ResolveRow>(
      'SELECT tenant_id, slug, name, status FROM app.resolve_tenant_by_domain($1)',
      [host],
    );
    return rows[0] ?? null;
  });
  if (byDomain) return { row: byDomain, resolvedBy: by.domain };

  const slug = slugFromHost(host, deps.config.APP_BASE_DOMAIN);
  if (slug && SLUG_RE.test(slug)) {
    const bySlug = await withoutContext(deps.pool, async (client) => {
      const { rows } = await client.query<ResolveRow>(
        'SELECT tenant_id, slug, name, status FROM app.resolve_tenant_by_slug($1)',
        [slug],
      );
      return rows[0] ?? null;
    });
    if (bySlug) return { row: bySlug, resolvedBy: by.slug };
  }
  return null;
}

/** Nome de host de uma `Origin`, so para http(s). */
function hostOfOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

type ResolvedBy = 'domain' | 'slug' | 'origin' | 'header' | 'path';

async function resolveBySlug(deps: AppDeps, slug: string): Promise<ResolveRow | null> {
  return withoutContext(deps.pool, async (client) => {
    const { rows } = await client.query<ResolveRow>(
      'SELECT tenant_id, slug, name, status FROM app.resolve_tenant_by_slug($1)',
      [slug],
    );
    return rows[0] ?? null;
  });
}

export async function resolveTenant(
  deps: AppDeps,
  req: Request,
  options: { authenticatedHeader?: boolean } = {},
): Promise<{ row: ResolveRow; resolvedBy: ResolvedBy } | null> {
  // SELECAO EXPLICITA EM ROTA PRIVADA. O Organizer central tem um dominio so para todos os
  // criadores, entao o dominio nao diz de qual comunidade se fala. Aqui — e SO aqui — o cabecalho
  // vale, mesmo com TENANT_HEADER_ENABLED=false, porque: (1) a rota exige sessao, (2) o middleware
  // confere o vinculo do usuario com a comunidade logo depois (sem vinculo = 404), (3) o slug nao
  // concede nada: o acesso vem do vinculo. Rotas publicas nunca passam por este ramo.
  if (options.authenticatedHeader && req.session) {
    const explicit = req.get('x-tenant-slug')?.trim().toLowerCase();
    if (explicit && SLUG_RE.test(explicit)) {
      const row = await resolveBySlug(deps, explicit);
      if (row) return { row, resolvedBy: 'header' };
    }
  }

  const host = hostWithoutPort(req.headers.host);

  // 1 e 2: o Host da requisicao.
  if (host) {
    const porHost = await resolveByHostName(deps, host, { domain: 'domain', slug: 'slug' });
    if (porHost) return porHost;
  }

  // 3: a Origin. Host desconhecido + Origin desconhecida = 404, sem comunidade padrao.
  const originHost = hostOfOrigin(req.get('origin'));
  if (originHost && originHost !== host) {
    const porOrigem = await resolveByHostName(deps, originHost, { domain: 'origin', slug: 'origin' });
    if (porOrigem) return porOrigem;
  }

  // Sem a chave ligada, o cabecalho e simplesmente ignorado: nao ha caminho
  // pelo qual o cliente escolha a comunidade.
  if (!deps.config.TENANT_HEADER_ENABLED) {
    return null;
  }

  const headerSlug = req.get('x-tenant-slug')?.trim().toLowerCase();
  if (headerSlug && SLUG_RE.test(headerSlug)) {
    const byHeader = await withoutContext(deps.pool, async (client) => {
      const { rows } = await client.query<ResolveRow>(
        'SELECT tenant_id, slug, name, status FROM app.resolve_tenant_by_slug($1)',
        [headerSlug],
      );
      return rows[0] ?? null;
    });
    if (byHeader) return { row: byHeader, resolvedBy: 'header' };
  }

  return null;
}

/**
 * Middleware de comunidade.
 *
 * `requireMembership = false` na vitrine publica: a pagina publica existe sem
 * sessao. Mesmo assim a comunidade precisa ser resolvida — e a projecao
 * devolvida e apenas a marca publica.
 */
export function tenantResolver(deps: AppDeps, options: { requireMembership: boolean }) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        const resolved = await resolveTenant(deps, req, { authenticatedHeader: options.requireMembership });
        if (!resolved) {
          throw ApiError.tenantNotResolved();
        }
        if (resolved.row.status !== 'ACTIVE') {
          // Comunidade suspensa ou arquivada nao atende.
          throw ApiError.tenantNotResolved();
        }

        let roles: MembershipRole[] = [];

        if (options.requireMembership) {
          const session = req.session;
          if (!session) {
            throw ApiError.unauthenticated();
          }

          // A associacao e verificada no banco, com o usuario do contexto.
          roles = await withUser(deps.pool, { userId: session.userId }, async (client) => {
            const { rows } = await client.query<{ role: MembershipRole }>(
              'SELECT role FROM app.my_roles_in_tenant($1)',
              [resolved.row.tenant_id],
            );
            return rows.map((row) => row.role);
          });

          if (roles.length === 0) {
            // Sem vinculo: 404, nao 403. Um 403 confirmaria que a comunidade
            // existe. DOC-01 secao 21.
            throw ApiError.tenantAccessDenied();
          }
        }

        req.tenant = {
          tenantId: resolved.row.tenant_id,
          slug: resolved.row.slug,
          name: resolved.row.name,
          status: resolved.row.status,
          resolvedBy: resolved.resolvedBy,
          roles,
          permissions: tenantPermissionsFor(roles),
        };
        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

/**
 * Rotas PUBLICAS do marketplace: a comunidade vem do `:tenantSlug` do CAMINHO.
 *
 * Nao e um seletor arbitrario: so resolve comunidade ACTIVE, nao concede papel nenhum
 * (`roles` vazio), e as rotas que usam este middleware expoem exatamente o que a vitrine da
 * propria comunidade ja expoe ao publico. Comunidade inexistente ou inativa = 404.
 */
export function pathTenantResolver(deps: AppDeps) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        const slug = String(req.params['tenantSlug'] ?? '').trim().toLowerCase();
        if (!SLUG_RE.test(slug) || slug.length > 63) throw ApiError.tenantNotResolved();
        const row = await resolveBySlug(deps, slug);
        if (!row || row.status !== 'ACTIVE') throw ApiError.tenantNotResolved();
        req.tenant = {
          tenantId: row.tenant_id,
          slug: row.slug,
          name: row.name,
          status: row.status,
          resolvedBy: 'path',
          roles: [],
          permissions: tenantPermissionsFor([]),
        };
        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}
