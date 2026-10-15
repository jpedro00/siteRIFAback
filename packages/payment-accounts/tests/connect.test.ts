import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import { createPool, withTenant, type DbPool } from '@clubedarifa/db';
import {
  PaymentAccountUnavailableError,
  PaymentsNotConfiguredError,
  type CreatePixChargeInput,
} from '@clubedarifa/psp';
import { createConnectRuntime, type ConnectRuntime, type Logger } from '../src/index.js';
import {
  TEST_APP_URL,
  describeSkipReason,
  ensureMigrated,
  hasTestDatabase,
  ownerPool,
  seedMembership,
  seedTenant,
  seedUser,
  unique,
} from '../../db/tests/helpers/testDb.js';

/**
 * Runtime Stripe Connect (onboarding, estado da conta e resolvedor), contra PostgreSQL real com o
 * papel `app_user` e uma Stripe FALSA em memoria. Nenhuma chave real: so `sk_test_fake_for_unit_tests`.
 */
const FAKE_KEY = 'sk_test_fake_for_unit_tests';
const BASE = 'https://painel.exemplo.test';

interface FakeAccount {
  charges_enabled: boolean;
  payouts_enabled: boolean;
  requirements: { currently_due: string[] | null; past_due: string[] | null };
}

/** Stripe falsa: so o que o runtime usa. Honra `idempotencyKey` como a Stripe. */
class FakeStripe {
  readonly creates: { params: Record<string, unknown>; opts: Record<string, unknown> | undefined }[] = [];
  readonly links: Record<string, unknown>[] = [];
  readonly intents: Record<string, unknown>[] = [];
  readonly accountsById = new Map<string, FakeAccount>();
  readonly #byKey = new Map<string, string>();
  /** Forca o id devolvido pela criacao (simula a Stripe devolvendo uma conta inesperada). */
  forceId: string | null = null;
  failWith: Error | null = null;
  #n = 0;

  readonly accounts = {
    create: async (params: Record<string, unknown>, opts?: Record<string, unknown>) => {
      this.creates.push({ params, opts });
      if (this.failWith) throw this.failWith;
      const key = opts?.['idempotencyKey'];
      if (typeof key === 'string' && this.#byKey.has(key)) return { id: this.#byKey.get(key)! };
      const id = this.forceId ?? `acct_${unique('f').replace(/[^A-Za-z0-9]/g, '')}`;
      if (typeof key === 'string') this.#byKey.set(key, id);
      this.accountsById.set(id, {
        charges_enabled: false,
        payouts_enabled: false,
        requirements: { currently_due: ['external_account'], past_due: [] },
      });
      return { id, object: 'account' };
    },
    retrieve: async (id: string) => {
      if (this.failWith) throw this.failWith;
      const a = this.accountsById.get(id);
      if (!a) {
        throw Object.assign(new Error(`No such account: '${id}'`), { type: 'StripeInvalidRequestError', statusCode: 404 });
      }
      return { id, object: 'account', ...a };
    },
  };

  readonly accountLinks = {
    create: async (params: Record<string, unknown>) => {
      this.links.push(params);
      if (this.failWith) throw this.failWith;
      return { object: 'account_link', url: `https://connect.stripe.test/setup/${String(params['account'])}/${++this.#n}` };
    },
  };

  readonly paymentIntents = {
    create: async (params: Record<string, unknown>) => {
      this.intents.push(params);
      return { id: `pi_${++this.#n}`, status: 'requires_action', amount: params['amount'], metadata: params['metadata'] };
    },
  };

  asClient(): Stripe {
    return this as unknown as Stripe;
  }
}

const cobranca = (pedido: string, amountCents: number, platformFeeCents?: number): CreatePixChargeInput => ({
  idempotencyKey: pedido,
  amountCents,
  description: 'Rifa',
  externalReference: pedido,
  payerEmail: null,
  payerName: 'Maria',
  expiresAt: new Date(Date.now() + 30 * 60_000),
  notificationUrl: null,
  ...(platformFeeCents === undefined ? {} : { platformFeeCents }),
});

function captureLog() {
  const lines: string[] = [];
  const push = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
  };
  const log: Logger = { info: push('info'), warn: push('warn'), error: push('error') };
  return { log, lines };
}

describe.skipIf(!hasTestDatabase)(`Stripe Connect · runtime ${hasTestDatabase ? '' : describeSkipReason()}`, () => {
  let owner: DbPool;
  let app: DbPool;
  let stripe: FakeStripe;
  let runtime: ConnectRuntime;
  let logs: string[];

  const criar = (extra: Partial<Parameters<typeof createConnectRuntime>[1]> = {}) => {
    const { log, lines } = captureLog();
    logs = lines;
    return createConnectRuntime(app, {
      secretKey: FAKE_KEY,
      returnBaseUrl: BASE,
      environment: 'SANDBOX',
      client: stripe.asClient(),
      log,
      ...extra,
    });
  };

  beforeAll(async () => {
    await ensureMigrated();
    owner = ownerPool();
    app = createPool({ connectionString: TEST_APP_URL, applicationName: 'test-connect-app', max: 4 });
  }, 120_000);

  afterAll(async () => {
    await owner?.end();
    await app?.end();
  });

  function novo() {
    stripe = new FakeStripe();
    runtime = criar();
  }

  async function comunidade() {
    const { tenantId } = await seedTenant(owner, unique('cx-').toLowerCase(), 'Connect');
    const u = await seedUser(owner, `${unique('dono-')}@example.com`, 'Dono');
    await seedMembership(owner, { tenantId, userId: u.userId, role: 'OWNER' });
    return { tenantId, userId: u.userId };
  }

  const has = async (tenantId: string) =>
    (await withTenant(app, { tenantId }, (db) => db.query<{ ok: boolean }>('SELECT app.tenant_has_payment_account($1) AS ok', [tenantId])))
      .rows[0]!.ok;

  const stripeLinks = async (tenantId: string) =>
    (
      await withTenant(app, { tenantId }, (db) =>
        db.query<{ id: string; status: string; provider_account_id: string; requirements_due: string[] }>(
          `SELECT id, status::text, provider_account_id, requirements_due FROM app.payment_account_overview($1)
            WHERE provider = 'STRIPE' ORDER BY connected_at`,
          [tenantId],
        ),
      )
    ).rows;

  const acctDe = (url: string) => url.split('/')[4]!;

  describe('beginOnboarding', () => {
    it('chamado duas vezes cria UMA conta Express e devolve um Account Link novo a cada vez', async () => {
      novo();
      const c = await comunidade();
      const r1 = await runtime.beginOnboarding(c);
      const r2 = await runtime.beginOnboarding(c);

      expect(stripe.creates).toHaveLength(1);
      expect(stripe.creates[0]!.params).toEqual({
        type: 'express',
        country: 'BR',
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        metadata: { tenant_id: c.tenantId },
      });
      expect(stripe.creates[0]!.opts?.['idempotencyKey']).toBe(`connect-account:${c.tenantId}:SANDBOX`);

      const acct = acctDe(r1.url);
      expect(r1.url).toMatch(/^https:\/\/connect\.stripe\.test\/setup\/acct_/);
      expect(r2.url).not.toBe(r1.url);
      expect(stripe.links).toHaveLength(2);
      for (const l of stripe.links) {
        expect(l).toEqual({
          account: acct,
          type: 'account_onboarding',
          return_url: `${BASE}/recebimentos?connect=return`,
          refresh_url: `${BASE}/recebimentos?connect=refresh`,
        });
      }
      expect(await stripeLinks(c.tenantId)).toMatchObject([{ status: 'CONNECTED', provider_account_id: acct }]);
      expect(await has(c.tenantId)).toBe(false); // cadastro incompleto ainda nao recebe
    });

    it('duas chamadas simultaneas resultam numa so conta e num so vinculo', async () => {
      novo();
      const c = await comunidade();
      const [a, b] = await Promise.all([runtime.beginOnboarding(c), runtime.beginOnboarding(c)]);
      expect(acctDe(a.url)).toBe(acctDe(b.url));
      expect(stripe.accountsById.size).toBe(1);
      expect(await stripeLinks(c.tenantId)).toHaveLength(1);
    });

    it('conta devolvida que ja pertence a outra comunidade e recusada, sem vinculo', async () => {
      novo();
      const a = await comunidade();
      const b = await comunidade();
      const deA = acctDe((await runtime.beginOnboarding(a)).url);
      stripe.forceId = deA;
      await expect(runtime.beginOnboarding(b)).rejects.toThrow(PaymentAccountUnavailableError);
      expect(await stripeLinks(b.tenantId)).toHaveLength(0);
    });

    it('falha da Stripe nao vaza chave nem corpo na mensagem ou no log', async () => {
      novo();
      const c = await comunidade();
      stripe.failWith = Object.assign(new Error(`Invalid API Key provided: ${FAKE_KEY} {"raw":"corpo-secreto"}`), {
        type: 'StripeAuthenticationError',
        statusCode: 401,
        raw: { body: 'corpo-secreto' },
      });
      const err = await runtime.beginOnboarding(c).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(Error);
      const tudo = `${err!.message} ${String(err!.cause ?? '')} ${JSON.stringify(err)} ${logs.join('\n')}`;
      expect(tudo).not.toContain('sk_test');
      expect(tudo).not.toContain('corpo-secreto');
      expect(await stripeLinks(c.tenantId)).toHaveLength(0);
    });

    it('chave LIVE e recusada sem allowLive', () => {
      stripe = new FakeStripe();
      expect(() => criar({ secretKey: 'rk_live_nao_vale' })).toThrow(/LIVE/);
      expect(() => criar({ secretKey: 'sk_live_nao_vale' })).toThrow(/LIVE/);
    });
  });

  describe('syncAccount', () => {
    it('charges_enabled liga o "pode receber"; pendencias = currently_due + past_due', async () => {
      novo();
      const c = await comunidade();
      const acct = acctDe((await runtime.beginOnboarding(c)).url);

      await runtime.syncAccount(acct);
      expect(await has(c.tenantId)).toBe(false);

      stripe.accountsById.set(acct, {
        charges_enabled: true,
        payouts_enabled: false,
        requirements: { currently_due: ['external_account'], past_due: ['individual.id_number'] },
      });
      await runtime.syncAccount(acct);
      expect(await has(c.tenantId)).toBe(true);
      expect((await stripeLinks(c.tenantId))[0]!.requirements_due).toEqual(['external_account', 'individual.id_number']);
    });

    it('conta desconhecida no banco e no-op', async () => {
      novo();
      stripe.accountsById.set('acct_desconhecida123', {
        charges_enabled: true,
        payouts_enabled: true,
        requirements: { currently_due: null, past_due: null },
      });
      await expect(runtime.syncAccount('acct_desconhecida123')).resolves.toBeUndefined();
      const r = await owner.query(`SELECT 1 FROM payment_provider_authorizations WHERE provider_account_id = 'acct_desconhecida123'`);
      expect(r.rowCount).toBe(0);
    });

    it('identificador fora do formato nem chega a Stripe', async () => {
      novo();
      await expect(runtime.syncAccount('nao-e-conta')).rejects.toThrow();
      expect(stripe.creates).toHaveLength(0);
    });

    it('erro da Stripe no sync nao vaza chave nem corpo', async () => {
      novo();
      stripe.failWith = Object.assign(new Error(`boom ${FAKE_KEY} corpo-secreto`), { type: 'StripeAPIError', statusCode: 500 });
      const err = await runtime.syncAccount('acct_qualquer1').then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(Error);
      const tudo = `${err!.message} ${String(err!.cause ?? '')} ${JSON.stringify(err)} ${logs.join('\n')}`;
      expect(tudo).not.toContain('sk_test');
      expect(tudo).not.toContain('corpo-secreto');
    });
  });

  describe('resolver', () => {
    const pronta = async (acct: string) => {
      stripe.accountsById.set(acct, {
        charges_enabled: true,
        payouts_enabled: true,
        requirements: { currently_due: [], past_due: [] },
      });
      await runtime.syncAccount(acct);
    };

    it('provider STRIPE; verifyWebhook manda para o webhook Connect', () => {
      novo();
      expect(runtime.resolver.provider).toBe('STRIPE');
      expect(runtime.resolver.verifyWebhook({} as Parameters<ConnectRuntime['resolver']['verifyWebhook']>[0])).toEqual({
        valid: false,
        reason: 'use o webhook Connect',
      });
    });

    it('forTenant: sem conta -> PaymentsNotConfiguredError', async () => {
      novo();
      const c = await comunidade();
      await expect(runtime.resolver.forTenant(c.tenantId)).rejects.toBeInstanceOf(PaymentsNotConfiguredError);
    });

    it('forTenant: conta sem charges_enabled -> PaymentAccountUnavailableError(NOT_READY)', async () => {
      novo();
      const c = await comunidade();
      await runtime.beginOnboarding(c);
      await expect(runtime.resolver.forTenant(c.tenantId)).rejects.toMatchObject({
        name: 'PaymentAccountUnavailableError',
        reason: 'NOT_READY',
      });
    });

    it('forTenant: conta pronta -> gateway amarrado ao acct_ da comunidade', async () => {
      novo();
      const c = await comunidade();
      const acct = acctDe((await runtime.beginOnboarding(c)).url);
      await pronta(acct);
      const r = await runtime.resolver.forTenant(c.tenantId);
      expect(r.gateway.provider).toBe('STRIPE');
      expect(r.paymentAccountId).toBe((await stripeLinks(c.tenantId))[0]!.id);
      await r.gateway.createPixCharge(cobranca('pedido-1', 1000, 50));
      expect(stripe.intents[0]).toMatchObject({ transfer_data: { destination: acct }, application_fee_amount: 50 });
    });

    it('forPayment resolve a conta ORIGINAL do pagamento depois da troca de conta', async () => {
      novo();
      const c = await comunidade();
      const acct1 = acctDe((await runtime.beginOnboarding(c)).url);
      await pronta(acct1);
      const original = (await stripeLinks(c.tenantId))[0]!.id;
      await pagamentoPendente(c.tenantId, original); // mantem a conta antiga em DISCONNECTING

      // A comunidade conecta OUTRA conta Stripe.
      const acct2 = `acct_${unique('n').replace(/[^A-Za-z0-9]/g, '')}`;
      await withTenant(app, { tenantId: c.tenantId }, (db) =>
        db.query('SELECT * FROM app.connect_register_account($1, $2, $3::payment_environment, $4)', [
          c.tenantId,
          c.userId,
          'SANDBOX',
          acct2,
        ]),
      );
      await pronta(acct2);

      const nova = await runtime.resolver.forTenant(c.tenantId);
      expect(nova.paymentAccountId).not.toBe(original);

      const antiga = await runtime.resolver.forPayment({ tenantId: c.tenantId, paymentAccountId: original });
      expect(antiga.paymentAccountId).toBe(original);
      await antiga.gateway.createPixCharge(cobranca('p2', 500));
      expect(stripe.intents.at(-1)).toMatchObject({ transfer_data: { destination: acct1 } });
    });

    it('forPayment: sem conta, conta de outra comunidade ou conta Mercado Pago -> indisponivel', async () => {
      novo();
      const a = await comunidade();
      const b = await comunidade();
      await pronta(acctDe((await runtime.beginOnboarding(b)).url));
      const deB = (await stripeLinks(b.tenantId))[0]!.id;

      await expect(runtime.resolver.forPayment({ tenantId: a.tenantId, paymentAccountId: null })).rejects.toMatchObject({
        reason: 'NO_ACCOUNT',
      });
      await expect(runtime.resolver.forPayment({ tenantId: a.tenantId, paymentAccountId: deB })).rejects.toMatchObject({
        reason: 'ACCOUNT_NOT_FOUND',
      });

      const { rows: z } = await owner.query<{ id: string }>(
        `INSERT INTO payment_provider_authorizations
           (provider, environment, provider_account_id, status, access_token_encrypted, refresh_token_encrypted, credentials_key_version)
         VALUES ('MERCADO_PAGO','SANDBOX',$1,'ACTIVE',$2,$3,1) RETURNING id`,
        [unique('MP-'), Buffer.from('a'), Buffer.from('r')],
      );
      const { rows: mp } = await owner.query<{ id: string }>(
        `INSERT INTO tenant_payment_accounts (tenant_id, authorization_id, provider, environment, status)
         VALUES ($1, $2, 'MERCADO_PAGO', 'SANDBOX', 'CONNECTED') RETURNING id`,
        [a.tenantId, z[0]!.id],
      );
      await expect(runtime.resolver.forPayment({ tenantId: a.tenantId, paymentAccountId: mp[0]!.id })).rejects.toMatchObject({
        reason: 'WRONG_PROVIDER',
      });
      // E o forTenant do Stripe nao "pega" a conta Mercado Pago.
      await expect(runtime.resolver.forTenant(a.tenantId)).rejects.toBeInstanceOf(PaymentsNotConfiguredError);
    });
  });

  async function pagamentoPendente(tenantId: string, accountId: string) {
    const { rows: d } = await owner.query<{ id: string }>(
      `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers) VALUES ($1,$2,'T','P',1000,100) RETURNING id`,
      [tenantId, unique('d-')],
    );
    const { rows: b } = await owner.query<{ id: string }>(
      `INSERT INTO buyers (tenant_id, name, phone) VALUES ($1,'Maria','+5511912345678') RETURNING id`,
      [tenantId],
    );
    const { rows: o } = await owner.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, draw_id, buyer_id, status, unit_price_cents, quantity, total_cents, accepted_terms_at)
       VALUES ($1,$2,$3,'PENDENTE',1000,1,1000,now()) RETURNING id`,
      [tenantId, d[0]!.id, b[0]!.id],
    );
    await owner.query(
      `INSERT INTO payments (tenant_id, order_id, provider, provider_payment_id, status, idempotency_key, amount_cents, expires_at, payment_account_id)
       VALUES ($1,$2,'STRIPE',$3,'PENDENTE',$4,1000, now() + interval '30 minutes', $5)`,
      [tenantId, o[0]!.id, unique('pi_'), unique('idem-'), accountId],
    );
  }
});
