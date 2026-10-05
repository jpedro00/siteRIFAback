/**
 * Codigos de erro compartilhados entre API e frontends.
 *
 * Os frontends decidem o estado de tela (carregando, erro, acesso negado) a
 * partir destes codigos, nunca a partir do texto da mensagem.
 */
export const API_ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  /** Sessao valida, mas o segundo fator ainda nao foi satisfeito. RN12. */
  'MFA_REQUIRED',
  /** Perfil exige MFA e a conta ainda nao tem fator confirmado. RN12. */
  'MFA_ENROLLMENT_REQUIRED',
  /** Autenticado, sem a permissao exigida. */
  'FORBIDDEN',
  /**
   * Comunidade nao resolvida: dominio ou slug desconhecido.
   * Dominio desconhecido NUNCA cai numa comunidade padrao.
   */
  'TENANT_NOT_RESOLVED',
  /** Autenticado, porem sem vinculo ativo com a comunidade pedida. RN01. */
  'TENANT_ACCESS_DENIED',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  /** O provedor de pagamento esta fora do ar ou nao respondeu. Tente de novo. */
  'PAYMENT_PROVIDER_UNAVAILABLE',
  /** A cobranca da plataforma (Stripe) nao esta configurada ou fora do ar. Fase 7. */
  'BILLING_UNAVAILABLE',
  /**
   * A assinatura da comunidade nao permite esta operacao comercial (sem assinatura,
   * pendente, em atraso fora da tolerancia, cancelada...). `details.reason`. Fase 7.
   */
  'SUBSCRIPTION_REQUIRED',
  /** O limite do plano foi atingido (sorteios ou equipe). `details`: reason, used, max. */
  'PLAN_LIMIT_REACHED',
  /** A funcionalidade nao faz parte do plano contratado. */
  'FEATURE_NOT_IN_PLAN',
  /** A comunidade ainda nao conectou uma conta de recebimento: nao ha como cobrar. Fase 7. */
  'PAYMENTS_NOT_CONFIGURED',
  /** A conta de recebimento existe, mas a autorizacao esta invalida, vencida, revogada ou desconectando. */
  'PAYMENT_ACCOUNT_UNAVAILABLE',
  'INTERNAL',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  readonly error: {
    readonly code: ApiErrorCode;
    /** Mensagem em portugues, destinada a interface. */
    readonly message: string;
    readonly details?: unknown;
  };
}

export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = Object.freeze({
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  MFA_REQUIRED: 403,
  MFA_ENROLLMENT_REQUIRED: 403,
  FORBIDDEN: 403,
  TENANT_NOT_RESOLVED: 404,
  /**
   * 404, nao 403: um usuario da comunidade A pedindo recurso da comunidade B
   * nao deve conseguir confirmar que B existe. DOC-01 secao 21.
   */
  TENANT_ACCESS_DENIED: 404,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PAYMENT_PROVIDER_UNAVAILABLE: 503,
  BILLING_UNAVAILABLE: 503,
  SUBSCRIPTION_REQUIRED: 403,
  PLAN_LIMIT_REACHED: 409,
  FEATURE_NOT_IN_PLAN: 403,
  PAYMENTS_NOT_CONFIGURED: 503,
  PAYMENT_ACCOUNT_UNAVAILABLE: 503,
  INTERNAL: 500,
});

/** Mensagens padrao em portugues. */
export const API_ERROR_MESSAGES: Readonly<Record<ApiErrorCode, string>> = Object.freeze({
  BAD_REQUEST: 'Requisição inválida.',
  UNAUTHENTICATED: 'Faça login para continuar.',
  MFA_REQUIRED: 'Confirme a verificação em duas etapas para continuar.',
  MFA_ENROLLMENT_REQUIRED: 'Seu perfil exige verificação em duas etapas. Cadastre o segundo fator.',
  FORBIDDEN: 'Você não tem permissão para esta ação.',
  TENANT_NOT_RESOLVED: 'Comunidade não encontrada.',
  TENANT_ACCESS_DENIED: 'Comunidade não encontrada.',
  NOT_FOUND: 'Recurso não encontrado.',
  CONFLICT: 'A operação conflita com o estado atual.',
  RATE_LIMITED: 'Muitas tentativas. Aguarde e tente novamente.',
  PAYMENT_PROVIDER_UNAVAILABLE:
    'Não foi possível gerar o PIX agora. Seus números continuam reservados; tente novamente.',
  BILLING_UNAVAILABLE: 'A contratação de planos não está disponível agora. Tente novamente mais tarde.',
  SUBSCRIPTION_REQUIRED: 'A assinatura da comunidade não permite esta operação.',
  PLAN_LIMIT_REACHED: 'O limite do plano foi atingido.',
  FEATURE_NOT_IN_PLAN: 'Esta funcionalidade não está incluída no plano da comunidade.',
  PAYMENTS_NOT_CONFIGURED: 'Esta comunidade ainda não habilitou o recebimento de pagamentos.',
  PAYMENT_ACCOUNT_UNAVAILABLE: 'O recebimento de pagamentos desta comunidade está indisponível no momento.',
  INTERNAL: 'Erro interno. Tente novamente em instantes.',
});
