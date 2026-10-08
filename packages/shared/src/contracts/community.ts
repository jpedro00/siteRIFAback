import { z } from 'zod';
import { hexColorSchema, imageRefSchema, publicDrawSummarySchema } from './draws.js';

/**
 * Comunidade: marca, contatos, paginas institucionais, imagens e compradores.
 * Fase 7 · acabamento de entrega (M01/M02).
 */

/** Paginas institucionais que a vitrine mostra. Texto simples, sem HTML. */
export const COMMUNITY_PAGE_KEYS = ['about', 'howItWorks', 'terms', 'privacy', 'contact'] as const;
export type CommunityPageKey = (typeof COMMUNITY_PAGE_KEYS)[number];
export const COMMUNITY_PAGE_LABELS: Readonly<Record<CommunityPageKey, string>> = Object.freeze({
  about: 'Sobre',
  howItWorks: 'Como funciona',
  terms: 'Termos de uso',
  privacy: 'Privacidade',
  contact: 'Contato',
});

const shortText = (max: number) => z.string().trim().max(max);

export const communityContactSchema = z
  .object({
    whatsapp: shortText(30).optional(),
    phone: shortText(30).optional(),
    email: z.string().trim().email().max(320).optional().or(z.literal('')),
    instagram: shortText(120).optional(),
    facebook: shortText(200).optional(),
  })
  .strict();
export type CommunityContact = z.infer<typeof communityContactSchema>;

/** O que o organizador edita. Texto vazio apaga o campo. */
export const updateCommunityRequestSchema = z
  .object({
    publicName: shortText(120).optional(),
    description: shortText(600).optional(),
    footerText: shortText(300).optional(),
    logoUrl: imageRefSchema.or(z.literal('')).optional(),
    bannerUrl: imageRefSchema.or(z.literal('')).optional(),
    primaryColor: hexColorSchema.or(z.literal('')).optional(),
    contact: communityContactSchema.optional(),
    pages: z
      .object({
        about: z.string().max(10000).optional(),
        howItWorks: z.string().max(10000).optional(),
        terms: z.string().max(20000).optional(),
        privacy: z.string().max(20000).optional(),
        contact: z.string().max(5000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type UpdateCommunityRequest = z.infer<typeof updateCommunityRequestSchema>;

export const communityContentSchema = z.object({
  publicName: z.string().nullable(),
  description: z.string().nullable(),
  footerText: z.string().nullable(),
  logoUrl: z.string().nullable(),
  bannerUrl: z.string().nullable(),
  primaryColor: z.string().nullable(),
  contact: z.record(z.string()),
  pages: z.record(z.string()),
});
export type CommunityContent = z.infer<typeof communityContentSchema>;

// ---------------------------------------------------------------------------
// Imagens
// ---------------------------------------------------------------------------
export const MEDIA_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** Tamanho maximo da imagem DEPOIS de decodificada. O navegador reduz antes de enviar. */
export const MEDIA_MAX_BYTES = 2 * 1024 * 1024;

export const uploadMediaRequestSchema = z.object({
  contentType: z.enum(MEDIA_CONTENT_TYPES),
  /** Conteudo em base64, sem o prefixo `data:`. */
  dataBase64: z.string().min(16).max(Math.ceil((MEDIA_MAX_BYTES * 4) / 3) + 8),
});
export type UploadMediaRequest = z.infer<typeof uploadMediaRequestSchema>;

export const uploadMediaResponseSchema = z.object({
  id: z.string().uuid(),
  /** Caminho a guardar no campo de imagem: `/api/public/media/<id>`. */
  url: z.string(),
  byteSize: z.number().int().positive(),
});
export type UploadMediaResponse = z.infer<typeof uploadMediaResponseSchema>;

// ---------------------------------------------------------------------------
// Compradores
// ---------------------------------------------------------------------------
/** Vitrine: quem comprou (somente PAGO), com o nome MASCARADO ("Maria S."). */
export const publicDrawBuyersResponseSchema = z.object({
  buyers: z.array(
    z.object({
      name: z.string(),
      quantity: z.number().int().positive(),
      paidAt: z.string(),
    }),
  ),
});
export type PublicDrawBuyersResponse = z.infer<typeof publicDrawBuyersResponseSchema>;

/** Painel: comprador da comunidade com o resumo de todos os pedidos. */
export const tenantBuyerSchema = z.object({
  buyerId: z.string().uuid(),
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  orders: z.number().int().nonnegative(),
  paidOrders: z.number().int().nonnegative(),
  numbers: z.number().int().nonnegative(),
  totalPaidCents: z.number().int().nonnegative(),
  lastOrderAt: z.string().nullable(),
  draws: z.array(z.object({ title: z.string(), slug: z.string() })),
});
export type TenantBuyer = z.infer<typeof tenantBuyerSchema>;

export const tenantBuyersResponseSchema = z.object({
  buyers: z.array(tenantBuyerSchema),
  nextCursor: z.string().nullable(),
});
export type TenantBuyersResponse = z.infer<typeof tenantBuyersResponseSchema>;

// ---------------------------------------------------------------------------
// Financeiro: observacao/status de revisao
// ---------------------------------------------------------------------------
export const RECONCILIATION_REVIEW_STATUSES = ['ABERTA', 'EM_ANALISE', 'RESOLVIDA_MANUALMENTE'] as const;
export type ReconciliationReviewStatus = (typeof RECONCILIATION_REVIEW_STATUSES)[number];
export const RECONCILIATION_REVIEW_LABELS: Readonly<Record<ReconciliationReviewStatus, string>> = Object.freeze({
  ABERTA: 'Aberta',
  EM_ANALISE: 'Em análise',
  RESOLVIDA_MANUALMENTE: 'Resolvida manualmente',
});

export const reviewReconciliationRequestSchema = z.object({
  status: z.enum(RECONCILIATION_REVIEW_STATUSES),
  note: z.string().trim().max(2000).optional(),
});
export type ReviewReconciliationRequest = z.infer<typeof reviewReconciliationRequestSchema>;

// ---------------------------------------------------------------------------
// Onboarding self-service de criadores (identidade GLOBAL: sem segunda conta)
// ---------------------------------------------------------------------------
/** Enderecos que nunca podem virar identificador de comunidade (rotas e servicos da plataforma). */
export const RESERVED_COMMUNITY_SLUGS = [
  'admin', 'api', 'app', 'www', 'painel', 'organizer', 'organizador', 'storefront', 'vitrine',
  'login', 'cadastro', 'conta', 'suporte', 'support', 'status', 'mail', 'static', 'assets',
  'rifas', 'sorteios', 'criador', 'plataforma', 'clubedarifa', 'tironirifa',
] as const;

export const creatorSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Use letras minúsculas, números e hífen.')
  .refine((v) => !(RESERVED_COMMUNITY_SLUGS as readonly string[]).includes(v), {
    message: 'Este endereço é reservado. Escolha outro.',
  });

export const createCreatorCommunityRequestSchema = z.object({
  name: z.string().trim().min(2).max(160),
  slug: creatorSlugSchema,
  contact: z
    .object({
      whatsapp: shortText(30).optional(),
      phone: shortText(30).optional(),
      email: z.string().trim().toLowerCase().email().max(320).optional(),
    })
    .strict()
    .optional(),
});
export type CreateCreatorCommunityRequest = z.infer<typeof createCreatorCommunityRequestSchema>;

export const createCreatorCommunityResponseSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  status: z.string(),
  createdAt: z.string(),
  /** `false` quando o pedido foi repetido e a comunidade ja existia (idempotencia). */
  created: z.boolean(),
});
export type CreateCreatorCommunityResponse = z.infer<typeof createCreatorCommunityResponseSchema>;

// ---------------------------------------------------------------------------
// Marketplace universal (leitura publica entre comunidades)
// ---------------------------------------------------------------------------
/** Rifa publica do marketplace: o mesmo resumo da vitrine + de quem e. */
export const marketplaceDrawSchema = publicDrawSummarySchema.extend({
  tenantSlug: z.string(),
  tenantName: z.string(),
  tenantLogoUrl: z.string().nullable(),
});
export type MarketplaceDraw = z.infer<typeof marketplaceDrawSchema>;

export const marketplaceDrawListResponseSchema = z.object({
  draws: z.array(marketplaceDrawSchema),
  nextCursor: z.string().nullable(),
});
export type MarketplaceDrawListResponse = z.infer<typeof marketplaceDrawListResponseSchema>;

export const marketplaceCreatorSchema = z.object({
  slug: z.string(),
  name: z.string(),
  logoUrl: z.string().nullable(),
  description: z.string().nullable(),
  publicDraws: z.number().int().nonnegative(),
  activeDraws: z.number().int().nonnegative(),
});
export type MarketplaceCreator = z.infer<typeof marketplaceCreatorSchema>;

export const marketplaceCreatorListResponseSchema = z.object({
  creators: z.array(marketplaceCreatorSchema),
  nextCursor: z.string().nullable(),
});
export type MarketplaceCreatorListResponse = z.infer<typeof marketplaceCreatorListResponseSchema>;

/** Perfil publico do criador: marca + as rifas publicas dele. */
export const marketplaceCreatorProfileSchema = z.object({
  creator: marketplaceCreatorSchema.extend({
    bannerUrl: z.string().nullable(),
    contact: z.record(z.string()),
  }),
  draws: z.array(marketplaceDrawSchema),
  nextCursor: z.string().nullable(),
});
export type MarketplaceCreatorProfile = z.infer<typeof marketplaceCreatorProfileSchema>;
