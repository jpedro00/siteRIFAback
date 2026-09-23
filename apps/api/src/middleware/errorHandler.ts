import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { API_ERROR_MESSAGES, type ApiErrorBody } from '@campaigns/shared';
import { TenantContextError } from '@campaigns/db';
import { ApiError } from '../lib/apiError.js';

/**
 * Tradutor final de erro.
 *
 * Erro inesperado vira 500 generico: mensagem de banco vazada na resposta
 * entrega nome de tabela, coluna e constraint para quem estiver sondando.
 * O detalhe fica no log do servidor, ligado ao request id.
 */
export function errorHandler() {
  return (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const requestId = req.context?.requestId ?? 'sem-id';

    if (error instanceof ApiError) {
      // `Retry-After` e a forma padrao de dizer QUANDO tentar de novo. Sem ele,
      // um cliente honesto so tem a opcao de insistir — que e exatamente o que o
      // limite esta tentando evitar.
      const details = error.details as { retryAfterSeconds?: unknown } | undefined;
      if (error.code === 'RATE_LIMITED' && typeof details?.retryAfterSeconds === 'number') {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(details.retryAfterSeconds))));
      }

      const body: ApiErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      };
      res.status(error.status).json(body);
      return;
    }

    if (error instanceof ZodError) {
      const body: ApiErrorBody = {
        error: {
          code: 'BAD_REQUEST',
          message: API_ERROR_MESSAGES.BAD_REQUEST,
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      };
      res.status(400).json(body);
      return;
    }

    if (error instanceof TenantContextError) {
      // Contexto de comunidade ausente ou malformado nega acesso; nao vira 500.
      console.error(`[${requestId}] contexto de comunidade invalido:`, error.message);
      const body: ApiErrorBody = {
        error: { code: 'TENANT_NOT_RESOLVED', message: API_ERROR_MESSAGES.TENANT_NOT_RESOLVED },
      };
      res.status(404).json(body);
      return;
    }

    console.error(`[${requestId}] erro nao tratado:`, error);
    const body: ApiErrorBody = {
      error: { code: 'INTERNAL', message: API_ERROR_MESSAGES.INTERNAL },
    };
    res.status(500).json(body);
  };
}

/** 404 padronizado para caminho inexistente. */
export function notFoundHandler() {
  return (_req: Request, res: Response): void => {
    const body: ApiErrorBody = {
      error: { code: 'NOT_FOUND', message: API_ERROR_MESSAGES.NOT_FOUND },
    };
    res.status(404).json(body);
  };
}
