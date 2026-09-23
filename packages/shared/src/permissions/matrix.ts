import { PLATFORM_ROLES, type MembershipRole, type PlatformRole } from './roles.js';
import type { PlatformPermission, TenantPermission } from './permissions.js';

/**
 * Matriz de permissoes da equipe da comunidade - transcricao literal da
 * tabela do DOC-01 secao 3.
 *
 *  Acao                               | Dono | Financ. | Mkt | Suporte | Operador
 *  Criar e editar sorteio             |  X   |    -    |  X  |    -    |    X
 *  Enviar imagens e personalizar      |  X   |    -    |  X  |    -    |    X
 *  Enviar p/ revisao, pausar, encerrar|  X   |    -    |  -  |    -    |    X
 *  Ver pagamentos e conciliacao       |  X   |    X    |  -  | so stat | so stat
 *  Estornar pagamento                 |  X   |    X    |  -  |    -    |    -
 *  Gerenciar clientes cativos         |  X   |    X    |  -  |    -    |    -
 *  Ver dados completos do comprador   |  X   |    X    |  -  |    X    |    -
 *  Reenviar comprovante / atender     |  X   |    -    |  -  |    X    |    X
 *  Convidar e remover equipe          |  X   |    -    |  -  |    -    |    -
 *  Alterar marca da comunidade        |  X   |    -    |  X  |    -    |    -
 */
export const TENANT_ROLE_PERMISSIONS: Readonly<
  Record<MembershipRole, readonly TenantPermission[]>
> = Object.freeze({
  OWNER: Object.freeze([
    'tenant:read',
    'draw:write',
    'draw:media:write',
    'draw:customization:write',
    'draw:lifecycle:write',
    'payment:read:full',
    'payment:read:status',
    'payment:refund',
    'captive:manage',
    'buyer:read:full',
    'support:act',
    'team:manage',
    'branding:write',
  ] as const),
  FINANCE: Object.freeze([
    'tenant:read',
    'payment:read:full',
    'payment:read:status',
    'payment:refund',
    'captive:manage',
    'buyer:read:full',
  ] as const),
  MARKETING: Object.freeze([
    'tenant:read',
    'draw:write',
    'draw:media:write',
    'draw:customization:write',
    'branding:write',
  ] as const),
  SUPPORT: Object.freeze([
    'tenant:read',
    // "olho - so status": Suporte NAO recebe payment:read:full nem
    // payment:refund. Ve o estado do pagamento, nao a conciliacao.
    'payment:read:status',
    'buyer:read:full',
    'support:act',
  ] as const),
  OPERATOR: Object.freeze([
    'tenant:read',
    'draw:write',
    'draw:media:write',
    'draw:customization:write',
    'draw:lifecycle:write',
    // "olho - so status". Operador NAO ve dados completos do comprador.
    'payment:read:status',
    'support:act',
  ] as const),
});

/**
 * Matriz de permissoes do Super Admin da plataforma. DOC-01 secao 17.
 *
 * Suposicao (S8 aberta): o DOC-01 detalha as AREAS do Super Admin (Revisao,
 * Risco, Cobrancas, Saude) mas nao publica uma matriz por sub-perfil. A
 * distribuicao abaixo e conservadora - cada sub-perfil recebe apenas a area
 * que o DOC-01 nomeia, mais leitura de saude, que e diagnostico operacional e
 * nao dado de negocio. Nenhum sub-perfil recebe tudo. Precisa de validacao do
 * produto antes de virar regra.
 */
export const PLATFORM_ROLE_PERMISSIONS: Readonly<
  Record<PlatformRole, readonly PlatformPermission[]>
> = Object.freeze({
  PLATFORM_OPERATIONS: Object.freeze([
    'platform:tenant:create',
    'platform:tenant:read',
    'platform:health:read',
    'platform:audit:read',
  ] as const),
  PLATFORM_COMPLIANCE: Object.freeze([
    'platform:tenant:read',
    'platform:review:read',
    'platform:review:decide',
    'platform:health:read',
    'platform:audit:read',
  ] as const),
  PLATFORM_RISK: Object.freeze([
    'platform:tenant:read',
    'platform:risk:read',
    'platform:risk:act',
    'platform:health:read',
    'platform:audit:read',
  ] as const),
  PLATFORM_SUPPORT: Object.freeze([
    'platform:tenant:read',
    'platform:support:act',
    'platform:health:read',
  ] as const),
  PLATFORM_FINANCE: Object.freeze([
    'platform:tenant:read',
    'platform:billing:read',
    'platform:refund:second_approval',
    'platform:health:read',
    'platform:audit:read',
  ] as const),
});

/** Permissoes efetivas de um conjunto de papeis de comunidade. */
export function tenantPermissionsFor(
  roles: readonly MembershipRole[],
): ReadonlySet<TenantPermission> {
  const out = new Set<TenantPermission>();
  for (const role of roles) {
    for (const permission of TENANT_ROLE_PERMISSIONS[role]) out.add(permission);
  }
  return out;
}

/** Permissoes efetivas de um conjunto de papeis de plataforma. */
export function platformPermissionsFor(
  roles: readonly PlatformRole[],
): ReadonlySet<PlatformPermission> {
  const out = new Set<PlatformPermission>();
  for (const role of roles) {
    for (const permission of PLATFORM_ROLE_PERMISSIONS[role]) out.add(permission);
  }
  return out;
}

/**
 * RN12 - MFA obrigatorio para Super Admin, dono e financeiro.
 *
 * Conflito ja registrado (C02): o PROMPT_GERAL exigia MFA apenas para dono e
 * Super Admin. O DOC-01 (RN12) inclui o FINANCEIRO. Vale o DOC-01.
 */
export const MFA_REQUIRED_TENANT_ROLES: readonly MembershipRole[] = Object.freeze([
  'OWNER',
  'FINANCE',
] as const);

/** Todo papel de plataforma exige MFA. RN12. */
export const MFA_REQUIRED_PLATFORM_ROLES: readonly PlatformRole[] = Object.freeze([
  ...PLATFORM_ROLES,
]);

export function requiresMfa(input: {
  tenantRoles?: readonly MembershipRole[];
  platformRoles?: readonly PlatformRole[];
}): boolean {
  const tenantRoles = input.tenantRoles ?? [];
  const platformRoles = input.platformRoles ?? [];
  if (platformRoles.length > 0) return true;
  return tenantRoles.some((role) => MFA_REQUIRED_TENANT_ROLES.includes(role));
}
