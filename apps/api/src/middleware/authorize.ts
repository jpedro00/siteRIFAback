import type { NextFunction, Request, Response } from 'express';
import type { PlatformPermission, RouteContract, TenantPermission } from '@campaigns/shared';
import type { AppDeps } from '../deps.js';
import { ApiError } from '../lib/apiError.js';
import { authenticateSession } from '../modules/identity/authService.js';

/**
 * Autenticacao por cookie de sessao.
 *
 * `optional: true` monta a sessao quando houver cookie valido, mas deixa
 * seguir sem ela. Usado nas rotas publicas, que mudam de projecao conforme a
 * pessoa esteja ou nao logada.
 */
export function authenticate(deps: AppDeps, options: { optional: boolean }) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
        const token = cookies[deps.config.SESSION_COOKIE_NAME];

        if (!token) {
          if (options.optional) return next();
          throw ApiError.unauthenticated();
        }

        const session = await authenticateSession(deps, token);
        if (!session) {
          // Sessao revogada, expirada ou inexistente. Vale ja na proxima
          // requisicao apos a revogacao.
          if (options.optional) return next();
          throw ApiError.unauthenticated('Sessão expirada ou revogada.');
        }

        req.session = session;
        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

/**
 * Trava global de RN12.
 *
 * Um perfil que obriga segundo fator (dono, financeiro, Super Admin) e ainda
 * nao o satisfez nesta sessao NAO passa por nenhuma rota de negocio. So
 * sobram as rotas de identidade (`/api/auth/...`), que sao justamente as que
 * permitem cadastrar e verificar o fator.
 *
 * Sem essa trava, um dono sem MFA ainda leria o contexto da comunidade, a
 * lista de papeis e a equipe — informacao de negocio.
 */
export function enforceMfaGate(exemptPathPrefixes: readonly string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const session = req.session;
    if (!session) return next();

    const exempt = exemptPathPrefixes.some((prefix) => req.path.startsWith(prefix));
    if (exempt) return next();

    if (session.mfaRequired && !session.mfaSatisfied) {
      next(session.mfaEnrolled ? ApiError.mfaRequired() : ApiError.mfaEnrollmentRequired());
      return;
    }
    next();
  };
}

/**
 * Autorizacao por rota, a partir do contrato compartilhado.
 *
 * A checagem acontece no BACKEND. Esconder um botao no painel nao e controle
 * de acesso: a rota continua alcançável por qualquer cliente HTTP.
 */
export function authorizeRoute(contract: RouteContract) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const session = req.session;

    if (contract.auth && !session) {
      next(ApiError.unauthenticated());
      return;
    }

    // RN12: rota marcada como privilegiada exige o fator satisfeito NESTA
    // sessao, mesmo que o perfil nao fosse obrigado a ter MFA.
    if (contract.mfa) {
      if (!session) {
        next(ApiError.unauthenticated());
        return;
      }
      if (!session.mfaSatisfied) {
        next(session.mfaEnrolled ? ApiError.mfaRequired() : ApiError.mfaEnrollmentRequired());
        return;
      }
    }

    if (contract.tenantPermission) {
      const tenant = req.tenant;
      if (!tenant) {
        next(ApiError.tenantNotResolved());
        return;
      }
      if (!tenant.permissions.has(contract.tenantPermission as TenantPermission)) {
        next(ApiError.forbidden());
        return;
      }
    }

    if (contract.platformPermission) {
      if (!session) {
        next(ApiError.unauthenticated());
        return;
      }
      // Privilegio de plataforma e explicito. Ser dono de uma comunidade nao
      // concede nada aqui.
      if (!session.platformPermissions.has(contract.platformPermission as PlatformPermission)) {
        next(ApiError.forbidden());
        return;
      }
    }

    next();
  };
}
