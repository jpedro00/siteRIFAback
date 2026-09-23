import type { Express, RequestHandler } from 'express';
import { ROUTE_CONTRACTS, ROUTE_NAMES, type RouteName } from '@campaigns/shared';
import type { AppDeps } from '../deps.js';
import { authenticate, authorizeRoute, enforceMfaGate } from '../middleware/authorize.js';
import { tenantResolver } from '../middleware/tenantResolver.js';
import { buildAuthHandlers } from '../modules/identity/authRoutes.js';
import { buildTenantHandlers } from '../modules/tenancy/tenantRoutes.js';
import { buildHealthHandler } from '../modules/health/healthRoutes.js';
import { buildDrawHandlers } from '../modules/draws/drawRoutes.js';

/**
 * Registro das rotas a partir do contrato compartilhado.
 *
 * E4 - contrato frontend/backend: as rotas NASCEM do mesmo registro que os
 * frontends usam para montar as chamadas, e a funcao falha na subida se faltar
 * handler para algum contrato — o processo nem sobe com uma rota declarada e
 * nao implementada.
 *
 * Caminhos isentos da trava global de MFA: sao exatamente as rotas que
 * permitem cadastrar e verificar o segundo fator, mais diagnostico e vitrine
 * publica. Sem essa isencao, um dono sem MFA ficaria sem nenhum caminho para
 * cadastrar o fator.
 */
const MFA_GATE_EXEMPT_PREFIXES = ['/api/auth', '/api/health', '/api/public'] as const;

export function registerRoutes(app: Express, deps: AppDeps): void {
  const handlers: Partial<Record<RouteName, RequestHandler>> = {
    ...buildHealthHandler(deps),
    ...buildAuthHandlers(deps),
    ...buildTenantHandlers(deps),
    ...buildDrawHandlers(deps),
  } as Partial<Record<RouteName, RequestHandler>>;

  const missing = ROUTE_NAMES.filter((name) => handlers[name] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Contratos de rota sem implementacao: ${missing.join(', ')}. ` +
        'Todo contrato declarado em packages/shared precisa de handler.',
    );
  }

  for (const name of ROUTE_NAMES) {
    const contract = ROUTE_CONTRACTS[name];
    const handler = handlers[name]!;
    const chain: RequestHandler[] = [];

    // 1. Sessao. Rotas publicas aceitam ausencia de cookie.
    chain.push(authenticate(deps, { optional: !contract.auth }));

    // 2. Comunidade. `requireMembership` so vale quando a rota exige sessao:
    //    a vitrine publica resolve a comunidade sem exigir vinculo.
    if (contract.tenantScope === 'resolved') {
      chain.push(tenantResolver(deps, { requireMembership: contract.auth }));
    }

    // 3. Trava global de RN12.
    chain.push(enforceMfaGate(MFA_GATE_EXEMPT_PREFIXES));

    // 4. Permissao da rota, verificada no backend.
    chain.push(authorizeRoute(contract));

    const method = contract.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
    app[method](contract.path, ...chain, handler);
  }
}

/**
 * Caminhos efetivamente montados no Express, na forma "METHOD /caminho".
 * Usado pelo teste de contrato para comparar rota registrada x rota declarada.
 */
export function listRegisteredRoutes(app: Express): string[] {
  const routes: string[] = [];
  const stack = (app as unknown as { _router?: { stack: unknown[] } })._router?.stack ?? [];

  for (const layer of stack) {
    const route = (layer as { route?: { path: string; methods: Record<string, boolean> } }).route;
    if (!route) continue;
    for (const [method, enabled] of Object.entries(route.methods)) {
      if (enabled) routes.push(`${method.toUpperCase()} ${route.path}`);
    }
  }
  return routes.sort();
}
