import type { NextFunction, Request, Response } from 'express';
import { withoutContext } from '@campaigns/db';
import type { ApiErrorBody } from '@campaigns/shared';
import type { AppDeps } from '../deps.js';

/**
 * Controle de origem para uma API autenticada por cookie.
 *
 * POR QUE RECUSAR, E NAO SO OMITIR OS CABECALHOS
 *
 * Omitir os cabecalhos CORS impede o navegador de LER a resposta, mas a
 * requisicao ja foi executada no servidor: uma escrita vinda de um site
 * qualquer teria efeito antes de o navegador barrar a leitura. Com cookie de
 * sessao, recusar na entrada e o comportamento correto.
 *
 * POR QUE A LISTA NAO PODE SER SO ESTATICA
 *
 * A plataforma e white-label: cada comunidade tem o PROPRIO dominio, e a
 * vitrine chama a API de um lugar diferente para cada cliente. Uma lista fixa
 * em variavel de ambiente exigiria reiniciar a API a cada comunidade nova — e
 * quebraria a promessa de dominio proprio.
 *
 * Por isso a origem e aceita quando vem de:
 *   1. `CORS_ORIGINS` — os paineis internos (organizador, Super Admin) e o
 *      desenvolvimento local. Lista curta e fixa;
 *   2. um dominio de comunidade JA VERIFICADO (`tenant_domains.verified_at`)
 *      ou o subdominio `{slug}.{APP_BASE_DOMAIN}`. O mesmo criterio que
 *      resolve a comunidade resolve a origem — dominio registrado e ainda nao
 *      verificado NAO vale.
 *
 * Requisicao SEM `Origin` nao e afetada: o cabecalho e posto pelo navegador, e
 * sua ausencia nao caracteriza origem cruzada (chamada servidor-a-servidor,
 * `curl`, navegacao direta).
 */

function originHost(origin: string): string | null {
  try {
    const url = new URL(origin);
    // Somente http(s): `null`, `file://` e afins nao sao origem confiavel.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

async function isTenantOrigin(deps: AppDeps, origin: string): Promise<boolean> {
  const host = originHost(origin);
  if (!host) return false;

  // Subdominio da plataforma: {slug}.{APP_BASE_DOMAIN}
  const suffix = `.${deps.config.APP_BASE_DOMAIN.toLowerCase()}`;
  if (host.endsWith(suffix)) {
    const slug = host.slice(0, -suffix.length);
    if (slug !== '' && !slug.includes('.') && SLUG_RE.test(slug)) {
      return withoutContext(deps.pool, async (client) => {
        const { rows } = await client.query(
          'SELECT tenant_id FROM app.resolve_tenant_by_slug($1)',
          [slug],
        );
        return rows.length > 0;
      });
    }
  }

  // Dominio proprio, e somente se ja verificado.
  return withoutContext(deps.pool, async (client) => {
    const { rows } = await client.query(
      'SELECT tenant_id FROM app.resolve_tenant_by_domain($1)',
      [host],
    );
    return rows.length > 0;
  });
}

export function originGuard(deps: AppDeps) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const origin = req.get('origin');

      // Sem Origin: nao e origem cruzada. Segue.
      if (origin === undefined) {
        next();
        return;
      }

      let allowed = deps.config.corsOrigins.includes(origin);

      if (!allowed) {
        try {
          allowed = await isTenantOrigin(deps, origin);
        } catch (error) {
          // Banco fora do ar nao pode virar "origem liberada".
          console.error('[origin] falha ao verificar origem:', error);
          allowed = false;
        }
      }

      if (!allowed) {
        const body: ApiErrorBody = {
          error: { code: 'FORBIDDEN', message: 'Origem não autorizada.' },
        };
        res.status(403).json(body);
        return;
      }

      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'content-type,x-tenant-slug');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');

      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
      next();
    })();
  };
}
