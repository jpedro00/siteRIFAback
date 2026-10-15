import Stripe from 'stripe';
import { withContext, withTenant, type DbPool } from '@clubedarifa/db';
import {
  PaymentAccountUnavailableError,
  PspRejectedError,
  PspUnauthorizedError,
  PspUnavailableError,
  type PspGatewayResolver,
} from '@clubedarifa/psp';
import type { PaymentEnvironment } from '@clubedarifa/shared';
import { ConnectPspGatewayResolver } from './connectResolver.js';
import type { Logger } from './core.js';

/**
 * Stripe Connect (Express): cadastro da conta conectada e estado dela.
 *
 * CADASTRO: a conta Express e criada UMA vez por comunidade/ambiente. Se a comunidade ja tem
 * uma conta STRIPE vinculada, ela e reaproveitada; senao e criada com chave de idempotencia
 * derivada da comunidade e do ambiente (dois cliques simultaneos = uma conta na Stripe) e
 * registrada no banco (autorizacao ACTIVE sem token + vinculo CONNECTED). Cada chamada devolve
 * um Account Link NOVO — eles expiram e sao de uso unico.
 *
 * ESTADO: `syncAccount` le a conta na Stripe (o webhook e so aviso) e grava `charges_enabled`,
 * `payouts_enabled` e as pendencias (`currently_due` + `past_due`). Nunca o corpo da Stripe.
 *
 * Todas as escritas passam por funcoes do banco (0029); nenhuma tabela e escrita direto.
 * Erros e logs nunca levam chave nem corpo de resposta: so tipo e status.
 */

export interface ConnectConfig {
  /** Chave da PLATAFORMA (do ambiente). Nunca gravada, logada ou devolvida. */
  readonly secretKey: string;
  /** Base do painel do criador; o retorno do cadastro vai a `<base>/recebimentos`. */
  readonly returnBaseUrl: string;
  readonly environment: PaymentEnvironment;
  /** Chave live so com `allowLive` (a configuracao so o liga em producao). */
  readonly allowLive?: boolean | undefined;
  /** Para testes: substitui o SDK. */
  readonly client?: Stripe | undefined;
  readonly log?: Logger | undefined;
}

export interface ConnectRuntime {
  readonly environment: PaymentEnvironment;
  readonly resolver: PspGatewayResolver;
  beginOnboarding(input: { tenantId: string; userId: string }): Promise<{ url: string }>;
  syncAccount(stripeAccountId: string): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 10_000;
const ACCOUNT_ID = /^acct_[A-Za-z0-9]{1,64}$/;
const NULL_CONTEXT = { userId: null, tenantId: null, platformAccess: false } as const;

function isLiveKey(secretKey: string): boolean {
  return secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_');
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Erro da Stripe -> erro da plataforma, com mensagem FIXA. A mensagem do SDK pode citar a chave
 * e o erro original carrega cabecalhos e corpo: nenhum dos dois segue adiante.
 */
function classify(error: unknown, log: Logger | undefined, op: string): Error {
  const e = asRecord(error);
  const type = typeof e['type'] === 'string' ? (e['type'] as string) : 'desconhecido';
  const status = typeof e['statusCode'] === 'number' ? (e['statusCode'] as number) : 0;
  log?.warn('payment_account.connect_stripe_failed', { op, type, status });
  if (status === 401 || type === 'StripeAuthenticationError') return new PspUnauthorizedError();
  const transient =
    type === 'StripeConnectionError' ||
    type === 'StripeRateLimitError' ||
    type === 'StripeAPIError' ||
    status === 429 ||
    status >= 500 ||
    status === 0;
  return transient
    ? new PspUnavailableError('Stripe indisponivel. Tente de novo em instantes.')
    : new PspRejectedError('A Stripe recusou o pedido.');
}

export function createConnectRuntime(pool: DbPool, config: ConnectConfig): ConnectRuntime {
  if (isLiveKey(config.secretKey) && config.allowLive !== true) {
    throw new Error('Chave LIVE da Stripe recusada fora de producao.');
  }
  const stripe =
    config.client ?? new Stripe(config.secretKey, { timeout: REQUEST_TIMEOUT_MS, maxNetworkRetries: 2 });
  const base = config.returnBaseUrl.replace(/\/+$/, '');
  const log = config.log;
  const environment = config.environment;

  async function stripeCall<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw classify(error, log, op);
    }
  }

  /** A conta STRIPE vinculada (CONNECTED) da comunidade neste ambiente, se houver. */
  async function linkedAccount(tenantId: string, userId: string): Promise<string | null> {
    return withTenant(pool, { tenantId, userId }, async (client) => {
      const { rows } = await client.query<{ provider_account_id: string }>(
        `SELECT provider_account_id FROM app.payment_account_overview($1)
          WHERE provider = 'STRIPE' AND environment = $2::payment_environment AND status = 'CONNECTED'
          LIMIT 1`,
        [tenantId, environment],
      );
      return rows[0]?.provider_account_id ?? null;
    });
  }

  async function beginOnboarding(input: { tenantId: string; userId: string }): Promise<{ url: string }> {
    let account = await linkedAccount(input.tenantId, input.userId);

    if (!account) {
      const created = await stripeCall('accounts.create', () =>
        stripe.accounts.create(
          {
            type: 'express',
            country: 'BR',
            // Destination charge: o PIX e cobrado na conta da PLATAFORMA e repassado por
            // transferencia, entao a conta conectada nao precisa de `pix_payments`.
            capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
            metadata: { tenant_id: input.tenantId },
          },
          { idempotencyKey: `connect-account:${input.tenantId}:${environment}` },
        ),
      );
      if (typeof created.id !== 'string' || !ACCOUNT_ID.test(created.id)) {
        throw new PspRejectedError('Resposta da Stripe sem identificador de conta.');
      }

      const result = await withTenant(pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
        const { rows } = await client.query<{ result: string }>(
          'SELECT result FROM app.connect_register_account($1, $2, $3::payment_environment, $4)',
          [input.tenantId, input.userId, environment, created.id],
        );
        return rows[0]!.result;
      });
      if (result === 'account_taken') {
        log?.warn('payment_account.connect_account_taken', { tenant_id: input.tenantId });
        throw new PaymentAccountUnavailableError('ACCOUNT_TAKEN');
      }
      account = created.id;
      log?.info('payment_account.connect_registered', { tenant_id: input.tenantId, result });
    }

    const connected = account;
    const link = await stripeCall('accountLinks.create', () =>
      stripe.accountLinks.create({
        account: connected,
        type: 'account_onboarding',
        return_url: `${base}/recebimentos?connect=return`,
        refresh_url: `${base}/recebimentos?connect=refresh`,
      }),
    );
    if (typeof link.url !== 'string' || !link.url.startsWith('https://')) {
      throw new PspRejectedError('Resposta da Stripe sem link de cadastro.');
    }
    return { url: link.url };
  }

  async function syncAccount(stripeAccountId: string): Promise<void> {
    if (!ACCOUNT_ID.test(stripeAccountId)) throw new PspRejectedError('Identificador de conta Stripe invalido.');
    const acct = await stripeCall('accounts.retrieve', () => stripe.accounts.retrieve(stripeAccountId));
    const req = asRecord(acct.requirements);
    const due = [...new Set([...stringList(req['currently_due']), ...stringList(req['past_due'])])];

    const updated = await withContext(pool, NULL_CONTEXT, async (client) => {
      const { rows } = await client.query<{ n: number }>('SELECT app.connect_apply_account_state($1, $2, $3, $4) AS n', [
        stripeAccountId,
        acct.charges_enabled === true,
        acct.payouts_enabled === true,
        due,
      ]);
      return rows[0]!.n;
    });
    log?.info('payment_account.connect_synced', {
      account: stripeAccountId,
      updated,
      charges_enabled: acct.charges_enabled === true,
      payouts_enabled: acct.payouts_enabled === true,
    });
  }

  return {
    environment,
    resolver: new ConnectPspGatewayResolver({
      pool,
      environment,
      secretKey: config.secretKey,
      allowLive: config.allowLive,
      client: stripe,
    }),
    beginOnboarding,
    syncAccount,
  };
}
