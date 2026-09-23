import { z } from 'zod';

/**
 * Configuracao do worker.
 *
 * DUAS conexoes, ambas com o papel `app_worker`:
 *
 *   WORKER_DATABASE_URL  le a outbox, grava `event_consumptions` e executa o
 *                        efeito do consumidor. Nao e dono das tabelas de
 *                        negocio e nao tem BYPASSRLS.
 *
 *   QUEUE_DATABASE_URL   usada APENAS pelo pg-boss, que mantem as proprias
 *                        tabelas dentro do schema `pgboss`. O schema e criado
 *                        pela MIGRATION, com `app_worker` como dono (0007/0008):
 *                        a fila exerce POSSE sobre o proprio schema, nao
 *                        privilegio administrativo sobre o banco. Nenhuma
 *                        conexao de superusuario participa do runtime.
 *
 * POR QUE NAO `DATABASE_URL`: essa chave ja significa "a conexao da API" no
 * `.env` da raiz, e ela aponta para `app_user`. Um worker que lesse `DATABASE_URL`
 * subiria com o papel ERRADO a partir do arquivo de exemplo — e falharia no
 * primeiro `UPDATE outbox`, porque `app_user` nao tem esse privilegio (0006). Um
 * nome proprio torna impossivel a troca silenciosa.
 */
const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),

  WORKER_DATABASE_URL: z.string().min(1, 'WORKER_DATABASE_URL e obrigatoria.'),
  QUEUE_DATABASE_URL: z.string().min(1, 'QUEUE_DATABASE_URL e obrigatoria.'),
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /** Intervalo da varredura da outbox, em milissegundos. */
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  /** Eventos publicados por rodada. */
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(50),
  /** Tentativas do relay antes de o evento ir para inspecao manual. */
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  /** Base do recuo exponencial entre tentativas, em segundos. */
  OUTBOX_RETRY_BASE_SECONDS: z.coerce.number().int().positive().default(5),

  QUEUE_SCHEMA: z.string().default('pgboss'),
});

export type WorkerConfig = Readonly<z.infer<typeof configSchema>>;

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuracao do worker invalida:\n${issues}`);
  }
  return Object.freeze(parsed.data);
}
