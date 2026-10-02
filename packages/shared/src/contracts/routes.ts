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
  nextCursor: z.string().nullable(),
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
  nextCursor: z.string().nullable(),
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
   * Dono da comunidade, por e-mail.
   *
   * Uma comunidade sem dono e uma comunidade que ninguem consegue operar. Por isso
   * o dono entra na MESMA transacao da criacao — ou nascem os dois, ou nao nasce
   * nenhum:
   *   - e-mail de conta EXISTENTE  -> a pessoa vira dona na hora;
   *   - e-mail sem conta           -> nasce um CONVITE de dono, valido por 7 dias;
   *     ao aceitar (depois de se cadastrar), a pessoa passa a ser dona.
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
  /** Preenchido quando o e-mail ja tinha conta: a pessoa ja e dona. */
  owner: z
    .object({
      userId: z.string().uuid(),
      email: z.string(),
      displayName: z.string(),
    })
    .nullable(),
  /** Preenchido quando o e-mail NAO tinha conta: convite de dono. O token aparece so aqui. */
  ownerInvitation: z
    .object({ id: z.string().uuid(), email: z.string(), expiresAt: z.string(), token: z.string() })
    .nullable(),
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

/**
 * Saude da API. `status`:
 *  - ok       banco no ar, worker em dia (ou ainda sem historico)
 *  - degraded banco no ar, mas algum job do worker esta atrasado
 *  - down     banco fora: a API nao consegue atender (HTTP 503)
 * `worker` e o resumo dos heartbeats: ok | stale (algum ciclo atrasado mais de 3x
 * o intervalo) | unknown (nenhum job ainda registrou ciclo).
 */
export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  database: z.enum(['up', 'down']),
  worker: z.enum(['ok', 'stale', 'unknown']),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

const nullableDate = z.string().nullable();

/** Console Super Admin · Saude: o ultimo ciclo de cada job, dead-letter e conciliacao. */
export const platformHealthResponseSchema = z.object({
  generatedAt: z.string(),
  worker: z.enum(['ok', 'stale', 'unknown']),
  jobs: z.array(
    z.object({
      name: z.string(),
      intervalSeconds: z.number().int().positive(),
      lastStartedAt: nullableDate,
      lastFinishedAt: nullableDate,
      lastSuccessAt: nullableDate,
      lastDurationMs: z.number().int().nullable(),
      lastCount: z.number().int().nullable(),
      lastError: z.string().nullable(),
      consecutiveFailures: z.number().int().nonnegative(),
      /** Nenhum ciclo terminou em mais de 3x o intervalo. */
      stale: z.boolean(),
    }),
  ),
  /** Eventos que esgotaram as tentativas do relay e esperam inspecao humana. */
  deadLetter: z.object({ count: z.number().int().nonnegative(), oldestAt: nullableDate }),
  /** Eventos ainda nao publicados: um backlog que cresce e sinal de relay parado. */
  outboxPending: z.object({ count: z.number().int().nonnegative(), oldestAt: nullableDate }),
  reconciliation: z.object({
    openIssues: z.number().int().nonnegative(),
    manualRefunds: z.number().int().nonnegative(),
  }),
  /** Fase 7 · eventos da Stripe que nao concluiram (sem o payload cru). */
  stripeEvents: z.object({
    failed: z.number().int().nonnegative(),
    dead: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    oldestProblemAt: nullableDate,
  }),
  /** Fase 7 · contas de recebimento por comunidade. Nunca carrega credencial. */
  paymentAccounts: z.object({
    authorizationsError: z.number().int().nonnegative(),
    authorizationsRevoked: z.number().int().nonnegative(),
    accountsDisconnecting: z.number().int().nonnegative(),
    /** Divergencias `PAYMENT_AUTHORIZATION_UNAVAILABLE` em aberto (as mais antigas primeiro). */
    unavailableIssues: z.object({
      count: z.number().int().nonnegative(),
      items: z.array(
        z.object({
          id: z.string(),
          tenantName: z.string(),
          tenantSlug: z.string(),
          /** Referencia curta e segura da operacao (prefixo do ID do pedido). */
          reference: z.string(),
          detectedAt: z.string(),
        }),
      ),
    }),
  }),
});
export type PlatformHealthResponse = z.infer<typeof platformHealthResponseSchema>;

/**
 * Console Super Admin · Financeiro: divergencias da conciliacao (PSP x pedidos) ABERTAS.
 * Somente leitura. Como na Saude, nenhum identificador completo de pagamento ou pedido sai
 * daqui: `reference` sao os 8 primeiros caracteres do pedido, o suficiente para o suporte
 * localizar o caso sem expor a chave.
 */
export const RECONCILIATION_KINDS = [
  'APPROVED_ORDER_NOT_PAID',
  'ORDER_PAID_PAYMENT_NOT_APPROVED',
  'PSP_APPROVED_LOCAL_PENDING',
  'MANUAL_REFUND_OPEN',
  'PAYMENT_AUTHORIZATION_UNAVAILABLE',
] as const;
export type ReconciliationKind = (typeof RECONCILIATION_KINDS)[number];

export const reconciliationIssueSchema = z.object({
  kind: z.enum(RECONCILIATION_KINDS),
  tenantSlug: z.string(),
  tenantName: z.string(),
  reference: z.string(),
  amountCents: z.number().int().nonnegative(),
  paymentStatus: z.string(),
  needsManualRefund: z.boolean(),
  detectedAt: z.string(),
});
export type ReconciliationIssue = z.infer<typeof reconciliationIssueSchema>;

export const platformReconciliationResponseSchema = z.object({
  generatedAt: z.string(),
  openCount: z.number().int().nonnegative(),
  byKind: z.array(z.object({ kind: z.enum(RECONCILIATION_KINDS), count: z.number().int().nonnegative() })),
  /** As mais recentes (ate 100). */
  issues: z.array(reconciliationIssueSchema),
});
export type PlatformReconciliationResponse = z.infer<typeof platformReconciliationResponseSchema>;

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
  platformHealth: {
    method: 'GET',
    path: '/api/platform/health',
    summary: 'Saúde do worker: último ciclo de cada job, dead-letter e conciliação.',
    auth: true,
    mfa: true,
    tenantScope: 'none',
    platformPermission: 'platform:health:read',
  },
  platformReconciliation: {
    method: 'GET',
    path: '/api/platform/reconciliation',
    summary: 'Divergências abertas da conciliação (PSP x pedidos), por comunidade. Somente leitura.',
    auth: true,
    mfa: true,
    tenantScope: 'none',
    platformPermission: 'platform:billing:read',
  },
  // Fase 7 · catalogo de planos e assinaturas (Super Admin / PLATFORM_FINANCE).
  platformPlans: {
    method: 'GET',
    path: '/api/platform/plans',
    summary: 'Catálogo de planos com os identificadores da Stripe (Super Admin).',
    auth: true,
    mfa: true,
    tenantScope: 'none',
    platformPermission: 'platform:billing:read',
  },
  platformCreatePlan: {
    method: 'POST',
    path: '/api/platform/plans',
    summary:
      'Cria um plano: o servidor cria o Product e o Price na Stripe e grava os IDs resultantes. Nasce como rascunho; repetir o pedido retoma a sincronização.',
    auth: true,
    mfa: true,
    tenantScope: 'none',
    platformPermission: 'platform:billing:manage',
  },
  platformUpdatePlan: {
    method: 'PATCH',
    path: '/api/platform/plans/:id',
    summary: 'Edita nome, descrição, limites, funcionalidades e status. Preço não muda: preço novo é plano novo.',
    auth: true,
    mfa: true,
    tenantScope: 'none',
    platformPermission: 'platform:billing:manage',
  },
  platformSubscriptions: {
    method: 'GET',
    path: '/api/platform/subscriptions',
    summary: 'Assinaturas de todas as comunidades (somente leitura), com filtro por estado e busca, paginadas.',
    auth: true,
    mfa: true,
    tenantScope: 'none',
    platformPermission: 'platform:billing:read',
  },
  platformReviewQueue: {
    method: 'GET',
    path: '/api/platform/draws/review',
    summary: 'Fila de sorteios em REVISÃO COMPLIANCE, de todas as comunidades.',
    auth: true,
    mfa: true,
    tenantScope: 'none',
    platformPermission: 'platform:review:read',
  },
  platformReviewDecide: {
    method: 'POST',
    path: '/api/platform/draws/:id/review',
    summary: 'Aprova (ATIVA ou AGENDADA) ou reprova (RASCUNHO, com motivo) um sorteio. RN02.',
    auth: true,
    mfa: true,
    tenantScope: 'none',
    platformPermission: 'platform:review:decide',
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
  publicDrawResult: {
    method: 'GET',
    path: '/api/public/draws/:slug/result',
    summary: 'Página pública do resultado: número, nome mascarado, fonte, data e hash.',
    auth: false,
    mfa: false,
    tenantScope: 'resolved',
  },
  publicOrderPayment: {
    method: 'POST',
    path: '/api/public/orders/:id/payment',
    summary: 'Gera (ou devolve) o PIX do pedido. Idempotente: a chave e o pedido.',
    auth: false,
    mfa: false,
    tenantScope: 'resolved',
  },
  mercadopagoWebhook: {
    method: 'POST',
    path: '/api/webhooks/mercadopago/:tenant',
    summary:
      'Notificacao do Mercado Pago. Assinatura validada; o pagamento e CONSULTADO na API do PSP antes de valer.',
    auth: false,
    mfa: false,
    tenantScope: 'none',
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
  tenantDashboard: {
    method: 'GET',
    path: '/api/tenant/dashboard',
    summary: 'Indicadores do organizador: vendidos, arrecadado, reservas, PIX pendentes, vendas por dia.',
    auth: true,
    mfa: false,
    tenantScope: 'resolved',
    tenantPermission: 'tenant:read',
  },
  organizerDrawOrders: {
    method: 'GET',
    path: '/api/tenant/draws/:id/orders',
    summary: 'Pedidos de um sorteio, paginados. Contato do comprador só com buyer:read:full.',
    auth: true,
    mfa: false,
    tenantScope: 'resolved',
    tenantPermission: 'payment:read:status',
  },
  exportDrawOrders: {
    method: 'GET',
    path: '/api/tenant/draws/:id/orders/export',
    summary: 'CSV dos pedidos de um sorteio. Carrega dado pessoal: exige buyer:read:full.',
    auth: true,
    mfa: false,
    tenantScope: 'resolved',
    tenantPermission: 'buyer:read:full',
  },
  tenantTeam: {
    method: 'GET',
    path: '/api/tenant/team',
    summary: 'Equipe da comunidade e convites em aberto.',
    auth: true,
    mfa: true,
    tenantScope: 'resolved',
    tenantPermission: 'team:manage',
  },
  inviteTeamMember: {
    method: 'POST',
    path: '/api/tenant/team/invitations',
    summary: 'Convida alguém para a equipe. Válido por 7 dias; reenviar revoga o anterior.',
    auth: true,
    mfa: true,
    tenantScope: 'resolved',
    tenantPermission: 'team:manage',
  },
  revokeTeamInvitation: {
    method: 'DELETE',
    path: '/api/tenant/team/invitations/:id',
    summary: 'Revoga um convite em aberto.',
    auth: true,
    mfa: true,
    tenantScope: 'resolved',
    tenantPermission: 'team:manage',
  },
  changeTeamMemberRole: {
    method: 'PATCH',
    path: '/api/tenant/team/members/:id',
    summary: 'Troca o papel de um membro. O vínculo antigo é revogado e um novo é criado.',
    auth: true,
    mfa: true,
    tenantScope: 'resolved',
    tenantPermission: 'team:manage',
  },
  removeTeamMember: {
    method: 'DELETE',
    path: '/api/tenant/team/members/:id',
    summary: 'Remove um membro (revoga o vínculo). Efeito imediato.',
    auth: true,
    mfa: true,
    tenantScope: 'resolved',
    tenantPermission: 'team:manage',
  },
  invitationPreview: {
    method: 'GET',
    path: '/api/auth/invitations/:token',
    summary: 'Prévia de um convite pelo token: comunidade, papel e situação.',
    auth: false,
    mfa: false,
    tenantScope: 'none',
  },
  acceptInvitation: {
    method: 'POST',
    path: '/api/auth/invitations/:token/accept',
    summary: 'Aceita o convite. Exige sessão cujo e-mail seja o do convite.',
    auth: true,
    mfa: false,
    tenantScope: 'none',
  },
  organizerDrawResult: {
    method: 'GET',
    path: '/api/tenant/draws/:id/result',
    summary: 'Resultado do sorteio, com o pedido contemplado.',
    auth: true,
    mfa: false,
    tenantScope: 'resolved',
    tenantPermission: 'tenant:read',
  },
  publishDrawResult: {
    method: 'POST',
    path: '/api/tenant/draws/:id/result',
    summary: 'Publica o resultado (número da Loteria Federal + evidência). RN09 · RN20.',
    auth: true,
    mfa: true,
    tenantScope: 'resolved',
    tenantPermission: 'draw:lifecycle:write',
  },
  correctDrawResult: {
    method: 'POST',
    path: '/api/tenant/draws/:id/result/correction',
    summary: 'Corrige o resultado: cria nova versão; a anterior fica retificada. RN09.',
    auth: true,
    mfa: true,
    tenantScope: 'resolved',
    tenantPermission: 'draw:lifecycle:write',
  },
  recordDrawDelivery: {
    method: 'POST',
    path: '/api/tenant/draws/:id/delivery',
    summary: 'Registra (ou corrige) a entrega do prêmio, com o resultado publicado. DOC-01 §15 · RN30.',
    auth: true,
    mfa: false,
    tenantScope: 'resolved',
    tenantPermission: 'draw:lifecycle:write',
  },
  updateDraw: {
    method: 'PATCH',
    path: '/api/tenant/draws/:id',
    summary: 'Edita um sorteio em RASCUNHO (preço, grade, prêmios, cronograma).',
    auth: true,
    mfa: false,
    tenantScope: 'resolved',
    tenantPermission: 'draw:write',
  },
  updateDrawStatus: {
    method: 'POST',
    path: '/api/tenant/draws/:id/status',
    summary: 'Envia para revisão, pausa, retoma ou encerra as vendas de um sorteio.',
    auth: true,
    mfa: false,
    tenantScope: 'resolved',
    tenantPermission: 'draw:lifecycle:write',
  },

  // -------------------------------------------------------------------------
  // Fase 7 · assinatura da PLATAFORMA (Stripe Billing). Fluxo A: nada aqui toca
  // pedidos, pagamentos de participantes nem o PSP dos sorteios.
  // -------------------------------------------------------------------------
  tenantBillingPlans: {
    method: 'GET',
    path: '/api/tenant/billing/plans',
    summary: 'Planos à venda (nome, preço, periodicidade, limites e funcionalidades).',
    auth: true,
    mfa: false,
    tenantScope: 'resolved',
    tenantPermission: 'billing:read',
  },
  tenantBilling: {
    method: 'GET',
    path: '/api/tenant/billing',
    summary: 'Minha assinatura: estado, plano, renovação e histórico de faturas (paginado).',
    auth: true,
    mfa: false,
    tenantScope: 'resolved',
    tenantPermission: 'billing:read',
  },
  tenantEntitlements: {
    method: 'GET',
    path: '/api/tenant/billing/entitlements',
    summary: 'Limites do plano e consumo (sorteios ativos, equipe), com o veredito do envio para revisão.',
    auth: true,
    mfa: false,
    tenantScope: 'resolved',
    tenantPermission: 'billing:read',
  },
  tenantBillingCheckout: {
    method: 'POST',
    path: '/api/tenant/billing/checkout',
    summary: 'Contrata um plano: recebe só o planId e devolve a URL do Stripe Checkout. Voltar dela não libera nada.',
    auth: true,
    mfa: true,
    tenantScope: 'resolved',
    tenantPermission: 'billing:manage',
  },
  tenantBillingPortal: {
    method: 'POST',
    path: '/api/tenant/billing/portal',
    summary: 'Abre o Stripe Customer Portal (forma de pagamento, faturas, cancelamento e troca de plano).',
    auth: true,
    mfa: true,
    tenantScope: 'resolved',
    tenantPermission: 'billing:manage',
  },
  // -------------------------------------------------------------------------
  // Fase 7 · recebimentos por comunidade (FLUXO B). Mercado Pago por OAuth.
  // -------------------------------------------------------------------------
  tenantPaymentAccounts: {
    method: 'GET',
    path: '/api/tenant/payment-accounts',
    summary: 'Contas de recebimento da comunidade: estado, autorizacao e pendencias. Nunca devolve credencial.',
    auth: true,
    mfa: false,
    tenantScope: 'resolved',
    tenantPermission: 'payment_account:read',
  },
  tenantPaymentMethods: {
    method: 'GET',
    path: '/api/tenant/payment-methods',
    summary:
      'Meios de pagamento da conta conectada: o que o provedor oferece e o que a plataforma liga (hoje, só PIX). Boleto fica desligado.',
    auth: true,
    mfa: false,
    tenantScope: 'resolved',
    tenantPermission: 'payment_account:read',
  },
  connectPaymentAccount: {
    method: 'POST',
    path: '/api/tenant/payment-accounts/connect',
    summary: 'Inicia a conexao OAuth e devolve a URL de autorizacao do provedor (state + PKCE). Nao existe entrada manual de token.',
    auth: true,
    mfa: true,
    tenantScope: 'resolved',
    tenantPermission: 'payment_account:manage',
  },
  paymentAccountOAuthCallback: {
    method: 'GET',
    path: '/api/payment-accounts/oauth/callback',
    summary:
      'Retorno do provedor apos a autorizacao. Confere a tentativa persistida (state, PKCE, usuario, comunidade) e devolve um redirect para o painel.',
    auth: true,
    mfa: false,
    tenantScope: 'none',
  },
  disconnectPaymentAccount: {
    method: 'POST',
    path: '/api/tenant/payment-accounts/:id/disconnect',
    summary: 'Desconecta a conta: bloqueia pagamentos novos na hora e conclui quando nada mais pende.',
    auth: true,
    mfa: true,
    tenantScope: 'resolved',
    tenantPermission: 'payment_account:manage',
  },
  stripeWebhook: {
    method: 'POST',
    path: '/api/webhooks/stripe',
    summary:
      'Webhook da Stripe (separado do Mercado Pago). Assinatura validada sobre o corpo bruto; responde 2xx só depois de gravar o evento com durabilidade.',
    auth: false,
    mfa: false,
    tenantScope: 'none',
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
