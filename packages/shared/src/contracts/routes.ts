import { z } from 'zod';
import { MEMBERSHIP_ROLES, PLATFORM_ROLES } from '../permissions/roles.js';
import { TENANT_PERMISSIONS, PLATFORM_PERMISSIONS } from '../permissions/permissions.js';

/**
 * Registro unico de contratos de rota.
 *
 * E4 - contrato frontend/backend: uma rota chamada pelo frontend e inexistente
 * no backend so aparece em producao, como 404.
 *
 * Esta lista e a UNICA fonte:
 *  - a API registra as rotas a partir daqui (apps/api/src/http/registerRoutes.ts);
 *  - os frontends chamam via cliente tipado compartilhado, de
 *    modo que uma rota inexistente quebra o typecheck;
 *  - o teste de contrato (apps/api/tests/route-contract.test.ts) falha se a
 *    API expuser uma rota fora deste registro ou deixar de expor uma daqui.
 *
 * Esta fase declara APENAS rotas efetivamente implementadas. Rotas de sorteio,
 * reserva, checkout e pagamento pertencem as fases 2+ e nao aparecem aqui.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * Como a rota decide o contexto de comunidade.
 * - 'none'     : rota de plataforma ou de identidade global; nao abre contexto de tenant.
 * - 'resolved' : exige comunidade resolvida por dominio ou slug (middleware de tenant).
 */
export type TenantScope = 'none' | 'resolved';

export interface RouteContract {
  readonly method: HttpMethod;
  /** Caminho no formato Express. */
  readonly path: string;
  readonly summary: string;
  /** Exige sessao autenticada. */
  readonly auth: boolean;
  /**
   * Exige que a sessao tenha passado pelo segundo fator NESTA sessao.
   * RN12 - operacao privilegiada nao abre sem MFA satisfeito.
   */
  readonly mfa: boolean;
  readonly tenantScope: TenantScope;
  /** Permissao de comunidade exigida, se houver. */
  readonly tenantPermission?: (typeof TENANT_PERMISSIONS)[number];
  /** Permissao de plataforma exigida, se houver. */
  readonly platformPermission?: (typeof PLATFORM_PERMISSIONS)[number];
}

const membershipRoleSchema = z.enum(MEMBERSHIP_ROLES);
const platformRoleSchema = z.enum(PLATFORM_ROLES);

// ---------------------------------------------------------------------------
// Schemas de payload
// ---------------------------------------------------------------------------

export const loginRequestSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(512),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const loginResponseSchema = z.object({
  /**
   * 'authenticated'  : sessao utilizavel; nenhum fator adicional pendente.
   * 'mfa_required'   : credencial correta, mas o perfil exige segundo fator
   *                    (RN12) e ele ainda nao foi satisfeito nesta sessao.
   * 'mfa_enrollment_required': perfil exige MFA e ainda nao ha fator cadastrado.
   */
  status: z.enum(['authenticated', 'mfa_required', 'mfa_enrollment_required']),
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    displayName: z.string(),
  }),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const mfaEnrollStartResponseSchema = z.object({
  /** Segredo TOTP em base32, exibido uma unica vez. */
  secret: z.string(),
  otpauthUri: z.string(),
});
export type MfaEnrollStartResponse = z.infer<typeof mfaEnrollStartResponseSchema>;

export const mfaCodeRequestSchema = z.object({
  code: z.string().regex(/^[0-9]{6}$/, 'O código deve ter 6 dígitos.'),
});
export type MfaCodeRequest = z.infer<typeof mfaCodeRequestSchema>;

export const mfaVerifyResponseSchema = z.object({
  status: z.literal('authenticated'),
});
export type MfaVerifyResponse = z.infer<typeof mfaVerifyResponseSchema>;

export const membershipSummarySchema = z.object({
  tenantId: z.string().uuid(),
  tenantSlug: z.string(),
  tenantName: z.string(),
  roles: z.array(membershipRoleSchema),
});
export type MembershipSummary = z.infer<typeof membershipSummarySchema>;

export const sessionResponseSchema = z.object({
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    displayName: z.string(),
  }),
  /** Segundo fator satisfeito nesta sessao. */
  mfaSatisfied: z.boolean(),
  /** O perfil do usuario exige MFA (RN12). */
  mfaRequired: z.boolean(),
  /** Ha fator TOTP confirmado na conta. */
  mfaEnrolled: z.boolean(),
  platformRoles: z.array(platformRoleSchema),
  platformPermissions: z.array(z.enum(PLATFORM_PERMISSIONS)),
  memberships: z.array(membershipSummarySchema),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const tenantContextResponseSchema = z.object({
  tenantId: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  roles: z.array(membershipRoleSchema),
  permissions: z.array(z.enum(TENANT_PERMISSIONS)),
});
export type TenantContextResponse = z.infer<typeof tenantContextResponseSchema>;

/** Projecao publica da marca. Nao exige sessao e nao expoe dado de negocio. */
export const publicTenantBrandingSchema = z.object({
  tenantId: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  publicName: z.string().nullable(),
  logoLightUrl: z.string().nullable(),
  logoDarkUrl: z.string().nullable(),
  faviconUrl: z.string().nullable(),
  colors: z.record(z.string()),
  fonts: z.record(z.string()),
  contact: z.record(z.string()),
});
export type PublicTenantBranding = z.infer<typeof publicTenantBrandingSchema>;

export const auditEventSchema = z.object({
  id: z.string().uuid(),
  occurredAt: z.string(),
  action: z.string(),
  actorUserId: z.string().uuid().nullable(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  ip: z.string().nullable(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const auditListResponseSchema = z.object({
  events: z.array(auditEventSchema),
});
export type AuditListResponse = z.infer<typeof auditListResponseSchema>;

export const tenantListItemSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  status: z.string(),
  createdAt: z.string(),
});
export const tenantListResponseSchema = z.object({
  tenants: z.array(tenantListItemSchema),
});
export type TenantListResponse = z.infer<typeof tenantListResponseSchema>;

export const createTenantRequestSchema = z.object({
  slug: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Use letras minúsculas, números e hífen.'),
  name: z.string().min(2).max(160),
  /**
   * Dono da comunidade, por e-mail de uma conta JA EXISTENTE.
   *
   * Uma comunidade sem dono e uma comunidade que ninguem consegue operar: o
   * Super Admin cria e nao administra, e nao ha a quem pedir. Por isso o dono
   * entra na mesma transacao da criacao — ou nascem os dois, ou nao nasce
   * nenhum.
   *
   * E-mail de conta existente, e nao convite: convidar exige envio, token,
   * expiracao e uma tela de aceite — fase propria. Exigir que a pessoa ja
   * tenha cadastro resolve o dono real agora, com o cadastro que acabou de
   * existir, sem senha provisoria inventada.
   */
  ownerEmail: z.string().trim().toLowerCase().email().max(320),
});
export type CreateTenantRequest = z.infer<typeof createTenantRequestSchema>;

export const createTenantResponseSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  status: z.string(),
  createdAt: z.string(),
  owner: z.object({
    userId: z.string().uuid(),
    email: z.string(),
    displayName: z.string(),
  }),
});
export type CreateTenantResponse = z.infer<typeof createTenantResponseSchema>;

// ---------------------------------------------------------------------------
// Cadastro do participante
// ---------------------------------------------------------------------------

/**
 * A senha e conferida no SERVIDOR, sempre. A confirmacao viaja junto porque
 * ela pertence ao formulario e o servidor e a autoridade sobre o formulario
 * inteiro — validar so no navegador deixaria a regra a um `fetch` de
 * distancia.
 */
export const registerRequestSchema = z
  .object({
    // `trim()` ANTES de `email()`: quem digita no celular herda um espaco do
    // teclado com frequencia, e recusar por isso e recusar sem motivo.
    displayName: z.string().trim().min(2).max(160),
    email: z.string().trim().toLowerCase().email().max(320),
    password: z.string().min(10).max(200),
    passwordConfirmation: z.string().min(10).max(200),
  })
  .refine((v) => v.password === v.passwordConfirmation, {
    message: 'As senhas não coincidem.',
    path: ['passwordConfirmation'],
  });
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const registerResponseSchema = z.object({
  user: z.object({
    id: z.string().uuid(),
    email: z.string(),
    displayName: z.string(),
  }),
});
export type RegisterResponse = z.infer<typeof registerResponseSchema>;

// ---------------------------------------------------------------------------
// Conta do participante
// ---------------------------------------------------------------------------

export const accountOrderSchema = z.object({
  orderId: z.string().uuid(),
  status: z.enum(['PENDENTE', 'PAGO', 'CANCELADO']),
  quantity: z.number().int().positive(),
  unitPriceCents: z.number().int().positive(),
  totalCents: z.number().int().positive(),
  createdAt: z.string(),
  paidAt: z.string().nullable(),
  numbers: z.array(z.number().int().nonnegative()),
  labelDigits: z.union([z.literal(2), z.literal(3)]),
  drawSlug: z.string(),
  drawTitle: z.string(),
  tenantSlug: z.string(),
  tenantName: z.string(),
});
export type AccountOrder = z.infer<typeof accountOrderSchema>;

/**
 * Paginacao por keyset desde o inicio.
 *
 * A conta e uma lista que cresce pela frente. Com OFFSET, um pedido novo entre
 * a primeira e a segunda pagina empurra tudo e faz a pagina 2 repetir o que a
 * pagina 1 ja mostrou. O cursor aponta para uma posicao estavel.
 *
 * `nextCursor` nulo significa fim da lista — e o unico jeito honesto de a tela
 * saber que mostrou tudo, em vez de supor pelo tamanho da pagina.
 */
export const accountOrdersResponseSchema = z.object({
  orders: z.array(accountOrderSchema),
  nextCursor: z.string().nullable(),
});
export type AccountOrdersResponse = z.infer<typeof accountOrdersResponseSchema>;

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  database: z.enum(['up', 'down']),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

// ---------------------------------------------------------------------------
// Registro de rotas
// ---------------------------------------------------------------------------

export const ROUTE_CONTRACTS = {
  health: {
    method: 'GET',
    path: '/api/health',
    summary: 'Diagnostico da API e do banco.',
    auth: false,
    mfa: false,
    tenantScope: 'none',
  },
  publicTenantBranding: {
    method: 'GET',
    path: '/api/public/tenant',
    summary: 'Marca publica da comunidade resolvida por dominio ou slug.',
    auth: false,
    mfa: false,
    tenantScope: 'resolved',
  },
  register: {
    method: 'POST',
    path: '/api/auth/register',
    summary: 'Cria a conta global do participante.',
    auth: false,
    mfa: false,
    tenantScope: 'none',
  },
  login: {
    method: 'POST',
    path: '/api/auth/login',
    summary: 'Autentica por e-mail e senha e abre sessao.',
    auth: false,
    mfa: false,
    tenantScope: 'none',
  },
  accountOrders: {
    method: 'GET',
    path: '/api/account/orders',
    summary: 'Pedidos da conta autenticada, em todas as comunidades.',
    auth: true,
    // Participante nao tem segundo fator obrigatorio: RN12 vale para quem
    // administra. Exigir TOTP para ver o proprio comprovante fecharia a conta
    // para quem ela foi feita.
    mfa: false,
    tenantScope: 'none',
  },
  logout: {
    method: 'POST',
    path: '/api/auth/logout',
    summary: 'Revoga a sessao atual.',
    auth: true,
    mfa: false,
    tenantScope: 'none',
  },
  logoutAll: {
    method: 'POST',
    path: '/api/auth/logout-all',
    summary: 'Revoga todas as sessoes do usuario.',
    auth: true,
    mfa: false,
    tenantScope: 'none',
  },
  session: {
    method: 'GET',
    path: '/api/auth/session',
    summary: 'Estado da sessao, perfis e vinculos de comunidade.',
    auth: true,
    mfa: false,
    tenantScope: 'none',
  },
  mfaEnrollStart: {
    method: 'POST',
    path: '/api/auth/mfa/enroll',
    summary: 'Gera segredo TOTP para cadastro do segundo fator.',
    auth: true,
    mfa: false,
    tenantScope: 'none',
  },
  mfaEnrollConfirm: {
    method: 'POST',
    path: '/api/auth/mfa/enroll/confirm',
    summary: 'Confirma o cadastro do segundo fator com um codigo valido.',
    auth: true,
    mfa: false,
    tenantScope: 'none',
  },
  mfaVerify: {
    method: 'POST',
    path: '/api/auth/mfa/verify',
    summary: 'Satisfaz o segundo fator na sessao atual.',
    auth: true,
    mfa: false,
    tenantScope: 'none',
  },
  tenantContext: {
    method: 'GET',
    path: '/api/tenant/context',
    summary: 'Contexto da comunidade resolvida, com papeis e permissoes efetivas.',
    auth: true,
    mfa: false,
    tenantScope: 'resolved',
    tenantPermission: 'tenant:read',
  },
  tenantAudit: {
    method: 'GET',
    path: '/api/tenant/audit-events',
    summary: 'Trilha de auditoria da comunidade resolvida.',
    auth: true,
    mfa: true,
    tenantScope: 'resolved',
    tenantPermission: 'team:manage',
  },
  platformTenants: {
    method: 'GET',
    path: '/api/platform/tenants',
    summary: 'Lista de comunidades da plataforma.',
    auth: true,
    mfa: true,
    tenantScope: 'none',
    platformPermission: 'platform:tenant:read',
  },
  platformCreateTenant: {
    method: 'POST',
    path: '/api/platform/tenants',
    summary: 'Cria uma comunidade. DOC-01 secao 2, passo 1.',
    auth: true,
    mfa: true,
    tenantScope: 'none',
    platformPermission: 'platform:tenant:create',
  },
  // -------------------------------------------------------------------------
  // Fase 2 · vitrine publica de sorteios
  //
  // `auth: false` e `tenantScope: 'resolved'`: a vitrine existe sem sessao, mas
  // NUNCA sem comunidade. O middleware abre o contexto pelo dominio antes de
  // qualquer consulta, e sem contexto a RLS nao devolve linha nenhuma.
  // -------------------------------------------------------------------------
  publicDraws: {
    method: 'GET',
    path: '/api/public/draws',
    summary: 'Sorteios visiveis da comunidade resolvida.',
    auth: false,
    mfa: false,
    tenantScope: 'resolved',
  },
  publicDraw: {
    method: 'GET',
    path: '/api/public/draws/:slug',
    summary: 'Detalhe de um sorteio pelo slug.',
    auth: false,
    mfa: false,
    tenantScope: 'resolved',
  },
  publicDrawNumbers: {
    method: 'GET',
    path: '/api/public/draws/:id/numbers',
    summary: 'Numeros OCUPADOS do sorteio. Os livres sao derivados no cliente.',
    auth: false,
    mfa: false,
    tenantScope: 'resolved',
  },
  createReservation: {
    method: 'POST',
    path: '/api/public/draws/:id/reservations',
    summary: 'Reserva atomica de numeros por 30 minutos (RN05).',
    auth: false,
    mfa: false,
    tenantScope: 'resolved',
  },
  createOrder: {
    method: 'POST',
    path: '/api/public/orders',
    summary: 'Converte uma reserva em pedido com os dados do comprador.',
    auth: false,
    mfa: false,
    tenantScope: 'resolved',
  },
  publicOrder: {
    method: 'GET',
    path: '/api/public/orders/:id',
    summary: 'Comprovante do pedido.',
    auth: false,
    mfa: false,
    tenantScope: 'resolved',
  },
  devConfirmPayment: {
    method: 'POST',
    path: '/api/dev/orders/:id/confirm-payment',
    summary: 'Confirma pagamento SEM provedor. Recusada fora de desenvolvimento.',
    auth: false,
    mfa: false,
    tenantScope: 'resolved',
  },

  // -------------------------------------------------------------------------
  // Fase 2 · painel do organizador
  // -------------------------------------------------------------------------
  organizerDraws: {
    method: 'GET',
    path: '/api/tenant/draws',
    summary: 'Sorteios da comunidade, com numeros de venda.',
    auth: true,
    mfa: false,
    tenantScope: 'resolved',
    tenantPermission: 'tenant:read',
  },
  organizerDraw: {
    method: 'GET',
    path: '/api/tenant/draws/:id',
    summary: 'Detalhe de um sorteio para o painel.',
    auth: true,
    mfa: false,
    tenantScope: 'resolved',
    tenantPermission: 'tenant:read',
  },
  createDraw: {
    method: 'POST',
    path: '/api/tenant/draws',
    summary: 'Cria um sorteio em RASCUNHO.',
    auth: true,
    mfa: false,
    tenantScope: 'resolved',
    tenantPermission: 'draw:write',
  },
  updateDrawStatus: {
    method: 'POST',
    path: '/api/tenant/draws/:id/status',
    summary: 'Ativa, pausa ou encerra as vendas de um sorteio.',
    auth: true,
    mfa: false,
    tenantScope: 'resolved',
    tenantPermission: 'draw:lifecycle:write',
  },
} as const satisfies Record<string, RouteContract>;

export type RouteName = keyof typeof ROUTE_CONTRACTS;

export const ROUTE_NAMES = Object.keys(ROUTE_CONTRACTS) as readonly RouteName[];

/** Chave canonica "METHOD path", usada pelo teste de contrato. */
export function routeKey(contract: RouteContract): string {
  return `${contract.method} ${contract.path}`;
}

export const ROUTE_KEYS: readonly string[] = ROUTE_NAMES.map((name) =>
  routeKey(ROUTE_CONTRACTS[name]),
);
