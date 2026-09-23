/**
 * Papeis de equipe DENTRO de uma comunidade (tenant). DOC-01 secao 3.
 *
 * Suposicao: os codigos persistidos ficam em ingles maiusculo (OWNER, FINANCE,
 * ...), seguindo a regra "codigo e banco em ingles" do PROMPT_ASTRA. A
 * restricao de "nomes fixos" do DOC-01 cobre os estados de sorteio/numero e as
 * colunas de grade e preco, nao os codigos de papel - o DOC-01 apresenta
 * os papeis apenas como rotulos de interface (Dono, Financeiro, Marketing,
 * Suporte, Operador). Os rotulos em portugues ficam em MEMBERSHIP_ROLE_LABELS.
 *
 * S8 permanece aberta: a matriz da secao 3 ainda nao foi confirmada com
 * clientes piloto.
 */
export const MEMBERSHIP_ROLES = ['OWNER', 'FINANCE', 'MARKETING', 'SUPPORT', 'OPERATOR'] as const;

export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export function isMembershipRole(value: unknown): value is MembershipRole {
  return typeof value === 'string' && (MEMBERSHIP_ROLES as readonly string[]).includes(value);
}

/** Rotulos de interface em portugues. DOC-01 secao 3. */
export const MEMBERSHIP_ROLE_LABELS: Readonly<Record<MembershipRole, string>> = Object.freeze({
  OWNER: 'Dono',
  FINANCE: 'Financeiro',
  MARKETING: 'Marketing',
  SUPPORT: 'Suporte',
  OPERATOR: 'Operador',
});

/**
 * Papeis do Super Admin da PLATAFORMA. PROMPT_GERAL secao 0 ({{PERFIS}}) e
 * DOC-01 secao 17.
 *
 * Eixo separado de MEMBERSHIP_ROLES: um papel de comunidade NUNCA concede
 * privilegio de plataforma, e um papel de plataforma nao concede, por si,
 * acesso aos dados de negocio de um tenant - ver platform.ts.
 */
export const PLATFORM_ROLES = [
  'PLATFORM_OPERATIONS',
  'PLATFORM_COMPLIANCE',
  'PLATFORM_RISK',
  'PLATFORM_SUPPORT',
  'PLATFORM_FINANCE',
] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export function isPlatformRole(value: unknown): value is PlatformRole {
  return typeof value === 'string' && (PLATFORM_ROLES as readonly string[]).includes(value);
}

export const PLATFORM_ROLE_LABELS: Readonly<Record<PlatformRole, string>> = Object.freeze({
  PLATFORM_OPERATIONS: 'Super Admin · Operações',
  PLATFORM_COMPLIANCE: 'Super Admin · Compliance',
  PLATFORM_RISK: 'Super Admin · Risco',
  PLATFORM_SUPPORT: 'Super Admin · Suporte',
  PLATFORM_FINANCE: 'Super Admin · Financeiro',
});
