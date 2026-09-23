import type { DbPool } from '@campaigns/db';
import type { AppConfig } from './config.js';
import type { LoginThrottle } from './lib/loginThrottle.js';
import type { SecretBox } from './lib/secretBox.js';

/** Dependencias injetadas nas rotas. Facilita trocar o pool nos testes. */
export interface AppDeps {
  readonly config: AppConfig;
  readonly pool: DbPool;
  readonly secretBox: SecretBox;
  /**
   * Limite de tentativas por origem, anterior a autenticacao.
   *
   * Injetado, e nao criado dentro do servico, porque guarda ESTADO: cada
   * bancada de teste precisa do proprio balde, senao um teste herdaria o
   * orcamento ja gasto por outro.
   */
  readonly loginThrottle: LoginThrottle;
}
