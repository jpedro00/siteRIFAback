import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext, withTenant } from '../src/context.js';
import type { DbPool } from '../src/pool.js';
import {
  appPool,
  describeSkipReason,
  ensureMigrated,
  hasTestDatabase,
  ownerPool,
  resetFoundationTables,
  seedTenant,
  seedUser,
  unique,
  workerPool,
} from './helpers/testDb.js';

/**
 * 0019 · autorizacoes do provedor + vinculo por comunidade.
 *
 * Tudo que toca dado de comunidade roda pelas roles REAIS (`app_user`, `app_worker`). Os
 * segredos aqui sao bytes opacos: a cifragem e da aplicacao (testada no pacote
 * `payment-accounts`); o que se prova neste arquivo e o que o BANCO garante.
 */
describe.skipIf(!hasTestDatabase)(`0019 · recebimentos por comunidade ${hasTestDatabase ? '' : describeSkipReason()}`, () => {
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

  const dias = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
  const dorme = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const comoTenant = <T>(tenantId: string, fn: Parameters<typeof withTenant<T>>[2], userId?: string) =>
    withTenant(app, { tenantId, ...(userId ? { userId } : {}) }, fn);
  const comoWorker = <T>(fn: (db: import('pg').PoolClient) => Promise<T>) =>
    withContext(worker, { tenantId: null, userId: null, platformAccess: false }, fn);

  interface Vinculo {
    tenantId: string;
    userId: string;
    accountId: string;
    authorizationId: string;
  }

  async function comunidade() {
    const t = await seedTenant(owner, unique('pa-'), 'Recebimentos');
    const u = await seedUser(owner, `${unique('u-')}@x.test`, 'Dono');
    return { tenantId: t.tenantId, userId: u.userId };
  }

  /** Inicia, consome o state e conclui: o caminho completo, ate o vinculo. */
  async function conectar(
    c: { tenantId: string; userId: string },
    opts: { conta?: string; env?: string; access?: string; refresh?: string } = {},
  ): Promise<Vinculo & { result: string }> {
    const env = opts.env ?? 'SANDBOX';
    const hash = randomBytes(32);
    await comoTenant(
      c.tenantId,
      (db) =>
        db.query(`SELECT app.begin_payment_account_connection($1,$2,'MERCADO_PAGO',$3::payment_environment,$4,$5,600)`, [
          c.tenantId,
          c.userId,
          env,
          hash,
          Buffer.from('verifier-cifrado'),
        ]),
      c.userId,
    );
    const st = await withContext(app, { tenantId: null, userId: null, platformAccess: false }, (db) =>
      db.query<{ state_id: string }>('SELECT * FROM app.consume_payment_oauth_state($1)', [hash]),
    );
    const stateId = st.rows[0]!.state_id;
    const r = await comoTenant(
      c.tenantId,
      (db) =>
        db.query<{ result: string; account_id: string; authorization_id: string }>(
          `SELECT * FROM app.complete_payment_account_connection($1,$2,$3,$4,$5,$6,1::smallint,$7,ARRAY['offline_access'])`,
          [stateId, c.tenantId, c.userId, opts.conta ?? 'MP-1', Buffer.from(opts.access ?? 'acc-1'), Buffer.from(opts.refresh ?? 'ref-1'), dias(180)],
        ),
      c.userId,
    );
    return { ...c, accountId: r.rows[0]!.account_id, authorizationId: r.rows[0]!.authorization_id, result: r.rows[0]!.result };
  }

  async function pagamento(v: { tenantId: string; accountId: string | null }, opts: { status?: string; provider?: string } = {}) {
    const { rows: d } = await owner.query<{ id: string }>(
      `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers) VALUES ($1,$2,'T','P',1000,100) RETURNING id`,
      [v.tenantId, unique('d-')],
    );
    const { rows: b } = await owner.query<{ id: string }>(`INSERT INTO buyers (tenant_id, name, phone) VALUES ($1,'Maria','+5511912345678') RETURNING id`, [v.tenantId]);
    const { rows: o } = await owner.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, draw_id, buyer_id, status, unit_price_cents, quantity, total_cents, accepted_terms_at)
       VALUES ($1,$2,$3,'PENDENTE',1000,1,1000,now()) RETURNING id`,
      [v.tenantId, d[0]!.id, b[0]!.id],
    );
    const status = opts.status ?? 'PENDENTE';
    const { rows } = await owner.query<{ id: string; provider_payment_id: string }>(
      `INSERT INTO payments (tenant_id, order_id, provider, provider_payment_id, status, idempotency_key, amount_cents, expires_at, payment_account_id, paid_at)
       VALUES ($1,$2,$3,$4,$5::payment_status,$6,1000, now() + interval '30 minutes', $7, CASE WHEN $5 IN ('APROVADO','ESTORNADO') THEN now() END)
       RETURNING id, provider_payment_id`,
      [v.tenantId, o[0]!.id, opts.provider ?? 'MERCADO_PAGO', String(Math.floor(Math.random() * 1e12)), status, o[0]!.id, v.accountId],
    );
    return { paymentId: rows[0]!.id, providerPaymentId: rows[0]!.provider_payment_id, orderId: o[0]!.id };
  }

  // ---------------------------------------------------------------------------
  describe('a tentativa OAuth (state + PKCE)', () => {
    it('o state vale UMA vez; vencido ou desconhecido nao vale; so o hash e guardado', async () => {
      const c = await comunidade();
      const hash = randomBytes(32);
      const begin = (h: Buffer, ttl = 600) =>
        comoTenant(c.tenantId, (db) =>
          db.query(`SELECT app.begin_payment_account_connection($1,$2,'MERCADO_PAGO','SANDBOX',$3,$4,$5)`, [c.tenantId, c.userId, h, Buffer.from('v'), ttl]),
        c.userId);
      await begin(hash);
      const consumir = (h: Buffer) => withContext(app, { tenantId: null, userId: null, platformAccess: false }, (db) => db.query('SELECT * FROM app.consume_payment_oauth_state($1)', [h]));
      const primeira = await consumir(hash);
      expect(primeira.rowCount).toBe(1);
      expect(primeira.rows[0]).toMatchObject({ tenant_id: c.tenantId, user_id: c.userId });
      expect((await consumir(hash)).rowCount).toBe(0); // reutilizado
      expect((await consumir(randomBytes(32))).rowCount).toBe(0); // inexistente

      const vencido = randomBytes(32);
      await begin(vencido);
      await owner.query(`UPDATE payment_account_oauth_states SET expires_at = now() - interval '1 second' WHERE state_hash = $1`, [vencido]);
      expect((await consumir(vencido)).rowCount).toBe(0);

      await expect(begin(randomBytes(32), 5)).rejects.toThrow(/validade do state/);
      // O hash, nunca o valor: a coluna so tem 32 bytes.
      await expect(owner.query(`UPDATE payment_account_oauth_states SET state_hash = $2 WHERE state_hash = $1`, [hash, Buffer.from('curto')])).rejects.toThrow(/hash_size/);
    });

    it('no maximo 5 tentativas abertas por comunidade', async () => {
      const c = await comunidade();
      const b = () =>
        comoTenant(c.tenantId, (db) =>
          db.query(`SELECT app.begin_payment_account_connection($1,$2,'MERCADO_PAGO','SANDBOX',$3,$4,600)`, [c.tenantId, c.userId, randomBytes(32), Buffer.from('v')]),
        c.userId);
      for (let i = 0; i < 5; i++) await b();
      await expect(b()).rejects.toThrow(/muitas tentativas/);
    });

    it('a conclusao exige uma tentativa REAL, da comunidade e do usuario que iniciaram; nao se conclui duas vezes', async () => {
      const a = await comunidade();
      const b = await comunidade();
      const hash = randomBytes(32);
      await comoTenant(a.tenantId, (db) =>
        db.query(`SELECT app.begin_payment_account_connection($1,$2,'MERCADO_PAGO','SANDBOX',$3,$4,600)`, [a.tenantId, a.userId, hash, Buffer.from('v')]), a.userId);
      const completar = (tenant: string, user: string, stateId: string, ctxTenant = tenant) =>
        comoTenant(ctxTenant, (db) =>
          db.query<{ result: string }>(`SELECT * FROM app.complete_payment_account_connection($1,$2,$3,'MP-X',$4,$5,1::smallint,$6,'{}')`, [stateId, tenant, user, Buffer.from('a'), Buffer.from('r'), dias(1)]),
        user);
      const { rows: s } = await owner.query<{ id: string }>('SELECT id FROM payment_account_oauth_states WHERE state_hash = $1', [hash]);

      // Ainda NAO consumida (o vendedor nao voltou do provedor): nao conclui.
      expect((await completar(a.tenantId, a.userId, s[0]!.id)).rows[0]!.result).toBe('invalid_attempt');
      await withContext(app, { tenantId: null, userId: null, platformAccess: false }, (db) => db.query('SELECT * FROM app.consume_payment_oauth_state($1)', [hash]));
      // Outro usuario, ou a tentativa de A vista da comunidade B: nao conclui.
      expect((await completar(a.tenantId, b.userId, s[0]!.id)).rows[0]!.result).toBe('invalid_attempt');
      expect((await completar(a.tenantId, a.userId, s[0]!.id, b.tenantId)).rows[0]!.result).toBe('forbidden');
      expect((await completar(b.tenantId, b.userId, s[0]!.id)).rows[0]!.result).toBe('invalid_attempt');
      // O dono da tentativa conclui uma vez; a segunda e recusada.
      expect((await completar(a.tenantId, a.userId, s[0]!.id)).rows[0]!.result).toBe('connected');
      expect((await completar(a.tenantId, a.userId, s[0]!.id)).rows[0]!.result).toBe('invalid_attempt');
    });
  });

  // ---------------------------------------------------------------------------
  describe('autorizacao compartilhada: uma fonte de credencial', () => {
    it('a MESMA conta do vendedor em duas comunidades: uma autorizacao, dois vinculos, nenhum token duplicado', async () => {
      const a = await comunidade();
      const b = await comunidade();
      const va = await conectar(a, { conta: 'MP-SHARED', access: 'acc-A', refresh: 'ref-A' });
      const vb = await conectar(b, { conta: 'MP-SHARED', access: 'acc-B', refresh: 'ref-B' });
      expect(vb.authorizationId).toBe(va.authorizationId);
      expect(vb.accountId).not.toBe(va.accountId);

      const { rows } = await owner.query<{ n: string; access: Buffer; refresh: Buffer; v: number }>(
        `SELECT count(*) OVER () AS n, access_token_encrypted AS access, refresh_token_encrypted AS refresh, credential_version AS v
           FROM payment_provider_authorizations WHERE provider_account_id = 'MP-SHARED'`,
      );
      expect(rows).toHaveLength(1);
      // O segundo retorno do OAuth trouxe credenciais NOVAS: elas substituem as velhas para as duas comunidades.
      expect(rows[0]!.access.toString()).toBe('acc-B');
      expect(rows[0]!.v).toBe(2);
      // Os vinculos nao carregam segredo nenhum.
      const vinc = await owner.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'tenant_payment_accounts'`);
      expect(vinc.rows.map((r) => r.column_name).join(',')).not.toMatch(/token|secret|credential/);
    });

    it('autorizacoes de contas ou ambientes diferentes sao distintas', async () => {
      const c = await comunidade();
      const sandbox = await conectar(c, { conta: 'MP-D1', env: 'SANDBOX' });
      const prod = await conectar(c, { conta: 'MP-D1', env: 'PRODUCTION' });
      expect(prod.authorizationId).not.toBe(sandbox.authorizationId);
    });

    it('reconectar a mesma conta na mesma comunidade nao duplica o vinculo', async () => {
      const c = await comunidade();
      const v1 = await conectar(c, { conta: 'MP-SAME' });
      const v2 = await conectar(c, { conta: 'MP-SAME' });
      expect(v2.result).toBe('already_linked');
      expect(v2.accountId).toBe(v1.accountId);
      const { rows } = await owner.query('SELECT 1 FROM tenant_payment_accounts WHERE tenant_id = $1', [c.tenantId]);
      expect(rows).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe('credenciais: nunca por SELECT, nunca de outra comunidade', () => {
    it('o runtime nao le autorizacoes nem states; le o vinculo so da propria comunidade', async () => {
      const a = await comunidade();
      const b = await comunidade();
      const va = await conectar(a, { conta: 'MP-ISO-A' });
      await conectar(b, { conta: 'MP-ISO-B' });
      for (const tabela of ['payment_provider_authorizations', 'payment_account_oauth_states']) {
        await expect(comoTenant(a.tenantId, (db) => db.query(`SELECT * FROM ${tabela}`)), tabela).rejects.toThrow(/permission denied/i);
        await expect(comoTenant(a.tenantId, (db) => db.query(`DELETE FROM ${tabela}`)), tabela).rejects.toThrow(/permission denied/i);
      }
      const vistoPorA = await comoTenant(a.tenantId, (db) => db.query('SELECT id FROM tenant_payment_accounts'));
      expect(vistoPorA.rows.map((r) => r.id)).toEqual([va.accountId]);
      await expect(comoTenant(a.tenantId, (db) => db.query(`UPDATE tenant_payment_accounts SET status = 'DISCONNECTED'`))).rejects.toThrow(/permission denied/i);
    });

    it('get_payment_credentials: entrega so a conta da propria comunidade, para a finalidade certa', async () => {
      const a = await comunidade();
      const b = await comunidade();
      const va = await conectar(a, { conta: 'MP-CRED-A', access: 'token-de-A' });
      const vb = await conectar(b, { conta: 'MP-CRED-B', access: 'token-de-B' });
      const pedir = (ctx: string, tenant: string, conta: string, finalidade = 'CREATE') =>
        comoTenant(ctx, (db) =>
          db.query<{ usable: boolean; reason: string; access_token_encrypted: Buffer | null; provider_account_id: string | null }>(
            'SELECT * FROM app.get_payment_credentials($1,$2,$3)', [tenant, conta, finalidade]),
        );
      const propria = (await pedir(a.tenantId, a.tenantId, va.accountId)).rows[0]!;
      expect(propria).toMatchObject({ usable: true, reason: 'OK', provider_account_id: 'MP-CRED-A' });
      expect(propria.access_token_encrypted!.toString()).toBe('token-de-A');

      // A pedindo a conta da B (com o tenant da B): proibido. Com o proprio tenant: "nao existe".
      const cruzado = (await pedir(a.tenantId, b.tenantId, vb.accountId)).rows[0]!;
      expect(cruzado).toMatchObject({ usable: false, reason: 'FORBIDDEN', access_token_encrypted: null });
      const inexistente = (await pedir(a.tenantId, a.tenantId, vb.accountId)).rows[0]!;
      expect(inexistente).toMatchObject({ usable: false, reason: 'ACCOUNT_NOT_FOUND', access_token_encrypted: null });
      // O worker atua em todas (precisa, para conciliar e consultar).
      const doWorker = await comoWorker((db) => db.query<{ usable: boolean }>('SELECT * FROM app.get_payment_credentials($1,$2,$3)', [b.tenantId, vb.accountId, 'SETTLE']));
      expect(doWorker.rows[0]!.usable).toBe(true);
    });

    it('a autorizacao de A nao e tocada por B nem pelo UUID: lock, troca e invalidacao exigem vinculo', async () => {
      const a = await comunidade();
      const b = await comunidade();
      const va = await conectar(a, { conta: 'MP-ALHEIA' });
      const tentar = <T>(fn: Parameters<typeof withTenant<T>>[2]) => comoTenant(b.tenantId, fn);

      const lock = await tentar((db) => db.query('SELECT * FROM app.lock_authorization_for_refresh($1)', [va.authorizationId]));
      expect(lock.rowCount).toBe(0); // nem o refresh token sai
      const troca = await tentar((db) =>
        db.query<{ ok: boolean }>(`SELECT app.store_refreshed_credentials($1,1,$2,$3,1::smallint,now()+interval '1 day') AS ok`, [va.authorizationId, Buffer.from('x'), Buffer.from('y')]));
      expect(troca.rows[0]!.ok).toBe(false);
      const derruba = await tentar((db) => db.query<{ n: number }>(`SELECT app.mark_authorization_invalid($1,'REVOKED','ataque') AS n`, [va.authorizationId]));
      expect(derruba.rows[0]!.n).toBe(0);
      const { rows } = await owner.query<{ status: string; access: Buffer | null }>('SELECT status, access_token_encrypted AS access FROM payment_provider_authorizations WHERE id = $1', [va.authorizationId]);
      expect(rows[0]).toMatchObject({ status: 'ACTIVE' });
      expect(rows[0]!.access).not.toBeNull();
      // O worker pode (e precisa).
      expect((await comoWorker((db) => db.query('SELECT * FROM app.lock_authorization_for_refresh($1)', [va.authorizationId]))).rowCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe('renovacao: troca indivisivel, serializada, por versao', () => {
    const travar = (tenant: string, auth: string) =>
      comoTenant(tenant, (db) => db.query<{ credential_version: number; refresh_token_encrypted: Buffer }>('SELECT * FROM app.lock_authorization_for_refresh($1)', [auth]));
    const gravar = (tenant: string, auth: string, versao: number, acc: string, ref: string) =>
      comoTenant(tenant, (db) =>
        db.query<{ ok: boolean }>(`SELECT app.store_refreshed_credentials($1,$2,$3,$4,1::smallint,now()+interval '180 days') AS ok`, [auth, versao, Buffer.from(acc), Buffer.from(ref)]));

    it('o par novo entra de uma vez; o refresh token ANTIGO nunca sobrescreve o novo', async () => {
      const c = await comunidade();
      const v = await conectar(c, { conta: 'MP-REF', access: 'acc-0', refresh: 'ref-0' });
      const lido = (await travar(c.tenantId, v.authorizationId)).rows[0]!;
      expect(lido.credential_version).toBe(1);

      expect((await gravar(c.tenantId, v.authorizationId, 1, 'acc-1', 'ref-1')).rows[0]!.ok).toBe(true);
      // Um processo atrasado, que ainda tem a versao 1 e o refresh token velho:
      expect((await gravar(c.tenantId, v.authorizationId, 1, 'acc-VELHO', 'ref-VELHO')).rows[0]!.ok).toBe(false);

      const { rows } = await owner.query<{ a: Buffer; r: Buffer; v: number }>('SELECT access_token_encrypted AS a, refresh_token_encrypted AS r, credential_version AS v FROM payment_provider_authorizations WHERE id = $1', [v.authorizationId]);
      expect(rows[0]!.a.toString()).toBe('acc-1');
      expect(rows[0]!.r.toString()).toBe('ref-1');
      expect(rows[0]!.v).toBe(2);
      const aud = await owner.query(`SELECT 1 FROM audit_events WHERE tenant_id = $1 AND action = 'payment_account.token_refreshed'`, [c.tenantId]);
      expect(aud.rowCount).toBe(1);
    });

    it('DUAS renovacoes concorrentes (intercalado): a segunda espera o lock e ja ve a credencial nova', async () => {
      const c = await comunidade();
      const v = await conectar(c, { conta: 'MP-CONC', access: 'acc-0', refresh: 'ref-0' });

      const primeiro = comoTenant(c.tenantId, async (db) => {
        const l = await db.query<{ credential_version: number }>('SELECT * FROM app.lock_authorization_for_refresh($1)', [v.authorizationId]);
        await dorme(500); // "chama o provedor" com o lock segurado
        const r = await db.query<{ ok: boolean }>(`SELECT app.store_refreshed_credentials($1,$2,$3,$4,1::smallint,now()+interval '180 days') AS ok`, [v.authorizationId, l.rows[0]!.credential_version, Buffer.from('acc-NOVO'), Buffer.from('ref-NOVO')]);
        return { visto: l.rows[0]!.credential_version, ok: r.rows[0]!.ok };
      });
      await dorme(120);
      const segundo = await comoTenant(c.tenantId, async (db) => {
        const l = await db.query<{ credential_version: number; refresh_token_encrypted: Buffer }>('SELECT * FROM app.lock_authorization_for_refresh($1)', [v.authorizationId]);
        return { visto: l.rows[0]!.credential_version, refresh: l.rows[0]!.refresh_token_encrypted.toString() };
      });
      const p = await primeiro;
      expect(p).toEqual({ visto: 1, ok: true });
      // O segundo so obteve o lock DEPOIS do commit do primeiro: enxerga a versao 2 e o refresh NOVO.
      expect(segundo).toEqual({ visto: 2, refresh: 'ref-NOVO' });
    });

    it('falha no meio da renovacao (rollback): a credencial vigente fica INTACTA', async () => {
      const c = await comunidade();
      const v = await conectar(c, { conta: 'MP-ROLL', access: 'acc-0', refresh: 'ref-0' });
      await expect(
        comoTenant(c.tenantId, async (db) => {
          await db.query('SELECT * FROM app.lock_authorization_for_refresh($1)', [v.authorizationId]);
          await db.query(`SELECT app.store_refreshed_credentials($1,1,$2,$3,1::smallint,now()+interval '180 days')`, [v.authorizationId, Buffer.from('acc-meio'), Buffer.from('ref-meio')]);
          throw new Error('queda entre gravar e confirmar');
        }),
      ).rejects.toThrow(/queda/);
      const { rows } = await owner.query<{ a: Buffer; r: Buffer; v: number }>('SELECT access_token_encrypted AS a, refresh_token_encrypted AS r, credential_version AS v FROM payment_provider_authorizations WHERE id = $1', [v.authorizationId]);
      expect(rows[0]!.a.toString()).toBe('acc-0');
      expect(rows[0]!.r.toString()).toBe('ref-0');
      expect(rows[0]!.v).toBe(1);
    });

    it('so o worker lista o que vence; so comunidade com vinculo vivo entra na lista', async () => {
      const c = await comunidade();
      const v = await conectar(c, { conta: 'MP-DUE' });
      await owner.query(`UPDATE payment_provider_authorizations SET expires_at = now() + interval '3 days' WHERE id = $1`, [v.authorizationId]);
      const app_ = await comoTenant(c.tenantId, (db) => db.query('SELECT * FROM app.list_authorizations_due_for_refresh(14, 50)'));
      expect(app_.rowCount).toBe(0);
      const w = await comoWorker((db) => db.query<{ authorization_id: string }>('SELECT * FROM app.list_authorizations_due_for_refresh(14, 500)'));
      expect(w.rows.map((r) => r.authorization_id)).toContain(v.authorizationId);
      await owner.query(`UPDATE tenant_payment_accounts SET status = 'DISCONNECTED' WHERE id = $1`, [v.accountId]);
      const depois = await comoWorker((db) => db.query<{ authorization_id: string }>('SELECT * FROM app.list_authorizations_due_for_refresh(14, 500)'));
      expect(depois.rows.map((r) => r.authorization_id)).not.toContain(v.authorizationId);
    });
  });

  // ---------------------------------------------------------------------------
  describe('autorizacao revogada ou com erro', () => {
    it('REVOGADA: segredo apagado, todas as comunidades ligadas caem, pendentes viram pendencia manual', async () => {
      const a = await comunidade();
      const b = await comunidade();
      const va = await conectar(a, { conta: 'MP-REV' });
      const vb = await conectar(b, { conta: 'MP-REV' });
      const pend = await pagamento(va);

      const r = await comoWorker((db) => db.query<{ n: number }>(`SELECT app.mark_authorization_invalid($1,'REVOKED','o vendedor revogou') AS n`, [va.authorizationId]));
      expect(r.rows[0]!.n).toBe(1);

      const { rows: auth } = await owner.query<{ status: string; a: Buffer | null; r: Buffer | null }>('SELECT status, access_token_encrypted AS a, refresh_token_encrypted AS r FROM payment_provider_authorizations WHERE id = $1', [va.authorizationId]);
      expect(auth[0]).toEqual({ status: 'REVOKED', a: null, r: null });
      const { rows: contas } = await owner.query<{ status: string }>('SELECT status FROM tenant_payment_accounts WHERE authorization_id = $1', [va.authorizationId]);
      expect(contas.map((x) => x.status)).toEqual(['REVOKED', 'REVOKED']);
      // Nada novo, e NAO se finge que ainda da para consultar.
      for (const [t, acc] of [[a.tenantId, va.accountId], [b.tenantId, vb.accountId]] as const) {
        for (const finalidade of ['CREATE', 'SETTLE']) {
          const cr = await comoTenant(t, (db) => db.query<{ usable: boolean }>('SELECT * FROM app.get_payment_credentials($1,$2,$3)', [t, acc, finalidade]));
          expect(cr.rows[0]!.usable, `${t}/${finalidade}`).toBe(false);
        }
      }
      const { rows: issues } = await owner.query('SELECT kind FROM payment_reconciliation_issues WHERE payment_id = $1', [pend.paymentId]);
      expect(issues).toEqual([{ kind: 'PAYMENT_AUTHORIZATION_UNAVAILABLE' }]);
      const aud = await owner.query(`SELECT 1 FROM audit_events WHERE tenant_id IN ($1,$2) AND action = 'payment_account.authorization_revoked'`, [a.tenantId, b.tenantId]);
      expect(aud.rowCount).toBe(2);
    });

    it('ERRO/EXPIRADA: conservam o segredo para nova tentativa, mas nada novo e cobrado', async () => {
      const c = await comunidade();
      const v = await conectar(c, { conta: 'MP-ERR' });
      await comoWorker((db) => db.query(`SELECT app.mark_authorization_invalid($1,'ERROR','falha inesperada')`, [v.authorizationId]));
      const { rows } = await owner.query<{ a: Buffer | null; s: string }>('SELECT access_token_encrypted AS a, status AS s FROM payment_provider_authorizations WHERE id = $1', [v.authorizationId]);
      expect(rows[0]!.s).toBe('ERROR');
      expect(rows[0]!.a).not.toBeNull();
      const cr = await comoTenant(c.tenantId, (db) => db.query<{ usable: boolean; reason: string }>('SELECT * FROM app.get_payment_credentials($1,$2,$3)', [c.tenantId, v.accountId, 'CREATE']));
      expect(cr.rows[0]).toMatchObject({ usable: false, reason: 'ACCOUNT_ERROR' });
    });

    it('reconectar depois de revogada cria uma autorizacao NOVA e devolve a comunidade a operar', async () => {
      const c = await comunidade();
      const v1 = await conectar(c, { conta: 'MP-REC' });
      await comoWorker((db) => db.query(`SELECT app.mark_authorization_invalid($1,'REVOKED','revogada')`, [v1.authorizationId]));
      const v2 = await conectar(c, { conta: 'MP-REC' });
      expect(v2.authorizationId).not.toBe(v1.authorizationId);
      const cr = await comoTenant(c.tenantId, (db) => db.query<{ usable: boolean }>('SELECT * FROM app.get_payment_credentials($1,$2,$3)', [c.tenantId, v2.accountId, 'CREATE']));
      expect(cr.rows[0]!.usable).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  describe('desconexao segura e troca de conta', () => {
    it('sem pagamento pendente: desconecta na hora e, sendo a ultima dependente, apaga o segredo local', async () => {
      const c = await comunidade();
      const v = await conectar(c, { conta: 'MP-DESC1' });
      const r = await comoTenant(c.tenantId, (db) => db.query<{ r: string }>('SELECT app.request_payment_account_disconnect($1,$2,$3) AS r', [c.tenantId, v.accountId, c.userId]), c.userId);
      expect(r.rows[0]!.r).toBe('disconnected');
      const { rows } = await owner.query<{ s: string; a: Buffer | null }>('SELECT status AS s, access_token_encrypted AS a FROM payment_provider_authorizations WHERE id = $1', [v.authorizationId]);
      expect(rows[0]).toEqual({ s: 'REVOKED', a: null });
      expect(await comoTenant(c.tenantId, (db) => db.query<{ ok: boolean }>('SELECT app.tenant_has_payment_account($1) AS ok', [c.tenantId]))).toMatchObject({ rows: [{ ok: false }] });
    });

    it('COM pagamento pendente: DISCONNECTING — nada novo, mas a credencial segue para resolver o que existe', async () => {
      const c = await comunidade();
      const v = await conectar(c, { conta: 'MP-DESC2' });
      const pend = await pagamento(v);
      const r = await comoTenant(c.tenantId, (db) => db.query<{ r: string }>('SELECT app.request_payment_account_disconnect($1,$2,$3) AS r', [c.tenantId, v.accountId, c.userId]), c.userId);
      expect(r.rows[0]!.r).toBe('disconnecting');

      const cred = (fin: string) => comoTenant(c.tenantId, (db) => db.query<{ usable: boolean; reason: string }>('SELECT * FROM app.get_payment_credentials($1,$2,$3)', [c.tenantId, v.accountId, fin]));
      expect((await cred('CREATE')).rows[0]).toMatchObject({ usable: false, reason: 'ACCOUNT_DISCONNECTING' }); // nada novo
      expect((await cred('SETTLE')).rows[0]!.usable).toBe(true); // resolver o existente
      // E o banco recusa um pagamento NOVO por essa conta.
      await expect(pagamento(v)).rejects.toThrow(/nao aceita pagamentos novos/);

      // Enquanto pende, o worker nao conclui.
      expect((await comoWorker((db) => db.query<{ n: number }>('SELECT app.finalize_payment_disconnections(50) AS n'))).rows[0]!.n).toBe(0);
      // Resolvido o pagamento (aprovado e sem devolucao): o worker conclui e o segredo sai.
      await owner.query(`UPDATE payments SET status = 'APROVADO', paid_at = now() WHERE id = $1`, [pend.paymentId]);
      expect((await comoWorker((db) => db.query<{ n: number }>('SELECT app.finalize_payment_disconnections(50) AS n'))).rows[0]!.n).toBe(1);
      const { rows } = await owner.query<{ s: string }>('SELECT status AS s FROM tenant_payment_accounts WHERE id = $1', [v.accountId]);
      expect(rows[0]!.s).toBe('DISCONNECTED');
      const { rows: auth } = await owner.query<{ a: Buffer | null }>('SELECT access_token_encrypted AS a FROM payment_provider_authorizations WHERE id = $1', [v.authorizationId]);
      expect(auth[0]!.a).toBeNull();
    });

    it('devolucao manual em aberto e pagamento tardio possivel tambem seguram a credencial', async () => {
      const c = await comunidade();
      const v = await conectar(c, { conta: 'MP-DESC3' });
      const aprovado = await pagamento(v, { status: 'APROVADO' });
      await owner.query(`UPDATE payments SET needs_manual_refund = true, refund_reason = 'numero vendido a outra pessoa' WHERE id = $1`, [aprovado.paymentId]);
      const r = await comoTenant(c.tenantId, (db) => db.query<{ r: string }>('SELECT app.request_payment_account_disconnect($1,$2,$3) AS r', [c.tenantId, v.accountId, c.userId]), c.userId);
      expect(r.rows[0]!.r).toBe('disconnecting');
      const cr = await comoTenant(c.tenantId, (db) => db.query<{ usable: boolean }>('SELECT * FROM app.get_payment_credentials($1,$2,$3)', [c.tenantId, v.accountId, 'SETTLE']));
      expect(cr.rows[0]!.usable).toBe(true); // a devolucao ainda precisa consultar o PSP
    });

    it('a credencial COMPARTILHADA so sai quando a ULTIMA comunidade que depende dela se desconecta', async () => {
      const a = await comunidade();
      const b = await comunidade();
      const va = await conectar(a, { conta: 'MP-DESC4' });
      const vb = await conectar(b, { conta: 'MP-DESC4' });
      const desc = (c: { tenantId: string; userId: string }, id: string) =>
        comoTenant(c.tenantId, (db) => db.query<{ r: string }>('SELECT app.request_payment_account_disconnect($1,$2,$3) AS r', [c.tenantId, id, c.userId]), c.userId);
      expect((await desc(a, va.accountId)).rows[0]!.r).toBe('disconnected');
      let { rows } = await owner.query<{ s: string; a: Buffer | null }>('SELECT status AS s, access_token_encrypted AS a FROM payment_provider_authorizations WHERE id = $1', [va.authorizationId]);
      expect(rows[0]!.s).toBe('ACTIVE'); // B ainda usa
      expect(rows[0]!.a).not.toBeNull();
      const cr = await comoTenant(b.tenantId, (db) => db.query<{ usable: boolean }>('SELECT * FROM app.get_payment_credentials($1,$2,$3)', [b.tenantId, vb.accountId, 'CREATE']));
      expect(cr.rows[0]!.usable).toBe(true);
      expect((await desc(b, vb.accountId)).rows[0]!.r).toBe('disconnected');
      ({ rows } = await owner.query('SELECT status AS s, access_token_encrypted AS a FROM payment_provider_authorizations WHERE id = $1', [va.authorizationId]));
      expect(rows[0]!.s).toBe('REVOKED');
    });

    it('a comunidade B nao desconecta a conta da A; conta ja desconectada responde diferente', async () => {
      const a = await comunidade();
      const b = await comunidade();
      const va = await conectar(a, { conta: 'MP-DESC5' });
      const r = await comoTenant(b.tenantId, (db) => db.query<{ r: string }>('SELECT app.request_payment_account_disconnect($1,$2,$3) AS r', [b.tenantId, va.accountId, b.userId]), b.userId);
      expect(r.rows[0]!.r).toBe('unknown_account');
      const f = await comoTenant(b.tenantId, (db) => db.query<{ r: string }>('SELECT app.request_payment_account_disconnect($1,$2,$3) AS r', [a.tenantId, va.accountId, b.userId]), b.userId);
      expect(f.rows[0]!.r).toBe('forbidden');
      await comoTenant(a.tenantId, (db) => db.query('SELECT app.request_payment_account_disconnect($1,$2,$3)', [a.tenantId, va.accountId, a.userId]), a.userId);
      const again = await comoTenant(a.tenantId, (db) => db.query<{ r: string }>('SELECT app.request_payment_account_disconnect($1,$2,$3) AS r', [a.tenantId, va.accountId, a.userId]), a.userId);
      expect(again.rows[0]!.r).toBe('not_connected');
    });

    it('TROCA DE CONTA: a antiga deixa de receber, a nova recebe, e os pagamentos antigos continuam presos a antiga', async () => {
      const c = await comunidade();
      const antiga = await conectar(c, { conta: 'MP-OLD' });
      const pendente = await pagamento(antiga);
      const nova = await conectar(c, { conta: 'MP-NEW' });
      expect(nova.accountId).not.toBe(antiga.accountId);

      const { rows } = await owner.query<{ id: string; status: string }>('SELECT id, status FROM tenant_payment_accounts WHERE tenant_id = $1', [c.tenantId]);
      const porId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
      expect(porId[antiga.accountId]).toBe('DISCONNECTING'); // tem pagamento pendente
      expect(porId[nova.accountId]).toBe('CONNECTED');

      // O pagamento antigo NAO muda de conta e segue consultavel pela conta dele.
      const { rows: p } = await owner.query<{ payment_account_id: string }>('SELECT payment_account_id FROM payments WHERE id = $1', [pendente.paymentId]);
      expect(p[0]!.payment_account_id).toBe(antiga.accountId);
      await expect(owner.query(`UPDATE payments SET payment_account_id = $2 WHERE id = $1`, [pendente.paymentId, nova.accountId])).rejects.toThrow(/nao muda/);
      const cr = await comoTenant(c.tenantId, (db) => db.query<{ usable: boolean }>('SELECT * FROM app.get_payment_credentials($1,$2,$3)', [c.tenantId, antiga.accountId, 'SETTLE']));
      expect(cr.rows[0]!.usable).toBe(true);
      // Cobranca nova: pela conta nova.
      const recebe = await comoTenant(c.tenantId, (db) => db.query<{ id: string }>(`SELECT app.tenant_receiving_account($1,'MERCADO_PAGO','SANDBOX') AS id`, [c.tenantId]));
      expect(recebe.rows[0]!.id).toBe(nova.accountId);
      // Sem pendencia: a troca desconecta a antiga de vez.
      const limpa = await comunidade();
      const a1 = await conectar(limpa, { conta: 'MP-OLD2' });
      await conectar(limpa, { conta: 'MP-NEW2' });
      const { rows: s } = await owner.query<{ status: string }>('SELECT status FROM tenant_payment_accounts WHERE id = $1', [a1.accountId]);
      expect(s[0]!.status).toBe('DISCONNECTED');
    });
  });

  // ---------------------------------------------------------------------------
  describe('pagamentos presos a conta', () => {
    it('todo pagamento real tem conta; a conta e da MESMA comunidade e esta CONECTADA; FAKE e livre', async () => {
      const a = await comunidade();
      const b = await comunidade();
      const va = await conectar(a, { conta: 'MP-PAY-A' });
      const vb = await conectar(b, { conta: 'MP-PAY-B' });

      await pagamento(va); // ok
      await expect(pagamento({ tenantId: a.tenantId, accountId: null })).rejects.toThrow(/exige uma conta de recebimento/);
      await expect(pagamento({ tenantId: a.tenantId, accountId: vb.accountId })).rejects.toThrow(/violates foreign key|outra comunidade/);
      await pagamento({ tenantId: a.tenantId, accountId: null }, { provider: 'FAKE' }); // so testes
    });

    it('pagamento LEGADO (criado antes da conta, sem conta) continua atualizavel: aprovar, expirar, devolver', async () => {
      // Regressao do teste de upgrade: a regra "real tem conta" vale so no INSERT. Um CHECK NOT VALID
      // bloquearia todo UPDATE destas linhas. Simula-se o legado por um FAKE reclassificado.
      const a = await comunidade();
      const legado = await pagamento({ tenantId: a.tenantId, accountId: null }, { provider: 'FAKE' });
      await owner.query(`UPDATE payments SET provider = 'MERCADO_PAGO' WHERE id = $1`, [legado.paymentId]);
      await owner.query(`UPDATE payments SET status = 'APROVADO', paid_at = now() WHERE id = $1`, [legado.paymentId]);
      await owner.query(`UPDATE payments SET needs_manual_refund = true, refund_reason = 'legado' WHERE id = $1`, [legado.paymentId]);
      const { rows } = await owner.query<{ status: string; payment_account_id: string | null }>('SELECT status, payment_account_id FROM payments WHERE id = $1', [legado.paymentId]);
      expect(rows[0]).toEqual({ status: 'APROVADO', payment_account_id: null });
    });

    it('a conta de um pagamento nunca muda, nem pelo dono do schema', async () => {
      const a = await comunidade();
      const v1 = await conectar(a, { conta: 'MP-IMUT-1' });
      const p = await pagamento(v1);
      const outra = await conectar(a, { conta: 'MP-IMUT-2' });
      await expect(owner.query('UPDATE payments SET payment_account_id = $2 WHERE id = $1', [p.paymentId, outra.accountId])).rejects.toThrow(/nao muda/);
      await expect(owner.query('UPDATE payments SET payment_account_id = NULL WHERE id = $1', [p.paymentId])).rejects.toThrow(/nao muda/);
    });

    it('apply_psp_payment confere a CONTA: aviso consultado com outra conta nao altera o pagamento', async () => {
      const a = await comunidade();
      const va = await conectar(a, { conta: 'MP-APPLY' });
      const p = await pagamento(va);
      const aplicar = (conta: string | null, ctxTenant = a.tenantId) =>
        comoTenant(ctxTenant, (db) =>
          db.query<{ r: string }>(`SELECT app.apply_psp_payment('MERCADO_PAGO',$1,'APROVADO',1000,$2,now(),'{}'::jsonb,$3) AS r`, [p.providerPaymentId, p.orderId, conta]));
      expect((await aplicar(null)).rows[0]!.r).toBe('mismatch'); // sem conta
      const outraConta = await comunidade();
      const vo = await conectar(outraConta, { conta: 'MP-APPLY-OUTRA' });
      expect((await aplicar(vo.accountId)).rows[0]!.r).toBe('mismatch'); // conta de outra comunidade
      const { rows } = await owner.query<{ status: string }>('SELECT status FROM payments WHERE id = $1', [p.paymentId]);
      expect(rows[0]!.status).toBe('PENDENTE');
      // Outra comunidade aplicando nao enxerga o pagamento.
      expect((await aplicar(va.accountId, outraConta.tenantId)).rows[0]!.r).toBe('unknown_payment');
    });

    it('find_payment_route responde do NOSSO registro (comunidade, conta e conta do vendedor)', async () => {
      const a = await comunidade();
      const va = await conectar(a, { conta: 'MP-ROUTE' });
      const p = await pagamento(va);
      const r = await comoTenant(a.tenantId, (db) => db.query('SELECT * FROM app.find_payment_route($1,$2)', ['MERCADO_PAGO', p.providerPaymentId]));
      expect(r.rows[0]).toEqual({ tenant_id: a.tenantId, payment_account_id: va.accountId, provider_account_id: 'MP-ROUTE' });
      expect((await comoTenant(a.tenantId, (db) => db.query('SELECT * FROM app.find_payment_route($1,$2)', ['MERCADO_PAGO', '0']))).rowCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  it('a trilha de auditoria registra a conexao, a troca e a desconexao SEM segredo', async () => {
    const c = await comunidade();
    const v1 = await conectar(c, { conta: 'MP-AUD-1', access: 'SEGREDO-ACESSO-XYZ', refresh: 'SEGREDO-REFRESH-XYZ' });
    await conectar(c, { conta: 'MP-AUD-2' });
    await comoTenant(c.tenantId, (db) => db.query(`SELECT app.record_payment_account_event($1,$2,'payment_account.connection_failed','{"reason":"exchange_failed"}'::jsonb)`, [c.tenantId, c.userId]), c.userId);
    void v1;
    const { rows } = await owner.query<{ action: string; blob: string }>(
      `SELECT action, coalesce(before::text,'') || coalesce(after::text,'') AS blob FROM audit_events WHERE tenant_id = $1 AND action LIKE 'payment_account.%' ORDER BY occurred_at`, [c.tenantId]);
    const acoes = rows.map((r) => r.action);
    expect(acoes).toEqual(expect.arrayContaining(['payment_account.connection_started', 'payment_account.connected', 'payment_account.replaced', 'payment_account.disconnected', 'payment_account.connection_failed']));
    for (const r of rows) expect(r.blob).not.toMatch(/SEGREDO|acc-|ref-|token/i);
    // A lista de acoes aceitas e fixa.
    await expect(comoTenant(c.tenantId, (db) => db.query(`SELECT app.record_payment_account_event($1,$2,'qualquer.coisa','{}'::jsonb)`, [c.tenantId, c.userId]), c.userId)).rejects.toThrow(/nao permitida/);
  });
});
