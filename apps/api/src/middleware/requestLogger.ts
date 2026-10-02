import type { NextFunction, Request, Response } from 'express';
import { log } from '../lib/log.js';

/**
 * Uma linha de log por requisicao, ao terminar.
 *
 * O QUE ENTRA: `request_id`, `tenant_id`, metodo, caminho SEM query string, status
 * e duracao. O QUE NAO ENTRA: corpo, query, cabecalhos, cookie — e portanto nenhum
 * e-mail, telefone ou nome que o participante digitou. O caminho pode carregar
 * identificadores (uuid, slug), que nao sao dado pessoal.
 *
 * `/api/health` fica de fora: o Render o chama a cada poucos segundos e a linha
 * nao diz nada que o proprio health check nao diga.
 */
export function requestLogger() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const inicio = process.hrtime.bigint();

    res.on('finish', () => {
      const caminho = req.baseUrl + (req.route?.path ?? req.path);
      if (caminho.startsWith('/api/health')) return;

      const duracaoMs = Number((process.hrtime.bigint() - inicio) / 1_000_000n);
      const linha = {
        request_id: req.context?.requestId ?? null,
        tenant_id: req.tenant?.tenantId ?? null,
        method: req.method,
        // `req.route.path` e o padrao ("/api/tenant/draws/:id"), nao o valor: agrupa
        // no agregador e nao vaza o identificador na dimensao.
        path: caminho,
        status: res.statusCode,
        duration_ms: duracaoMs,
      };
      if (res.statusCode >= 500) log.error('requisicao', linha);
      else if (res.statusCode >= 400) log.warn('requisicao', linha);
      else log.info('requisicao', linha);
    });

    next();
  };
}
