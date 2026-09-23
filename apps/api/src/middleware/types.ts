import type { Request } from 'express';
import type {
  MembershipRole,
  PlatformPermission,
  PlatformRole,
  TenantPermission,
} from '@campaigns/shared';

/** Sessao autenticada, montada pelo middleware `authenticate`. */
export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  /** Segundo fator satisfeito NESTA sessao. RN12. */
  readonly mfaSatisfied: boolean;
  /** O perfil do usuario obriga MFA. RN12. */
  readonly mfaRequired: boolean;
  /** Existe fator TOTP confirmado na conta. */
  readonly mfaEnrolled: boolean;
  readonly platformRoles: readonly PlatformRole[];
  readonly platformPermissions: ReadonlySet<PlatformPermission>;
}

/**
 * Comunidade resolvida por dominio ou slug.
 *
 * `roles` e `permissions` so aparecem depois de a associacao entre a
 * comunidade pedida e o vinculo do usuario ter sido verificada no banco. Um
 * tenant_id vindo do cliente nunca chega aqui sem essa verificacao.
 */
export interface ResolvedTenant {
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
  readonly status: string;
  /** Como a comunidade foi resolvida, util para diagnostico. */
  readonly resolvedBy: 'domain' | 'slug' | 'header';
  readonly roles: readonly MembershipRole[];
  readonly permissions: ReadonlySet<TenantPermission>;
}

export interface RequestContext {
  readonly requestId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      context?: RequestContext;
      session?: AuthenticatedSession;
      tenant?: ResolvedTenant;
    }
  }
}

export function requireContext(req: Request): RequestContext {
  if (!req.context) {
    throw new Error('requestContext middleware nao foi montado.');
  }
  return req.context;
}
