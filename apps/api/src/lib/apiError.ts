import { API_ERROR_MESSAGES, API_ERROR_STATUS, type ApiErrorCode } from '@campaigns/shared';

/**
 * Erro com codigo de contrato. Os frontends decidem o estado de tela pelo
 * codigo, nunca pelo texto.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ApiErrorCode, message?: string, details?: unknown) {
    super(message ?? API_ERROR_MESSAGES[code]);
    this.name = 'ApiError';
    this.code = code;
    this.status = API_ERROR_STATUS[code];
    this.details = details;
  }

  static unauthenticated(message?: string): ApiError {
    return new ApiError('UNAUTHENTICATED', message);
  }

  static forbidden(message?: string): ApiError {
    return new ApiError('FORBIDDEN', message);
  }

  static mfaRequired(): ApiError {
    return new ApiError('MFA_REQUIRED');
  }

  static mfaEnrollmentRequired(): ApiError {
    return new ApiError('MFA_ENROLLMENT_REQUIRED');
  }

  static tenantNotResolved(): ApiError {
    return new ApiError('TENANT_NOT_RESOLVED');
  }

  /**
   * Usuario autenticado pedindo comunidade sem vinculo.
   *
   * Responde 404, nao 403: um 403 confirmaria que a comunidade existe. DOC-01
   * secao 21 exige 404 para o usuario de A acessando recurso de B.
   */
  static tenantAccessDenied(): ApiError {
    return new ApiError('TENANT_ACCESS_DENIED');
  }

  static badRequest(message?: string, details?: unknown): ApiError {
    return new ApiError('BAD_REQUEST', message, details);
  }

  static notFound(message?: string): ApiError {
    return new ApiError('NOT_FOUND', message);
  }

  static conflict(message?: string): ApiError {
    return new ApiError('CONFLICT', message);
  }

  static rateLimited(message?: string, details?: unknown): ApiError {
    return new ApiError('RATE_LIMITED', message, details);
  }
}
