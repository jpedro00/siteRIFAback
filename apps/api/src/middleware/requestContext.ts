import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Identificador e origem da requisicao.
 *
 * O IP entra na trilha de auditoria (RN11). Quando a API roda atras de proxy,
 * `trust proxy` precisa estar configurado em app.ts — sem isso, `req.ip` seria
 * sempre o IP do proxy e a trilha registraria a origem errada.
 */
export function requestContext() {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Um id que o cliente (ou o proxy) mandou so vale se tiver o formato esperado:
    // curto e sem caracteres que bagunçariam uma linha de log.
    const recebido = req.get('x-request-id');
    const requestId = recebido && /^[A-Za-z0-9._-]{8,64}$/.test(recebido) ? recebido : randomUUID();
    req.context = {
      requestId,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    };
    res.setHeader('x-request-id', requestId);
    next();
  };
}
