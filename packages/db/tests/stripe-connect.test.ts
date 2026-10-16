import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/context.js';
import type { DbPool } from '../src/pool.js';
import {
  appPool,
  describeSkipReason,
  ensureMigrated,
  hasTestDatabase,
  ownerPool,
  resetFoundationTables,
  seedMembership,
  seedTenant,
  seedUser,
  unique,
  workerPool,
} from './helpers/testDb.js';

/**
 * 0027/0028 · Stripe Connect: provedor STRIPE, taxa da plataforma e conta conectada.
 * Fixtures semeadas pelo dono; as funcoes sao chamadas pelas roles de runtime.
 */
describe.skipIf(!hasTestDatabase)(`0027/0028 · stripe connect ${hasTestDatabase ? '' : describeSkipReason()}`, () => {
  let owner: DbPool;
  let app: DbPool;
  let worker: DbPool;

  beforeAll(async () => {
    await ensureMigrated();
    owner = ownerPool();
    app = appPool();
    worker = workerPool();
    await resetFoundationTables();
  }, 120_000);

  afterAll(async () => {
    await owner?.end();
    await app?.end();
    await worker?.end();
  });

  const slug = () => unique('sc-').toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const comoTenant = <T>(tenantId: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(app, { tenantId }, fn);

  async function plano(feeBps: number | null) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO plans (code, name, billing_interval, price_cents, platform_fee_bps)
       VALUES ($1, 'Plano fee', 'month', 1000, $2) RETURNING id`,
      [slug(), feeBps],
    );
    return rows[0]!.id;
  }

  async function tenant() {
    return (await seedTenant(owner, unique('sc-'), 'Stripe Connect')).tenantId;
  }

  async function conta(
    tenantId: string,
    o: { provider?: 'STRIPE' | 'MERCADO_PAGO'; charges?: boolean | null; env?: string; connectedAt?: string } = {},
  ) {
    const provider = o.provider ?? 'STRIPE';
    const env = o.env ?? 'SANDBOX';
    const mp = provider === 'MERCADO_PAGO';
    const { rows: a } = await owner.query<{ id: string }>(
      `INSERT INTO payment_provider_authorizations
         (provider, environment, provider_account_id, status, access_token_encrypted, refresh_token_encrypted,
          credentials_key_version, charges_enabled, payouts_enabled)
       VALUES ($1::payment_provider, $2::payment_environment, $3, 'ACTIVE', $4, $5, $6, $7, $7) RETURNING id`,
      [provider, env, unique(mp ? 'MP-' : 'acct_'), mp ? Buffer.from('a') : null, mp ? Buffer.from('r') : null, mp ? 1 : null, o.charges ?? null],
    );
    const { rows: v } = await owner.query<{ id: string }>(
      `INSERT INTO tenant_payment_accounts (tenant_id, authorization_id, provider, environment, status, connected_at)
       VALUES ($1, $2, $3::payment_provider, $4::payment_environment, 'CONNECTED', COALESCE($5::timestamptz, now())) RETURNING id`,
      [tenantId, a[0]!.id, provider, env, o.connectedAt ?? null],
    );
    return { authorizationId: a[0]!.id, accountId: v[0]!.id };
  }

  async function pagamento(
    tenantId: string,
    extra: { provider?: string; bps?: number | null; cents?: number | null; accountId?: string | null } = {},
  ) {
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
    return owner.query(
      `INSERT INTO payments (tenant_id, order_id, provider, provider_payment_id, status, idempotency_key, amount_cents, expires_at,
                             payment_account_id, platform_fee_bps, platform_fee_cents)
       VALUES ($1,$2,$3,$4,'PENDENTE',$8,1000, now() + interval '30 minutes', $5, $6, $7)`,
      [
        tenantId,
        o[0]!.id,
        extra.provider ?? 'FAKE',
        unique('pp-'),
        extra.accountId ?? null,
        extra.bps === undefined ? null : extra.bps,
        extra.cents === undefined ? null : extra.cents,
        unique('idem-'),
      ],
    );
  }

  describe('enum e taxa', () => {
    it('STRIPE e um valor valido do enum payment_provider', async () => {
      const { rows } = await owner.query<{ ok: boolean }>(`SELECT 'STRIPE'::payment_provider IS NOT NULL AS ok`);
      expect(rows[0]!.ok).toBe(true);
    });

    it('plans_fee_range rejeita 10001 e aceita 0, 500 e 10000', async () => {
      await expect(plano(10001)).rejects.toThrow(/plans_fee_range/);
      await expect(plano(-1)).rejects.toThrow(/plans_fee_range/);
      for (const bps of [0, 500, 10000, null]) await expect(plano(bps)).resolves.toBeTruthy();
    });

    it('billing_settings.default_platform_fee_bps tem padrao 500 e faixa 0..10000', async () => {
      const { rows } = await owner.query<{ d: number }>('SELECT default_platform_fee_bps AS d FROM billing_settings');
      expect(rows[0]!.d).toBe(500);
      await expect(owner.query('UPDATE billing_settings SET default_platform_fee_bps = 10001')).rejects.toThrow(
        /billing_settings_fee_range/,
      );
    });
  });

  describe('payments', () => {
    it('guarda a taxa congelada e valida a faixa (fee <= valor)', async () => {
      const t = await tenant();
      await expect(pagamento(t, { bps: 500, cents: 50 })).resolves.toBeDefined();
      await expect(pagamento(t, { bps: 500, cents: 1001 })).rejects.toThrow(/payments_fee_valid/);
      await expect(pagamento(t, { bps: 10001, cents: 10 })).rejects.toThrow(/payments_fee_valid/);
      await expect(pagamento(t, { bps: 500, cents: null })).rejects.toThrow(/payments_fee_valid/);
      await expect(pagamento(t)).resolves.toBeDefined(); // sem taxa (pagamentos antigos)
    });

    it('payments_provider_known aceita STRIPE e continua rejeitando desconhecidos', async () => {
      const t = await tenant();
      const c = await conta(t, { charges: true });
      await expect(pagamento(t, { provider: 'STRIPE', accountId: c.accountId })).resolves.toBeDefined();
      await expect(pagamento(t, { provider: 'PAYPAL', accountId: c.accountId })).rejects.toThrow(/payments_provider_known/);
    });
  });

  describe('payment_provider_authorizations', () => {
    it('STRIPE ACTIVE vale sem tokens; MERCADO_PAGO ACTIVE continua exigindo', async () => {
      await expect(conta(await tenant(), { charges: false })).resolves.toBeDefined();
      await expect(
        owner.query(
          `INSERT INTO payment_provider_authorizations (provider, environment, provider_account_id, status)
           VALUES ('MERCADO_PAGO','SANDBOX',$1,'ACTIVE')`,
          [unique('MP-')],
        ),
      ).rejects.toThrow(/ppa_active_has_credentials/);
    });

    it('ppa_stripe_no_tokens: conta Stripe nao guarda token', async () => {
      await expect(
        owner.query(
          `INSERT INTO payment_provider_authorizations
             (provider, environment, provider_account_id, status, access_token_encrypted, refresh_token_encrypted, credentials_key_version)
           VALUES ('STRIPE','SANDBOX',$1,'ACTIVE',$2,$3,1)`,
          [unique('acct_'), Buffer.from('a'), Buffer.from('r')],
        ),
      ).rejects.toThrow(/ppa_stripe_no_tokens/);
    });

    it('requirements_due comeca vazio e charges/payouts comecam nulos', async () => {
      const { rows: a } = await owner.query<{ id: string }>(
        `INSERT INTO payment_provider_authorizations (provider, environment, provider_account_id, status)
         VALUES ('STRIPE','SANDBOX',$1,'ACTIVE') RETURNING id`,
        [unique('acct_')],
      );
      const { rows } = await owner.query<{ r: string[]; c: boolean | null; p: boolean | null }>(
        'SELECT requirements_due AS r, charges_enabled AS c, payouts_enabled AS p FROM payment_provider_authorizations WHERE id = $1',
        [a[0]!.id],
      );
      expect(rows[0]).toEqual({ r: [], c: null, p: null });
    });
  });

  describe('funcoes de recebimento', () => {
    it('Stripe sem charges_enabled nao pode receber; com, pode (tenant_has_payment_account e overview)', async () => {
      const t = await tenant();
      const c = await conta(t, { charges: false });
      const has = async () =>
        (await comoTenant(t, (db) => db.query<{ ok: boolean }>('SELECT app.tenant_has_payment_account($1) AS ok', [t]))).rows[0]!.ok;
      const overview = async () =>
        (
          await comoTenant(t, (db) =>
            db.query<{ can_receive: boolean; charges_enabled: boolean | null; payouts_enabled: boolean | null; requirements_due: string[] }>(
              'SELECT * FROM app.payment_account_overview($1)',
              [t],
            ),
          )
        ).rows[0]!;
      expect(await has()).toBe(false);
      expect((await overview()).can_receive).toBe(false);
      await owner.query(
        `UPDATE payment_provider_authorizations SET charges_enabled = true, payouts_enabled = false, requirements_due = ARRAY['external_account'] WHERE id = $1`,
        [c.authorizationId],
      );
      expect(await has()).toBe(true);
      expect(await overview()).toMatchObject({
        can_receive: true,
        charges_enabled: true,
        payouts_enabled: false,
        requirements_due: ['external_account'],
      });
    });

    it('Mercado Pago ativo continua podendo receber (charges_enabled nao se aplica)', async () => {
      const t = await tenant();
      await conta(t, { provider: 'MERCADO_PAGO' });
      const r = await comoTenant(t, (db) => db.query<{ ok: boolean }>('SELECT app.tenant_has_payment_account($1) AS ok', [t]));
      expect(r.rows[0]!.ok).toBe(true);
    });

    it('tenant_receiving_provider: a conectada ha menos tempo que pode receber; ignora Stripe sem charges', async () => {
      const t = await tenant();
      const antiga = await conta(t, { provider: 'MERCADO_PAGO', connectedAt: new Date(Date.now() - 86_400_000).toISOString() });
      const stripe = await conta(t, { charges: false });
      const qual = async () =>
        (
          await comoTenant(t, (db) =>
            db.query<{ account_id: string; provider: string }>('SELECT * FROM app.tenant_receiving_provider($1, $2)', [t, 'SANDBOX']),
          )
        ).rows;
      expect(await qual()).toEqual([{ account_id: antiga.accountId, provider: 'MERCADO_PAGO' }]);
      await owner.query('UPDATE payment_provider_authorizations SET charges_enabled = true WHERE id = $1', [stripe.authorizationId]);
      expect(await qual()).toEqual([{ account_id: stripe.accountId, provider: 'STRIPE' }]);
      const prod = await comoTenant(t, (db) => db.query('SELECT * FROM app.tenant_receiving_provider($1, $2)', [t, 'PRODUCTION']));
      expect(prod.rows).toHaveLength(0);
    });

    it('tenant_receiving_provider nao vaza dados de outra comunidade', async () => {
      const a = await tenant();
      const b = await tenant();
      await conta(b, { charges: true });
      const r = await comoTenant(a, (db) => db.query('SELECT * FROM app.tenant_receiving_provider($1, $2)', [b, 'SANDBOX']));
      expect(r.rows).toHaveLength(0);
    });

    it('tenant_platform_fee_bps: plano da assinatura viva > padrao da plataforma (500)', async () => {
      const t = await tenant();
      const bps = async () =>
        (await comoTenant(t, (db) => db.query<{ bps: number }>('SELECT app.tenant_platform_fee_bps($1) AS bps', [t]))).rows[0]!.bps;
      expect(await bps()).toBe(500);

      const customer = unique('cus_');
      await owner.query('INSERT INTO tenant_billing (tenant_id, stripe_customer_id) VALUES ($1,$2)', [t, customer]);
      const semTaxa = await plano(null);
      const sub = await owner.query<{ id: string }>(
        `INSERT INTO tenant_subscriptions (tenant_id, plan_id, stripe_customer_id, stripe_subscription_id, status, stripe_synced_at)
         VALUES ($1,$2,$3,$4,'active', now()) RETURNING id`,
        [t, semTaxa, customer, unique('sub_')],
      );
      expect(await bps()).toBe(500); // plano sem taxa propria cai no padrao

      await owner.query('UPDATE tenant_subscriptions SET plan_id = $1 WHERE id = $2', [await plano(200), sub.rows[0]!.id]);
      expect(await bps()).toBe(200);

      await owner.query(`UPDATE tenant_subscriptions SET status = 'canceled' WHERE id = $1`, [sub.rows[0]!.id]);
      expect(await bps()).toBe(500); // assinatura encerrada nao conta
    });

    it('tenant_platform_fee_bps: outra comunidade => NULL; a propria e o worker leem a taxa', async () => {
      const a = await tenant();
      const b = await tenant();
      const customer = unique('cus_');
      await owner.query('INSERT INTO tenant_billing (tenant_id, stripe_customer_id) VALUES ($1,$2)', [b, customer]);
      await owner.query(
        `INSERT INTO tenant_subscriptions (tenant_id, plan_id, stripe_customer_id, stripe_subscription_id, status, stripe_synced_at)
         VALUES ($1,$2,$3,$4,'active', now())`,
        [b, await plano(300), customer, unique('sub_')],
      );
      const deA = await comoTenant(a, (db) => db.query<{ bps: number | null }>('SELECT app.tenant_platform_fee_bps($1) AS bps', [b]));
      expect(deA.rows[0]!.bps).toBeNull();
      const deB = await comoTenant(b, (db) => db.query<{ bps: number | null }>('SELECT app.tenant_platform_fee_bps($1) AS bps', [b]));
      expect(deB.rows[0]!.bps).toBe(300);
      const propriaA = await comoTenant(a, (db) => db.query<{ bps: number | null }>('SELECT app.tenant_platform_fee_bps($1) AS bps', [a]));
      expect(propriaA.rows[0]!.bps).toBe(500);
      const w = await worker.query<{ bps: number | null }>('SELECT app.tenant_platform_fee_bps($1) AS bps', [b]);
      expect(w.rows[0]!.bps).toBe(300);
    });

    it('as funcoes novas nao sao publicas e app_user/app_worker as executam', async () => {
      const { rows } = await owner.query<{ f: string; pub: boolean; u: boolean; w: boolean }>(
        `SELECT p.proname AS f,
                has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
                has_function_privilege('app_user', p.oid, 'EXECUTE') AS u,
                has_function_privilege('app_worker', p.oid, 'EXECUTE') AS w
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app' AND p.proname IN ('tenant_receiving_provider','tenant_platform_fee_bps','payment_account_overview')`,
      );
      expect(rows).toHaveLength(3);
      for (const r of rows) expect(r).toMatchObject({ pub: false, u: true, w: true });
    });
  });

  describe('0029 · cadastro e estado da conta Connect', () => {
    const acct = () => unique('acct_').replace(/[^A-Za-z0-9_]/g, '');

    async function dono(tenantId: string) {
      const u = await seedUser(owner, `${unique('dono-')}@example.com`, 'Dono');
      await seedMembership(owner, { tenantId, userId: u.userId, role: 'OWNER' });
      return u.userId;
    }

    const registrar = (ctxTenant: string, tenantId: string, userId: string, account: string, env = 'SANDBOX') =>
      comoTenant(ctxTenant, (db) =>
        db.query<{ result: string; account_id: string | null; authorization_id: string | null }>(
          'SELECT * FROM app.connect_register_account($1, $2, $3::payment_environment, $4)',
          [tenantId, userId, env, account],
        ),
      ).then((r) => r.rows[0]!);

    const aplicar = (pool: DbPool, account: string, charges: boolean, payouts: boolean, req: string[], env = 'SANDBOX') =>
      pool
        .query<{ n: number }>('SELECT app.connect_apply_account_state($1, $2::payment_environment, $3, $4, $5) AS n', [
          account,
          env,
          charges,
          payouts,
          req,
        ])
        .then((r) => r.rows[0]!.n);

    const estado = async (account: string) =>
      (
        await owner.query<{ provider: string; status: string; c: boolean | null; p: boolean | null; r: string[]; tok: boolean }>(
          `SELECT provider::text, status::text, charges_enabled AS c, payouts_enabled AS p, requirements_due AS r,
                  (access_token_encrypted IS NOT NULL OR refresh_token_encrypted IS NOT NULL) AS tok
             FROM payment_provider_authorizations WHERE provider_account_id = $1 ORDER BY provider`,
          [account],
        )
      ).rows;

    it('registra a conta: autorizacao STRIPE ACTIVE sem token + vinculo CONNECTED; repetir nao duplica', async () => {
      const t = await tenant();
      const u = await dono(t);
      const a = acct();
      const r1 = await registrar(t, t, u, a);
      expect(r1.result).toBe('connected');
      const r2 = await registrar(t, t, u, a);
      expect(r2).toMatchObject({ result: 'already_linked', account_id: r1.account_id, authorization_id: r1.authorization_id });
      expect(await estado(a)).toEqual([{ provider: 'STRIPE', status: 'ACTIVE', c: null, p: null, r: [], tok: false }]);
      const links = await owner.query('SELECT status::text FROM tenant_payment_accounts WHERE authorization_id = $1', [
        r1.authorization_id,
      ]);
      expect(links.rows).toEqual([{ status: 'CONNECTED' }]);
      const audit = await owner.query(
        `SELECT 1 FROM audit_events WHERE tenant_id = $1 AND action = 'payment_account.connected' AND target_id = $2`,
        [t, r1.account_id],
      );
      expect(audit.rowCount).toBe(1);
    });

    it('uma comunidade nao registra conta em nome de outra (caller_can_touch_tenant)', async () => {
      const a = await tenant();
      const b = await tenant();
      const ub = await dono(b);
      await expect(registrar(a, b, ub, acct())).rejects.toThrow(/sem acesso a comunidade/);
      const n = await owner.query('SELECT 1 FROM tenant_payment_accounts WHERE tenant_id = $1', [b]);
      expect(n.rowCount).toBe(0);
    });

    it('conta ja vinculada a OUTRA comunidade e recusada (o acct_ nao prova posse)', async () => {
      const a = await tenant();
      const b = await tenant();
      const conta = acct();
      expect((await registrar(b, b, await dono(b), conta)).result).toBe('connected');
      const r = await registrar(a, a, await dono(a), conta);
      expect(r).toEqual({ result: 'account_taken', account_id: null, authorization_id: null });
      const n = await owner.query('SELECT 1 FROM tenant_payment_accounts WHERE tenant_id = $1', [a]);
      expect(n.rowCount).toBe(0);
    });

    it('identificador fora do formato acct_ e recusado', async () => {
      const t = await tenant();
      await expect(registrar(t, t, await dono(t), 'nao-e-conta')).rejects.toThrow(/conta Stripe invalido/);
    });

    it('trocar de conta: a antiga sai de CONNECTED e a nova passa a receber', async () => {
      const t = await tenant();
      const u = await dono(t);
      const r1 = await registrar(t, t, u, acct());
      const r2 = await registrar(t, t, u, acct());
      expect(r2.result).toBe('connected');
      const { rows } = await owner.query<{ id: string; status: string }>(
        'SELECT id, status::text FROM tenant_payment_accounts WHERE tenant_id = $1',
        [t],
      );
      expect(rows.find((x) => x.id === r1.account_id)!.status).not.toBe('CONNECTED');
      expect(rows.find((x) => x.id === r2.account_id)!.status).toBe('CONNECTED');
    });

    it('aplicar estado: so mexe na autorizacao STRIPE daquele acct_, sem contexto de comunidade', async () => {
      const t = await tenant();
      const u = await dono(t);
      const conta = acct();
      await registrar(t, t, u, conta);
      // Uma autorizacao Mercado Pago com o MESMO identificador nao pode ser tocada.
      await owner.query(
        `INSERT INTO payment_provider_authorizations
           (provider, environment, provider_account_id, status, access_token_encrypted, refresh_token_encrypted, credentials_key_version)
         VALUES ('MERCADO_PAGO','SANDBOX',$1,'ACTIVE',$2,$3,1)`,
        [conta, Buffer.from('a'), Buffer.from('r')],
      );
      const has = async () =>
        (await comoTenant(t, (db) => db.query<{ ok: boolean }>('SELECT app.tenant_has_payment_account($1) AS ok', [t]))).rows[0]!.ok;

      expect(await has()).toBe(false);
      expect(await aplicar(app, conta, true, false, ['external_account'])).toBe(1);
      expect(await has()).toBe(true);
      const e = await estado(conta);
      expect(e).toEqual([
        { provider: 'MERCADO_PAGO', status: 'ACTIVE', c: null, p: null, r: [], tok: true },
        { provider: 'STRIPE', status: 'ACTIVE', c: true, p: false, r: ['external_account'], tok: false },
      ]);
      expect(await aplicar(worker, conta, false, false, [])).toBe(1);
      expect(await has()).toBe(false);
    });

    it('aplicar estado respeita o ambiente: estado de PRODUCTION nao toca a conta SANDBOX', async () => {
      const t = await tenant();
      const conta = acct();
      await registrar(t, t, await dono(t), conta);
      expect(await aplicar(app, conta, true, true, [], 'PRODUCTION')).toBe(0);
      expect((await estado(conta))[0]).toMatchObject({ c: null, p: null });
      expect(await aplicar(app, conta, true, true, [], 'SANDBOX')).toBe(1);
    });

    it('connect_tenant_account: a conta Stripe mais recente da comunidade, mesmo desconectada; nunca a de outra', async () => {
      const a = await tenant();
      const b = await tenant();
      const ua = await dono(a);
      const ler = (ctx: string, alvo: string, env = 'SANDBOX') =>
        comoTenant(ctx, (db) =>
          db.query<{ acct: string | null }>('SELECT app.connect_tenant_account($1, $2::payment_environment) AS acct', [alvo, env]),
        ).then((r) => r.rows[0]!.acct);

      expect(await ler(a, a)).toBeNull();
      const conta = acct();
      const r1 = await registrar(a, a, ua, conta);
      expect(await ler(a, a)).toBe(conta);
      expect(await ler(a, a, 'PRODUCTION')).toBeNull();
      expect(await ler(b, a)).toBeNull(); // outra comunidade nao enxerga

      // Desconectada (autorizacao REVOKED): continua sendo a conta da comunidade.
      const d = await comoTenant(a, (db) =>
        db.query<{ r: string }>('SELECT app.request_payment_account_disconnect($1, $2, $3) AS r', [a, r1.account_id, ua]),
      );
      expect(d.rows[0]!.r).toBe('disconnected');
      expect(await ler(a, a)).toBe(conta);

      // E religar a mesma conta funciona (sem account_taken).
      expect((await registrar(a, a, ua, conta)).result).toBe('connected');
    });

    it('aplicar estado de conta desconhecida nao cria nada', async () => {
      const conta = acct();
      expect(await aplicar(app, conta, true, true, [])).toBe(0);
      expect(await estado(conta)).toEqual([]);
    });

    it('requirements: limita quantidade e tamanho (nao vira deposito de corpo da Stripe)', async () => {
      const t = await tenant();
      const conta = acct();
      await registrar(t, t, await dono(t), conta);
      const muitos = Array.from({ length: 500 }, (_, i) => `campo_${i}_${'x'.repeat(400)}`);
      await aplicar(app, conta, false, false, muitos);
      const [s] = await estado(conta);
      expect(s!.r.length).toBeLessThanOrEqual(100);
      for (const r of s!.r) expect(r.length).toBeLessThanOrEqual(200);
    });

    it('as funcoes da 0029 nao sao publicas e app_user/app_worker as executam', async () => {
      const { rows } = await owner.query<{ f: string; pub: boolean; u: boolean; w: boolean; definer: boolean; cfg: string[] | null }>(
        `SELECT p.proname AS f, p.prosecdef AS definer, p.proconfig AS cfg,
                has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
                has_function_privilege('app_user', p.oid, 'EXECUTE') AS u,
                has_function_privilege('app_worker', p.oid, 'EXECUTE') AS w
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app' AND p.proname IN ('connect_register_account','connect_apply_account_state','connect_tenant_account')`,
      );
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r).toMatchObject({ pub: false, u: true, w: true, definer: true });
        expect(r.cfg).toContain('search_path=public, pg_temp');
      }
    });
  });
  describe('0030 · eventos do webhook Connect (idempotencia por event_id)', () => {
    const evt = () => unique('evt_').replace(/[^A-Za-z0-9_]/g, '');
    /** Reivindica: devolve o TOKEN da reivindicacao (uuid) ou null (concluido / outra em andamento). */
    const registrar = (pool: DbPool, id: string, type = 'account.updated', account: string | null = 'acct_teste123') =>
      pool
        .query<{ token: string | null }>('SELECT app.record_connect_webhook_event($1, $2, $3) AS token', [id, type, account])
        .then((r) => r.rows[0]!.token);
    const concluido = (pool: DbPool, id: string) =>
      pool
        .query<{ ok: boolean }>('SELECT app.connect_webhook_event_processed($1) AS ok', [id])
        .then((r) => r.rows[0]!.ok);
    const concluir = (pool: DbPool, id: string) =>
      pool
        .query<{ ok: boolean }>('SELECT app.finish_connect_webhook_event($1) AS ok', [id])
        .then((r) => r.rows[0]!.ok);
    const devolver = (id: string, token: string) =>
      app.query<{ ok: boolean }>('SELECT app.release_connect_webhook_event($1, $2::uuid) AS ok', [id, token]).then((r) => r.rows[0]!.ok);
    const vencerLease = (id: string) =>
      owner.query(`UPDATE stripe_connect_webhook_events SET claimed_at = now() - interval '61 seconds' WHERE event_id = $1`, [id]);

    it('primeira vez: token; em andamento (lease): null; devolvido ou lease vencido: token novo; concluido: null', async () => {
      const id = evt();
      const t1 = await registrar(app, id);
      expect(t1).toMatch(/^[0-9a-f-]{36}$/);
      // Outra entrega simultanea enquanto a primeira processa: nao reivindica (lease de 60 s) e
      // o evento NAO consta como concluido (a API responde 503 para a Stripe reenviar).
      expect(await registrar(worker, id)).toBeNull();
      expect(await concluido(app, id)).toBe(false);
      // A primeira falhou e devolveu a reivindicacao: o reenvio da Stripe processa.
      expect(await devolver(id, t1!)).toBe(true);
      const t2 = await registrar(app, id);
      expect(t2).not.toBeNull();
      expect(t2).not.toBe(t1);
      // Morreu no meio sem devolver: so depois de vencer o lease.
      expect(await registrar(app, id)).toBeNull();
      await vencerLease(id);
      const t3 = await registrar(app, id);
      expect(t3).not.toBeNull();
      expect(await concluir(app, id)).toBe(true);
      // Concluido: nem devolver reabre.
      expect(await concluido(app, id)).toBe(true);
      expect(await concluido(worker, id)).toBe(true);
      expect(await devolver(id, t3!)).toBe(false);
      expect(await registrar(app, id)).toBeNull();
      expect(await registrar(worker, id)).toBeNull();
      // Concluir de novo nao muda nada.
      expect(await concluir(app, id)).toBe(false);
      const { rows } = await owner.query<{ n: number; type: string; account: string | null; done: boolean }>(
        `SELECT count(*) OVER ()::int AS n, type, account, processed_at IS NOT NULL AS done
           FROM stripe_connect_webhook_events WHERE event_id = $1`,
        [id],
      );
      expect(rows).toEqual([{ n: 1, type: 'account.updated', account: 'acct_teste123', done: true }]);
    });

    it('devolver e do DONO do lease: quem perdeu o lease (vencido e reivindicado por outro) nao derruba o novo', async () => {
      const id = evt();
      const antigo = await registrar(app, id);
      await vencerLease(id);
      const novo = await registrar(worker, id);
      expect(novo).not.toBeNull();
      // A entrega antiga, lenta, falha agora e tenta devolver: nao e mais dela.
      expect(await devolver(id, antigo!)).toBe(false);
      // O lease da nova continua vivo: uma terceira entrega nao reivindica.
      expect(await registrar(app, id)).toBeNull();
      // E a nova ainda devolve o seu.
      expect(await devolver(id, novo!)).toBe(true);
      expect(await registrar(app, id)).not.toBeNull();
    });

    it('formato: event_id evt_, conta acct_ (ou nula), tipo curto', async () => {
      await expect(registrar(app, 'nao-e-evento')).rejects.toThrow();
      await expect(registrar(app, evt(), 'account.updated', 'conta-qualquer')).rejects.toThrow();
      await expect(registrar(app, evt(), 'x'.repeat(201))).rejects.toThrow();
      expect(await registrar(app, evt(), 'payment_intent.succeeded', null)).not.toBeNull();
    });

    it('runtime nao le nem escreve a tabela diretamente; RLS ligada', async () => {
      for (const pool of [app, worker]) {
        await expect(pool.query('SELECT * FROM stripe_connect_webhook_events')).rejects.toThrow(/permission denied/i);
        await expect(
          pool.query(`INSERT INTO stripe_connect_webhook_events (event_id, type) VALUES ('evt_direto', 'x')`),
        ).rejects.toThrow(/permission denied/i);
        await expect(pool.query('DELETE FROM stripe_connect_webhook_events')).rejects.toThrow(/permission denied/i);
      }
      const { rows } = await owner.query<{ rls: boolean; pub: boolean; u: boolean; w: boolean }>(
        `SELECT c.relrowsecurity AS rls,
                has_table_privilege('public', c.oid, 'SELECT') AS pub,
                has_table_privilege('app_user', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS u,
                has_table_privilege('app_worker', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS w
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'stripe_connect_webhook_events'`,
      );
      expect(rows).toEqual([{ rls: true, pub: false, u: false, w: false }]);
    });

    it('as funcoes da 0030 sao SECURITY DEFINER, com search_path fixo, nao publicas; app_user/app_worker executam', async () => {
      const { rows } = await owner.query<{ f: string; pub: boolean; u: boolean; w: boolean; definer: boolean; cfg: string[] | null }>(
        `SELECT p.proname AS f, p.prosecdef AS definer, p.proconfig AS cfg,
                has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
                has_function_privilege('app_user', p.oid, 'EXECUTE') AS u,
                has_function_privilege('app_worker', p.oid, 'EXECUTE') AS w
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app'
            AND p.proname IN ('record_connect_webhook_event','connect_webhook_event_processed','finish_connect_webhook_event')`,
      );
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r).toMatchObject({ pub: false, u: true, w: true, definer: true });
        expect(r.cfg).toContain('search_path=public, pg_temp');
      }
    });
  });

  describe('apply_psp_payment · estorno STRIPE (APROVADO -> ESTORNADO)', () => {
    /** Pagamento ja APROVADO (o pedido tanto faz aqui): so o estado do pagamento importa. */
    async function aprovado(provider: 'STRIPE' | 'FAKE') {
      const tenantId = await tenant();
      const accountId = provider === 'STRIPE' ? (await conta(tenantId, { charges: true })).accountId : null;
      await pagamento(tenantId, { provider, accountId });
      const { rows } = await owner.query<{ id: string; order_id: string; provider_payment_id: string }>(
        `UPDATE payments SET status = 'APROVADO', paid_at = now() - interval '1 hour'
          WHERE tenant_id = $1 RETURNING id, order_id, provider_payment_id`,
        [tenantId],
      );
      return { tenantId, accountId, ...rows[0]! };
    }
    const aplicar = (p: Awaited<ReturnType<typeof aprovado>>, provider: string, status: string) =>
      worker
        .query<{ r: string }>('SELECT app.apply_psp_payment($1, $2, $3, 1000, $4, now(), NULL, $5::uuid) AS r', [
          provider,
          p.provider_payment_id,
          status,
          p.order_id,
          p.accountId,
        ])
        .then((r) => r.rows[0]!.r);
    const estado = async (id: string) =>
      (await owner.query<{ s: string; paid_at: string | null }>('SELECT status::text AS s, paid_at FROM payments WHERE id = $1', [id])).rows[0]!;
    const auditorias = async (id: string) =>
      (
        await owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit_events WHERE action = 'payment.refunded' AND target_id = $1`,
          [id],
        )
      ).rows[0]!.n;

    it('STRIPE aprovado e estornado na Stripe: vira ESTORNADO, mantem paid_at e audita UMA vez', async () => {
      const p = await aprovado('STRIPE');
      const antes = (await estado(p.id)).paid_at;
      expect(await aplicar(p, 'STRIPE', 'ESTORNADO')).toBe('refunded');
      const e = await estado(p.id);
      expect(e.s).toBe('ESTORNADO');
      expect(e.paid_at).not.toBeNull();
      expect(new Date(e.paid_at!).getTime()).toBe(new Date(antes!).getTime());
      // Reaplicar (webhook repetido, consumidor e webhook juntos): no-op, sem segunda auditoria.
      expect(await aplicar(p, 'STRIPE', 'ESTORNADO')).toBe('already_processed');
      expect(await auditorias(p.id)).toBe(1);
    });

    it('ESTORNADO e terminal no STRIPE: consulta velha dizendo APROVADO nao reaprova', async () => {
      const p = await aprovado('STRIPE');
      await aplicar(p, 'STRIPE', 'ESTORNADO');
      expect(await aplicar(p, 'STRIPE', 'APROVADO')).toBe('already_processed');
      expect((await estado(p.id)).s).toBe('ESTORNADO');
    });

    const issues = async (paymentId: string) =>
      (
        await owner.query<{ kind: string; detail: Record<string, unknown> }>(
          'SELECT kind, detail FROM payment_reconciliation_issues WHERE payment_id = $1 AND resolved_at IS NULL',
          [paymentId],
        )
      ).rows;
    /** O pagamento PAGOU o pedido, ha mais de 7 dias (fora da janela da conciliacao local). */
    async function pagouOPedidoHaTempo(p: Awaited<ReturnType<typeof aprovado>>) {
      await owner.query(`UPDATE orders SET status = 'PAGO', paid_at = now() - interval '10 days' WHERE id = $1`, [p.order_id]);
      await owner.query(`UPDATE payments SET created_at = now() - interval '10 days' WHERE id = $1`, [p.id]);
    }
    const statusPedido = async (orderId: string) =>
      (await owner.query<{ s: string }>('SELECT status::text AS s FROM orders WHERE id = $1', [orderId])).rows[0]!.s;

    it('estorno FORA da plataforma de pagamento que pagou o pedido: abre ORDER_PAID_PAYMENT_NOT_APPROVED (uma vez), pedido intocado', async () => {
      const p = await aprovado('STRIPE');
      await pagouOPedidoHaTempo(p);
      expect(await aplicar(p, 'STRIPE', 'ESTORNADO')).toBe('refunded');
      const abertas = await issues(p.id);
      expect(abertas).toHaveLength(1);
      expect(abertas[0]).toMatchObject({
        kind: 'ORDER_PAID_PAYMENT_NOT_APPROVED',
        detail: { paymentStatus: 'ESTORNADO', amountCents: 1000 },
      });
      expect(await statusPedido(p.order_id)).toBe('PAGO');
      // Repetir (webhook reentregue) nao duplica.
      expect(await aplicar(p, 'STRIPE', 'ESTORNADO')).toBe('already_processed');
      expect(await issues(p.id)).toHaveLength(1);
      // A conciliacao local tambem nao duplica.
      await worker.query("SELECT app.worker_reconcile_local(interval '7 days')");
      expect((await issues(p.id)).filter((i) => i.kind === 'ORDER_PAID_PAYMENT_NOT_APPROVED')).toHaveLength(1);
    });

    it('estorno iniciado pelo NOSSO fluxo (needs_manual_refund): nenhuma divergencia nova', async () => {
      const p = await aprovado('STRIPE');
      await owner.query(`UPDATE payments SET needs_manual_refund = true, refund_reason = 'teste' WHERE id = $1`, [p.id]);
      expect(await aplicar(p, 'STRIPE', 'ESTORNADO')).toBe('refunded');
      expect(await issues(p.id)).toHaveLength(0);
    });

    it('MERCADO_PAGO aprovado + ESTORNADO consultado: already_processed (inalterado)', async () => {
      const tenantId = await tenant();
      const { accountId } = await conta(tenantId, { provider: 'MERCADO_PAGO' });
      await pagamento(tenantId, { provider: 'MERCADO_PAGO', accountId });
      const { rows } = await owner.query<{ id: string; order_id: string; provider_payment_id: string }>(
        `UPDATE payments SET status = 'APROVADO', paid_at = now() WHERE tenant_id = $1 RETURNING id, order_id, provider_payment_id`,
        [tenantId],
      );
      const p = { tenantId, accountId, ...rows[0]! };
      expect(await aplicar(p, 'MERCADO_PAGO', 'ESTORNADO')).toBe('already_processed');
      expect((await estado(p.id)).s).toBe('APROVADO');
      expect(await issues(p.id)).toHaveLength(0);
    });

    it('outros provedores seguem como antes: aprovado + ESTORNADO e already_processed', async () => {
      const p = await aprovado('FAKE');
      expect(await aplicar(p, 'FAKE', 'ESTORNADO')).toBe('already_processed');
      expect((await estado(p.id)).s).toBe('APROVADO');
    });
  });

  describe('0032 · estorno que FALHOU depois de ESTORNADO (record_psp_refund_failed)', () => {
    /** Pagamento STRIPE ja ESTORNADO (o estorno foi aceito; agora a Stripe diz que falhou). */
    async function estornado(provider: 'STRIPE' | 'MERCADO_PAGO' = 'STRIPE') {
      const tenantId = await tenant();
      const { accountId } = await conta(tenantId, { provider, charges: true });
      await pagamento(tenantId, { provider, accountId });
      const { rows } = await owner.query<{ id: string; order_id: string; provider_payment_id: string }>(
        `UPDATE payments SET status = 'ESTORNADO', paid_at = now() - interval '1 hour', needs_manual_refund = true,
                refund_reason = 'teste'
          WHERE tenant_id = $1 RETURNING id, order_id, provider_payment_id`,
        [tenantId],
      );
      return { tenantId, accountId, ...rows[0]! };
    }
    type Pg = Awaited<ReturnType<typeof estornado>>;
    const registrar = (
      p: Pg,
      o: { tenantId?: string; accountId?: string | null; refundId?: string; reason?: string | null; provider?: string } = {},
    ) =>
      comoTenant(o.tenantId ?? p.tenantId, (c) =>
        c
          .query<{ r: string }>('SELECT app.record_psp_refund_failed($1, $2, $3::uuid, $4, $5, $6) AS r', [
            o.provider ?? 'STRIPE',
            p.provider_payment_id,
            o.accountId === undefined ? p.accountId : o.accountId,
            o.refundId ?? 're_fake1',
            o.reason === undefined ? 'expired_or_canceled_card' : o.reason,
            1000,
          ])
          .then((r) => r.rows[0]!.r),
      );
    const abertas = async (paymentId: string) =>
      (
        await owner.query<{ kind: string; detail: Record<string, unknown>; order_id: string; tenant_id: string }>(
          `SELECT kind, detail, order_id, tenant_id FROM payment_reconciliation_issues WHERE payment_id = $1 AND resolved_at IS NULL`,
          [paymentId],
        )
      ).rows;
    const statusDo = async (id: string) =>
      (await owner.query<{ s: string }>('SELECT status::text AS s FROM payments WHERE id = $1', [id])).rows[0]!.s;

    it('abre UMA divergencia REFUND_FAILED (sem dado pessoal) e NAO muda o status (ESTORNADO e terminal)', async () => {
      const p = await estornado();
      expect(await registrar(p)).toBe('opened');
      expect(await registrar(p)).toBe('already_open');
      expect(await registrar(p, { refundId: 're_fake2', reason: null })).toBe('already_open');
      const i = await abertas(p.id);
      expect(i).toHaveLength(1);
      expect(i[0]).toEqual({
        kind: 'REFUND_FAILED',
        detail: { refundId: 're_fake1', failureReason: 'expired_or_canceled_card', amountCents: 1000 },
        order_id: p.order_id,
        tenant_id: p.tenantId,
      });
      expect(await statusDo(p.id)).toBe('ESTORNADO');
      const { rows: aud } = await owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_events WHERE action = 'payment.refund_failed' AND target_id = $1`,
        [p.id],
      );
      expect(aud[0]!.n).toBe(1);
    });

    it('a conciliacao local nao fecha a divergencia (so o operador resolve)', async () => {
      const p = await estornado();
      await registrar(p);
      await worker.query("SELECT app.worker_reconcile_local(interval '7 days')");
      expect((await abertas(p.id)).filter((i) => i.kind === 'REFUND_FAILED')).toHaveLength(1);
    });

    it('resolvida pelo operador, uma nova falha reabre (uma aberta por vez)', async () => {
      const p = await estornado();
      await registrar(p);
      await owner.query(`UPDATE payment_reconciliation_issues SET resolved_at = now() WHERE payment_id = $1`, [p.id]);
      expect(await registrar(p, { refundId: 're_fake3' })).toBe('opened');
      expect(await abertas(p.id)).toHaveLength(1);
    });

    it('outra comunidade (contexto) ou pagamento desconhecido: unknown_payment, nada aberto', async () => {
      const p = await estornado();
      const outra = await tenant();
      expect(await registrar(p, { tenantId: outra })).toBe('unknown_payment');
      expect(
        await registrar({ ...p, provider_payment_id: 'pi_naoexiste' }),
      ).toBe('unknown_payment');
      expect(await registrar(p, { provider: 'MERCADO_PAGO' })).toBe('unknown_payment');
      expect(await abertas(p.id)).toHaveLength(0);
    });

    it('conta da consulta diferente da conta do pagamento: mismatch, nada aberto', async () => {
      const p = await estornado();
      const outra = await conta(await tenant(), { charges: true });
      expect(await registrar(p, { accountId: outra.accountId })).toBe('mismatch');
      expect(await registrar(p, { accountId: null })).toBe('mismatch');
      expect(await abertas(p.id)).toHaveLength(0);
    });

    it('formato: refundId re_/pyr_ obrigatorio; failure_reason que nao e codigo vira null', async () => {
      const p = await estornado();
      await expect(registrar(p, { refundId: 'nao-e-refund' })).rejects.toMatchObject({ code: '22023' });
      expect(await registrar(p, { refundId: 'pyr_fake1', reason: 'Conta 1234-5 de Fulano' })).toBe('opened');
      expect((await abertas(p.id))[0]!.detail).toEqual({ refundId: 'pyr_fake1', failureReason: null, amountCents: 1000 });
    });

    it('a constraint de tipos aceita REFUND_FAILED e continua recusando tipo desconhecido', async () => {
      const p = await estornado();
      await expect(
        owner.query(`INSERT INTO payment_reconciliation_issues (tenant_id, payment_id, kind) VALUES ($1, $2, 'QUALQUER_COISA')`, [
          p.tenantId,
          p.id,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      await owner.query(`INSERT INTO payment_reconciliation_issues (tenant_id, payment_id, kind) VALUES ($1, $2, 'REFUND_FAILED')`, [
        p.tenantId,
        p.id,
      ]);
    });

    it('a funcao da 0032 e SECURITY DEFINER, search_path fixo, nao publica; app_user/app_worker executam', async () => {
      const { rows } = await owner.query<{ f: string; pub: boolean; u: boolean; w: boolean; definer: boolean; cfg: string[] | null }>(
        `SELECT p.proname AS f, p.prosecdef AS definer, p.proconfig AS cfg,
                has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
                has_function_privilege('app_user', p.oid, 'EXECUTE') AS u,
                has_function_privilege('app_worker', p.oid, 'EXECUTE') AS w
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app' AND p.proname = 'record_psp_refund_failed'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ pub: false, u: true, w: true, definer: true });
      expect(rows[0]!.cfg).toContain('search_path=public, pg_temp');
      // O runtime continua sem escrever a tabela diretamente.
      const { rows: t } = await owner.query<{ u: boolean; w: boolean }>(
        `SELECT has_table_privilege('app_user', 'public.payment_reconciliation_issues', 'INSERT,UPDATE,DELETE') AS u,
                has_table_privilege('app_worker', 'public.payment_reconciliation_issues', 'INSERT,UPDATE,DELETE') AS w`,
      );
      expect(t[0]).toEqual({ u: false, w: false });
    });
  });

  describe('0031 · obrigacoes abertas da conta (payment_account_open_obligations)', () => {
    const obrigacoes = async (accountId: string) =>
      (await owner.query<{ n: number }>('SELECT app.payment_account_open_obligations($1) AS n', [accountId])).rows[0]!.n;

    /** Uma conta com UM pagamento no estado pedido; devolve as obrigacoes contadas. */
    async function cenario(provider: 'STRIPE' | 'MERCADO_PAGO', status: string, manual: boolean) {
      const tenantId = await tenant();
      const { accountId } = await conta(tenantId, { provider });
      await pagamento(tenantId, { provider, accountId });
      if (status !== 'PENDENTE' || manual) {
        await owner.query(
          `UPDATE payments SET status = $2::payment_status, paid_at = CASE WHEN $2 IN ('APROVADO','ESTORNADO') THEN now() END,
                  needs_manual_refund = $3, refund_reason = CASE WHEN $3 THEN 'teste' END
            WHERE tenant_id = $1`,
          [tenantId, status, manual],
        );
      }
      return obrigacoes(accountId);
    }

    it('STRIPE ESTORNADO com needs_manual_refund ligado NAO conta mais (o estorno automatico nao desliga a flag)', async () => {
      expect(await cenario('STRIPE', 'ESTORNADO', true)).toBe(0);
    });

    it('STRIPE PENDENTE e STRIPE APROVADO com devolucao manual em aberto continuam contando', async () => {
      expect(await cenario('STRIPE', 'PENDENTE', false)).toBe(1);
      expect(await cenario('STRIPE', 'APROVADO', true)).toBe(1);
    });

    it('MERCADO_PAGO inalterado: pendente e devolucao manual em aberto contam', async () => {
      expect(await cenario('MERCADO_PAGO', 'PENDENTE', false)).toBe(1);
      expect(await cenario('MERCADO_PAGO', 'APROVADO', true)).toBe(1);
      expect(await cenario('MERCADO_PAGO', 'APROVADO', false)).toBe(0);
    });
  });
});
