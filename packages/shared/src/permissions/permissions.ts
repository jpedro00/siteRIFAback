/**
 * Catalogo de permissoes da comunidade (tenant). DOC-01 secao 3.
 *
 * Cada linha da matriz do DOC-01 vira uma ou mais permissoes. Onde o DOC-01
 * distingue "ver" de "ver so status" (olho), a distincao vira DUAS permissoes
 * separadas - nunca um mesmo direito com filtro aplicado so na interface.
 */
export const TENANT_PERMISSIONS = [
  // "Criar e editar sorteio"
  'draw:write',
  // "Enviar imagens e personalizar"
  'draw:media:write',
  'draw:customization:write',
  // "Enviar para revisao / pausar / encerrar"
  'draw:lifecycle:write',
  // "Ver pagamentos e conciliacao" - acesso financeiro COMPLETO
  // (valores consolidados, taxas, conciliacao, repasses).
  'payment:read:full',
  // "olho - so status": apenas o estado do pagamento de um pedido, sem
  // valores consolidados, sem conciliacao e sem dados pessoais do comprador.
  'payment:read:status',
  // "Estornar pagamento"
  'payment:refund',
  // "Gerenciar clientes cativos"
  'captive:manage',
  // "Ver dados completos do comprador" - dado pessoal, eixo proprio,
  // independente de qualquer acesso a pagamento.
  'buyer:read:full',
  // "Reenviar comprovante / atender"
  'support:act',
  // "Convidar e remover equipe"
  'team:manage',
  // "Alterar marca da comunidade"
  'branding:write',
  // Leitura basica do painel: quem tem vinculo ativo enxerga a comunidade.
  'tenant:read',
] as const;

export type TenantPermission = (typeof TENANT_PERMISSIONS)[number];

export function isTenantPermission(value: unknown): value is TenantPermission {
  return typeof value === 'string' && (TENANT_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Permissoes da PLATAFORMA (Super Admin). DOC-01 secao 17.
 * Eixo separado; nao ha heranca a partir de papeis de comunidade.
 */
export const PLATFORM_PERMISSIONS = [
  // DOC-01 secao 17 - Revisao
  'platform:review:read',
  'platform:review:decide',
  // DOC-01 secao 17 - Risco
  'platform:risk:read',
  'platform:risk:act',
  // DOC-01 secao 17 - Cobrancas
  'platform:billing:read',
  'platform:refund:second_approval',
  // DOC-01 secao 17 - Saude
  'platform:health:read',
  // Criacao de comunidade e convite do dono. DOC-01 secao 2, M01/M11/RN01.
  'platform:tenant:create',
  'platform:tenant:read',
  // Suporte da plataforma atuando sobre uma comunidade.
  'platform:support:act',
  // Leitura da trilha de auditoria de qualquer comunidade. M12.
  'platform:audit:read',
] as const;

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

export function isPlatformPermission(value: unknown): value is PlatformPermission {
  return typeof value === 'string' && (PLATFORM_PERMISSIONS as readonly string[]).includes(value);
}

export type AnyPermission = TenantPermission | PlatformPermission;
