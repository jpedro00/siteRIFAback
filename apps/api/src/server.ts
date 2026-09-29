import { createPool, loadRootEnv } from '@clubedarifa/db';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { LoginThrottle } from './lib/loginThrottle.js';
import { SecretBox } from './lib/secretBox.js';
import { createPspGateway } from '@clubedarifa/psp';

/** Entrada do processo da API. */
async function main(): Promise<void> {
  // Desenvolvimento local: carrega o `.env` privado da raiz. Em Render o arquivo
  // nao existe e as variaveis injetadas pelo servico continuam tendo precedencia.
  await loadRootEnv();
  const config = loadConfig();

  const pool = createPool({
    connectionString: config.DATABASE_URL,
    applicationName: 'clubedarifa-api',
    ssl: config.DATABASE_SSL,
  });

  const app = createApp({
    config,
    pool,
    secretBox: new SecretBox(config.MFA_ENCRYPTION_KEY),
    psp: createPspGateway(config),
    loginThrottle: new LoginThrottle({
      windowMs: config.LOGIN_ORIGIN_WINDOW_MINUTES * 60_000,
      maxFailures: config.LOGIN_ORIGIN_MAX_FAILURES,
      maxDistinctAccounts: config.LOGIN_ORIGIN_MAX_ACCOUNTS,
    }),
  });

  const server = app.listen(config.PORT, () => {
    console.log(
      `[api] ouvindo na porta ${config.PORT} (${config.NODE_ENV}); ` +
        `origens declaradas: ${config.corsOrigins.length}; ` +
        `cabecalho de comunidade: ${config.TENANT_HEADER_ENABLED ? 'ligado' : 'desligado'}; ` +
        `pagamento: ${config.PSP_PROVIDER}`,
    );
  });

  // Encerramento limpo: para de aceitar conexoes novas e fecha o pool, para
  // nao deixar transacao pela metade num deploy.
  const shutdown = (signal: string): void => {
    console.log(`recebido ${signal}, encerrando...`);
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main().catch((error: unknown) => {
  console.error('[api] falhou ao subir:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
