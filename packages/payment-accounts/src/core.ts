import type { DbPool } from '@clubedarifa/db';
import type { PaymentEnvironment } from '@clubedarifa/shared';
import type { PaymentCredentialCipher } from './cipher.js';
import type { MercadoPagoOAuthClient } from './mercadoPagoOAuth.js';

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;
export type FetchLike = (input: string, init?: FetchInit) => Promise<Response>;

/** Tudo de que os servicos de recebimento precisam. Montado uma vez, por API e por worker. */
export interface PaymentAccountsCore {
  readonly pool: DbPool;
  readonly cipher: PaymentCredentialCipher;
  readonly oauth: MercadoPagoOAuthClient;
  /** Ambiente desta instalacao: o que ela conecta e usa (SANDBOX em teste, PRODUCTION em producao). */
  readonly environment: PaymentEnvironment;
  /** Segredo de webhook da APLICACAO da plataforma (um so, para todas as comunidades). */
  readonly webhookSecret: string;
  readonly fallbackPayerEmail?: string | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  readonly apiBase?: string | undefined;
  readonly log?: Logger | undefined;
}

/** Tira chave, token e codigo de uma mensagem antes de ela ir para log/erro. */
export function sanitize(message: string): string {
  return message
    .replace(/\b(APP_USR|TEST|TG)-[A-Za-z0-9_-]+/g, '[redigido]')
    .replace(/\b(sk|rk|pk|whsec)_[A-Za-z0-9_]+/g, '[redigido]')
    .slice(0, 300);
}
