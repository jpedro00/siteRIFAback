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
  INTERNAL: 'Erro interno. Tente novamente em instantes.',
});
