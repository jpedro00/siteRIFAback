import { describe, expect, it } from 'vitest';
import {
  MEMBERSHIP_ROLES,
  PLATFORM_ROLES,
  PLATFORM_ROLE_PERMISSIONS,
  TENANT_ROLE_PERMISSIONS,
  platformPermissionsFor,
  requiresMfa,
  tenantPermissionsFor,
  type MembershipRole,
} from '../src/index.js';

/**
 * Transcricao da matriz do DOC-01 secao 3, usada como oraculo do teste.
 * true = permitido | 'status' = somente status do pagamento | false = negado.
 */
const DOC01_SECTION_3: Record<string, Record<MembershipRole, boolean | 'status'>> = {
  'Criar e editar sorteio': {
    OWNER: true,
    FINANCE: false,
    MARKETING: true,
    SUPPORT: false,
    OPERATOR: true,
  },
  'Enviar imagens e personalizar': {
    OWNER: true,
    FINANCE: false,
    MARKETING: true,
    SUPPORT: false,
    OPERATOR: true,
  },
  'Enviar para revisao / pausar / encerrar': {
    OWNER: true,
    FINANCE: false,
    MARKETING: false,
    SUPPORT: false,
    OPERATOR: true,
  },
  'Ver pagamentos e conciliacao': {
    OWNER: true,
    FINANCE: true,
    MARKETING: false,
    SUPPORT: 'status',
    OPERATOR: 'status',
  },
  'Estornar pagamento': {
    OWNER: true,
    FINANCE: true,
    MARKETING: false,
    SUPPORT: false,
    OPERATOR: false,
  },
  'Gerenciar clientes cativos': {
    OWNER: true,
    FINANCE: true,
    MARKETING: false,
    SUPPORT: false,
    OPERATOR: false,
  },
  'Ver dados completos do comprador': {
    OWNER: true,
    FINANCE: true,
    MARKETING: false,
    SUPPORT: true,
    OPERATOR: false,
  },
  'Reenviar comprovante / atender': {
    OWNER: true,
    FINANCE: false,
    MARKETING: false,
    SUPPORT: true,
    OPERATOR: true,
  },
  'Convidar e remover equipe': {
    OWNER: true,
    FINANCE: false,
    MARKETING: false,
    SUPPORT: false,
    OPERATOR: false,
  },
  'Alterar marca da comunidade': {
    OWNER: true,
    FINANCE: false,
    MARKETING: true,
    SUPPORT: false,
    OPERATOR: false,
  },
};

const ROW_TO_PERMISSION = {
  'Criar e editar sorteio': 'draw:write',
  'Enviar imagens e personalizar': 'draw:media:write',
  'Enviar para revisao / pausar / encerrar': 'draw:lifecycle:write',
  'Ver pagamentos e conciliacao': 'payment:read:full',
  'Estornar pagamento': 'payment:refund',
  'Gerenciar clientes cativos': 'captive:manage',
  'Ver dados completos do comprador': 'buyer:read:full',
  'Reenviar comprovante / atender': 'support:act',
  'Convidar e remover equipe': 'team:manage',
  'Alterar marca da comunidade': 'branding:write',
} as const;

describe('RN01 · matriz de permissoes da equipe (DOC-01 secao 3)', () => {
  for (const [row, expectations] of Object.entries(DOC01_SECTION_3)) {
    const permission = ROW_TO_PERMISSION[row as keyof typeof ROW_TO_PERMISSION];

    for (const role of MEMBERSHIP_ROLES) {
      const expected = expectations[role];
      it(`${row} · ${role} = ${String(expected)}`, () => {
        const granted = tenantPermissionsFor([role]);
        if (expected === true) {
          expect(granted.has(permission)).toBe(true);
        } else {
          // Tanto 'false' quanto 'status' negam a permissao COMPLETA da linha.
          expect(granted.has(permission)).toBe(false);
        }
      });
    }
  }

  it('acesso ao status do pagamento e distinto do acesso financeiro completo', () => {
    for (const role of MEMBERSHIP_ROLES) {
      const granted = tenantPermissionsFor([role]);
      const expected = DOC01_SECTION_3['Ver pagamentos e conciliacao']![role];
      if (expected === 'status') {
        expect(granted.has('payment:read:status')).toBe(true);
        expect(granted.has('payment:read:full')).toBe(false);
      }
      if (expected === true) {
        expect(granted.has('payment:read:status')).toBe(true);
        expect(granted.has('payment:read:full')).toBe(true);
      }
    }
  });

  it('acesso ao status do pagamento nao concede dados pessoais do comprador', () => {
    // Operador ve status do pagamento e NAO ve dados completos do comprador.
    const operator = tenantPermissionsFor(['OPERATOR']);
    expect(operator.has('payment:read:status')).toBe(true);
    expect(operator.has('buyer:read:full')).toBe(false);
  });

  it('dados pessoais do comprador nao concedem acesso financeiro', () => {
    // Suporte ve o comprador e NAO ve conciliacao nem estorna.
    const support = tenantPermissionsFor(['SUPPORT']);
    expect(support.has('buyer:read:full')).toBe(true);
    expect(support.has('payment:read:full')).toBe(false);
    expect(support.has('payment:refund')).toBe(false);
  });

  it('marketing nao toca em dinheiro nem em dado pessoal', () => {
    const marketing = tenantPermissionsFor(['MARKETING']);
    expect(marketing.has('payment:read:full')).toBe(false);
    expect(marketing.has('payment:read:status')).toBe(false);
    expect(marketing.has('payment:refund')).toBe(false);
    expect(marketing.has('buyer:read:full')).toBe(false);
    expect(marketing.has('captive:manage')).toBe(false);
  });

  it('todo papel tem entrada na matriz', () => {
    for (const role of MEMBERSHIP_ROLES) {
      expect(TENANT_ROLE_PERMISSIONS[role].length).toBeGreaterThan(0);
    }
  });
});

describe('RN01 · privilegios de plataforma sao explicitos', () => {
  it('nenhum papel de comunidade concede permissao de plataforma', () => {
    for (const role of MEMBERSHIP_ROLES) {
      for (const permission of tenantPermissionsFor([role])) {
        expect(permission.startsWith('platform:')).toBe(false);
      }
    }
  });

  it('nenhum papel de plataforma concede permissao de comunidade', () => {
    for (const role of PLATFORM_ROLES) {
      for (const permission of platformPermissionsFor([role])) {
        expect(permission.startsWith('platform:')).toBe(true);
      }
    }
  });

  it('nenhum sub-perfil de Super Admin recebe todas as permissoes', () => {
    const total = new Set(
      PLATFORM_ROLES.flatMap((role) => [...PLATFORM_ROLE_PERMISSIONS[role]]),
    ).size;
    for (const role of PLATFORM_ROLES) {
      expect(PLATFORM_ROLE_PERMISSIONS[role].length).toBeLessThan(total);
    }
  });

  it('somente o financeiro da plataforma aprova a segunda via de estorno', () => {
    // DOC-01 secao 17. O limite monetario permanece em aberto (C22): nenhum
    // valor arbitrario foi adotado.
    for (const role of PLATFORM_ROLES) {
      const has = platformPermissionsFor([role]).has('platform:refund:second_approval');
      expect(has).toBe(role === 'PLATFORM_FINANCE');
    }
  });

  it('somente compliance decide a fila de revisao', () => {
    for (const role of PLATFORM_ROLES) {
      const has = platformPermissionsFor([role]).has('platform:review:decide');
      expect(has).toBe(role === 'PLATFORM_COMPLIANCE');
    }
  });
});

describe('RN12 · MFA obrigatorio', () => {
  it('dono exige MFA', () => {
    expect(requiresMfa({ tenantRoles: ['OWNER'] })).toBe(true);
  });

  it('financeiro exige MFA (correcao do PROMPT_GERAL pelo DOC-01)', () => {
    expect(requiresMfa({ tenantRoles: ['FINANCE'] })).toBe(true);
  });

  it('todo papel de Super Admin exige MFA', () => {
    for (const role of PLATFORM_ROLES) {
      expect(requiresMfa({ platformRoles: [role] })).toBe(true);
    }
  });

  it('marketing, suporte e operador nao sao obrigados a MFA', () => {
    expect(requiresMfa({ tenantRoles: ['MARKETING'] })).toBe(false);
    expect(requiresMfa({ tenantRoles: ['SUPPORT'] })).toBe(false);
    expect(requiresMfa({ tenantRoles: ['OPERATOR'] })).toBe(false);
  });

  it('um papel obrigatorio entre varios ja obriga MFA', () => {
    expect(requiresMfa({ tenantRoles: ['SUPPORT', 'FINANCE'] })).toBe(true);
  });
});
