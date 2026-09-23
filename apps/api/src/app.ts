import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import type { AppDeps } from './deps.js';
import { registerRoutes } from './http/registerRoutes.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { originGuard } from './middleware/originGuard.js';
import { requestContext } from './middleware/requestContext.js';

/**
 * Fabrica do aplicativo Express.
 *
 * Separada de `server.ts` para que os testes montem a API com o pool de teste
 * sem abrir porta.
 */
export function createApp(deps: AppDeps): Express {
  const app = express();

  // Necessario para `req.ip` refletir o cliente real atras do proxy do Render.
  // Sem isso a trilha de auditoria (RN11) registraria o IP do proxy.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(requestContext());

  // Controle de origem. Ver middleware/originGuard.ts.
  app.use(originGuard(deps));

  registerRoutes(app, deps);

  app.use(notFoundHandler());
  app.use(errorHandler());

  return app;
}
