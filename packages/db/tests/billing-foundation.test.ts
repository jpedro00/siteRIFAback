import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BILLING_ADJUSTMENT_KINDS,
  DRAW_STATUSES_THAT_USE_PLAN_SLOT,
  INVOICE_STATUSES,
  PAYMENT_ACCOUNT_STATUSES,
  PAYMENT_AUTHORIZATION_STATUSES,
  PAYMENT_ENVIRONMENTS,
  PAYMENT_PROVIDERS,
  PLAN_INTERVALS,
  PLAN_STATUSES,
  STRIPE_EVENT_STATUSES,
  SUBSCRIPTION_STATUSES,
  DEFAULT_PAST_DUE_GRACE_DAYS,
} from '@clubedarifa/shared';
import { withContext, withPlatform, withTenant } from '../src/context.js';
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
 * Fase 7 · migrations 0018 (assinaturas) e 0019 (recebimentos por comunidade).
 *
 * Tudo que toca dado de comunidade roda pela conexao de RUNTIME (`app_user` ou
 * `app_worker`); o dono do schema so semeia. Nenhum valor comercial e semeado pela
 * migration — os planos daqui sao FIXTURES de teste.
 */
describe.skipIf(!hasTestDatabase)(`Fase 7 · fundacao de assinaturas e recebimentos ${
  hasTestDatabase ? '' : describeSkipReason()
}`, () => {
  let owner: DbPool;
  let app: DbPool;
  let worker: DbPool;

  beforeAll(async () => {
    await ensureMigrated();
    owner = ownerPool();
    app = appPool();
    worker = workerPool();
  }, 120_000);

  afterAll(async () => {
    await owner?.end();
    await app?.end();
    await worker?.end();
  });

  // ---------------------------------------------------------------------------
  // Utilitarios
  // ---------------------------------------------------------------------------
  const dias = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
  const agora = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

  interface Plano {
    id: string;
    priceId: string;
  }

  async function novoPlano(
    extra: { maxDraws?: number | null; maxTeam?: number | null; status?: string } = {},
  ): Promise<Plano> {
    const priceId = unique('price_');
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO plans (code, name, billing_interval, price_cents, stripe_product_id, stripe_price_id,
                          max_active_draws, max_team_members, status)
       VALUES ($1, 'Plano de teste', 'month', 1000, $2, $3, $4, $5, $6::plan_status) RETURNING id`,
      [
        unique('plano-').toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        unique('prod_'),
        priceId,
        extra.maxDraws === undefined ? null : extra.maxDraws,
        extra.maxTeam === undefined ? null : extra.maxTeam,
        extra.status ?? 'AVAILABLE',
      ],
    );
    return { id: rows[0]!.id, priceId };
  }

  interface Comunidade {
    tenantId: string;
    customer: string;
  }

  async function novaComunidade(comCliente = true): Promise<Comunidade> {
    const t = await seedTenant(owner, unique('bill-'), 'Cobranca');
    const customer = unique('cus_');
    if (comCliente) {
      const r = await comoComunidade(t.tenantId, (db) =>
        db.query<{ r: string }>('SELECT app.link_stripe_customer($1, $2) AS r', [t.tenantId, customer]),
      );
      expect(r.rows[0]!.r).toBe('linked');
    }
    return { tenantId: t.tenantId, customer };
  }

  const comoComunidade = <T>(tenantId: string, fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(app, { tenantId }, fn);
  const comoWorker = <T>(fn: (db: import('pg').PoolClient) => Promise<T>) =>
    withTenant(worker, { tenantId: '00000000-0000-0000-0000-000000000000' }, fn);

  interface OpcoesSub {
    subId?: string;
    customer?: string;
    priceId: string;
    status?: string;
    observedAt?: string;
    pastDueAt?: string | null;
    cancelAtPeriodEnd?: boolean;
  }

  async function aplicarSub(
    contextoTenant: string,
    paraTenant: string,
    o: OpcoesSub & { customer: string; subId: string },
  ): Promise<string> {
    const { rows } = await comoComunidade(contextoTenant, (db) =>
      db.query<{ r: string }>(
        `SELECT app.apply_stripe_subscription(
           $1, $2, $3, $4, $5::subscription_status, $6, $7, $8, NULL, NULL, NULL, $9, $10) AS r`,
        [
          paraTenant,
          o.subId,
          o.customer,
          o.priceId,
          o.status ?? 'active',
          agora(-86_400_000),
          dias(30),
          o.cancelAtPeriodEnd ?? false,
          o.pastDueAt ?? null,
          o.observedAt ?? agora(),
        ],
      ),
    );
    return rows[0]!.r;
  }

  const subDe = async (subId: string) =>
    (
      await owner.query<{ status: string; past_due_since: Date | null; stripe_synced_at: Date; plan_id: string }>(
        'SELECT status, past_due_since, stripe_synced_at, plan_id FROM tenant_subscriptions WHERE stripe_subscription_id = $1',
        [subId],
      )
    ).rows;

  async function estadoDe(tenantId: string): Promise<string> {
    const r = await comoComunidade(tenantId, (db) =>
      db.query<{ s: string }>('SELECT app.tenant_billing_state($1) AS s', [tenantId]),
    );
    return r.rows[0]!.s;
  }

  async function ligarCobranca(ligada: boolean, dias_tolerancia = 3): Promise<void> {
    await owner.query('UPDATE billing_settings SET enforcement_enabled = $1, past_due_grace_days = $2', [
      ligada,
      dias_tolerancia,
    ]);
  }

  async function novoSorteio(tenantId: string, status = 'RASCUNHO'): Promise<string> {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers)
       VALUES ($1, $2, 'T', 'P', 1000, 100) RETURNING id`,
      [tenantId, unique('d-')],
    );
    if (status === 'ARQUIVADA') {
      // Arquivar exige a entrega registrada (0021): o caminho legitimo passa por RESULTADO PUBLICADO.
      await owner.query(`UPDATE draws SET status = 'RESULTADO PUBLICADO' WHERE id = $1`, [rows[0]!.id]);
      await owner.query(
        `INSERT INTO draw_deliveries (tenant_id, draw_id, method, delivered_at) VALUES ($1, $2, 'RETIRADA', now())`,
        [tenantId, rows[0]!.id],
      );
      await owner.query(`UPDATE draws SET status = 'ARQUIVADA' WHERE id = $1`, [rows[0]!.id]);
    } else if (status !== 'RASCUNHO') {
      await owner.query('UPDATE draws SET status = $2::draw_status WHERE id = $1', [rows[0]!.id, status]);
    }
    return rows[0]!.id;
  }

  const check = async (tenantId: string) =>
    (
      await comoComunidade(tenantId, (db) =>
        db.query<{ allowed: boolean; reason: string; used: number; max_allowed: number | null }>(
          'SELECT * FROM app.check_draw_submission($1)',
          [tenantId],
        ),
      )
    ).rows[0]!;

  beforeAll(async () => {
    await resetFoundationTables();
  });

  // ---------------------------------------------------------------------------
  describe('vocabularios: banco e shared dizem a mesma coisa', () => {
    const enumDoBanco = async (nome: string) =>
      (
        await owner.query<{ label: string }>(
          `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
            WHERE t.typname = $1 ORDER BY e.enumsortorder`,
          [nome],
        )
      ).rows.map((r) => r.label);

    const casos: [string, readonly string[]][] = [
      ['subscription_status', SUBSCRIPTION_STATUSES],
      ['invoice_status', INVOICE_STATUSES],
      ['plan_status', PLAN_STATUSES],
      ['plan_interval', PLAN_INTERVALS],
      ['stripe_event_status', STRIPE_EVENT_STATUSES],
      ['billing_adjustment_kind', BILLING_ADJUSTMENT_KINDS],
      ['payment_provider', PAYMENT_PROVIDERS],
      ['payment_environment', PAYMENT_ENVIRONMENTS],
      ['payment_account_status', PAYMENT_ACCOUNT_STATUSES],
      ['payment_authorization_status', PAYMENT_AUTHORIZATION_STATUSES],
    ];
    for (const [tipo, lista] of casos) {
      it(`${tipo}`, async () => {
        expect(await enumDoBanco(tipo)).toEqual([...lista]);
      });
    }

    it('a tolerancia padrao de past_due e a mesma do shared', async () => {
      const { rows } = await owner.query<{ past_due_grace_days: number; enforcement_enabled: boolean }>(
        'SELECT past_due_grace_days, enforcement_enabled FROM billing_settings',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.past_due_grace_days).toBe(DEFAULT_PAST_DUE_GRACE_DAYS);
      expect(rows[0]!.enforcement_enabled).toBe(false);
    });

    it('as migrations nao semeiam nenhum plano (nenhum valor comercial)', () => {
      const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
      for (const arquivo of readdirSync(dir).filter((f) => /^001[89]_/.test(f))) {
        const sql = readFileSync(join(dir, arquivo), 'utf8');
        expect(sql, arquivo).not.toMatch(/INSERT INTO\s+(public\.)?plans\b/i);
      }
    });

    it('a franquia conta exatamente REVISAO, AGENDADA, ATIVA e PAUSADA', async () => {
      const c = await novaComunidade();
      const plano = await novoPlano({ maxDraws: 100 });
      await aplicarSub(c.tenantId, c.tenantId, { subId: unique('sub_'), customer: c.customer, priceId: plano.priceId });
      const todos = [
        'RASCUNHO', 'REVISÃO COMPLIANCE', 'AGENDADA', 'ATIVA', 'PAUSADA',
        'VENDAS ENCERRADAS', 'APURAÇÃO', 'RESULTADO PUBLICADO', 'ARQUIVADA', 'CANCELADA',
      ];
      for (const st of todos) await novoSorteio(c.tenantId, st);
      const r = await comoComunidade(c.tenantId, (db) =>
        db.query<{ n: number }>('SELECT app.tenant_active_draw_count($1) AS n', [c.tenantId]),
      );
      expect(r.rows[0]!.n).toBe(DRAW_STATUSES_THAT_USE_PLAN_SLOT.length);
    });
  });

  // ---------------------------------------------------------------------------
  describe('planos', () => {
    it('preco, periodicidade e moeda de plano sincronizado NAO mudam', async () => {
      const p = await novoPlano();
      await expect(owner.query('UPDATE plans SET price_cents = 2000 WHERE id = $1', [p.id])).rejects.toThrow(
        /crie um plano novo/,
      );
      await expect(
        owner.query(`UPDATE plans SET billing_interval = 'year' WHERE id = $1`, [p.id]),
      ).rejects.toThrow(/crie um plano novo/);
      await expect(owner.query(`UPDATE plans SET stripe_price_id = 'price_outro' WHERE id = $1`, [p.id])).rejects.toThrow(
        /crie um plano novo/,
      );
      // Limites, nome e estado seguem editaveis.
      await owner.query(`UPDATE plans SET max_active_draws = 7, status = 'ARCHIVED' WHERE id = $1`, [p.id]);
    });

    it('plano so fica AVAILABLE se existe na Stripe', async () => {
      await expect(
        owner.query(
          `INSERT INTO plans (code, name, billing_interval, price_cents, status)
           VALUES ($1, 'Sem Stripe', 'month', 1000, 'AVAILABLE')`,
          [unique('sem-').toLowerCase().replace(/[^a-z0-9-]/g, '-')],
        ),
      ).rejects.toThrow(/plans_available_needs_stripe/);
    });

    it('a comunidade ve so os planos A VENDA; nao cria nem edita plano', async () => {
      const aVenda = await novoPlano();
      const rascunho = await novoPlano({ status: 'DRAFT' });
      const c = await novaComunidade();
      const r = await comoComunidade(c.tenantId, (db) => db.query<{ id: string }>('SELECT id FROM plans'));
      const ids = r.rows.map((x) => x.id);
      expect(ids).toContain(aVenda.id);
      expect(ids).not.toContain(rascunho.id);

      await expect(
        comoComunidade(c.tenantId, (db) =>
          db.query(
            `INSERT INTO plans (code, name, billing_interval, price_cents) VALUES ('hack-plan', 'x', 'month', 1)`,
          ),
        ),
      ).rejects.toThrow(/row-level security|permission denied/i);
      const alterou = await comoComunidade(c.tenantId, (db) =>
        db.query('UPDATE plans SET max_active_draws = 999 WHERE id = $1', [aVenda.id]),
      );
      expect(alterou.rowCount).toBe(0);
    });

    it('a comunidade continua vendo o plano que contratou, mesmo arquivado', async () => {
      const p = await novoPlano();
      const c = await novaComunidade();
      await aplicarSub(c.tenantId, c.tenantId, { subId: unique('sub_'), customer: c.customer, priceId: p.priceId });
      await owner.query(`UPDATE plans SET status = 'ARCHIVED' WHERE id = $1`, [p.id]);
      const r = await comoComunidade(c.tenantId, (db) => db.query('SELECT id FROM plans WHERE id = $1', [p.id]));
      expect(r.rowCount).toBe(1);
      const outra = await novaComunidade();
      const r2 = await comoComunidade(outra.tenantId, (db) => db.query('SELECT id FROM plans WHERE id = $1', [p.id]));
      expect(r2.rowCount).toBe(0);
    });

    it('so um Super Admin de verdade edita o catalogo e a politica de cobranca', async () => {
      const admin = await seedUser(owner, `${unique('adm-')}@x.test`, 'Admin');
      await owner.query("INSERT INTO platform_admins (user_id, role) VALUES ($1, 'PLATFORM_FINANCE')", [admin.userId]);
      const codigo = unique('cat-').toLowerCase().replace(/[^a-z0-9-]/g, '-');
      await withPlatform(app, { userId: admin.userId }, (db) =>
        db.query(
          `INSERT INTO plans (code, name, billing_interval, price_cents) VALUES ($1, 'Catalogo', 'month', 1)`,
          [codigo],
        ),
      );
      await withPlatform(app, { userId: admin.userId }, (db) =>
        db.query('UPDATE billing_settings SET past_due_grace_days = 5'),
      );
      const { rows } = await owner.query<{ past_due_grace_days: number }>('SELECT past_due_grace_days FROM billing_settings');
      expect(rows[0]!.past_due_grace_days).toBe(5);

      // Organizador: nem le nem escreve a politica.
      const c = await novaComunidade();
      const le = await comoComunidade(c.tenantId, (db) => db.query('SELECT * FROM billing_settings'));
      expect(le.rowCount).toBe(0);
      const escreve = await comoComunidade(c.tenantId, (db) => db.query('UPDATE billing_settings SET past_due_grace_days = 90'));
      expect(escreve.rowCount).toBe(0);
      await ligarCobranca(false);
    });
  });

  // ---------------------------------------------------------------------------
  describe('cliente Stripe · uma comunidade, um cliente', () => {
    it('vincula, repete sem efeito e recusa cliente de outra comunidade', async () => {
      const a = await novaComunidade();
      const again = await comoComunidade(a.tenantId, (db) =>
        db.query<{ r: string }>('SELECT app.link_stripe_customer($1, $2) AS r', [a.tenantId, a.customer]),
      );
      expect(again.rows[0]!.r).toBe('already_linked');

      const b = await novaComunidade(false);
      const roubo = await comoComunidade(b.tenantId, (db) =>
        db.query<{ r: string }>('SELECT app.link_stripe_customer($1, $2) AS r', [b.tenantId, a.customer]),
      );
      expect(roubo.rows[0]!.r).toBe('customer_of_other_tenant');

      const outro = await comoComunidade(a.tenantId, (db) =>
        db.query<{ r: string }>('SELECT app.link_stripe_customer($1, $2) AS r', [a.tenantId, unique('cus_')]),
      );
      expect(outro.rows[0]!.r).toBe('tenant_has_other_customer');
    });

    it('a comunidade B nao mexe no cliente da A', async () => {
      const a = await novaComunidade(false);
      const b = await novaComunidade(false);
      const r = await comoComunidade(b.tenantId, (db) =>
        db.query<{ r: string }>('SELECT app.link_stripe_customer($1, $2) AS r', [a.tenantId, unique('cus_')]),
      );
      expect(r.rows[0]!.r).toBe('forbidden');
    });

    it('identifica a comunidade pelo cliente que NOS criamos', async () => {
      const a = await novaComunidade();
      const r = await comoComunidade(a.tenantId, (db) =>
        db.query<{ t: string | null }>('SELECT app.resolve_tenant_by_stripe_customer($1) AS t', [a.customer]),
      );
      expect(r.rows[0]!.t).toBe(a.tenantId);
      const nada = await comoComunidade(a.tenantId, (db) =>
        db.query<{ t: string | null }>('SELECT app.resolve_tenant_by_stripe_customer($1) AS t', ['cus_desconhecido']),
      );
      expect(nada.rows[0]!.t).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  describe('assinatura · idempotencia, ordem e isolamento', () => {
    it('cria a assinatura, audita, e o evento repetido nao duplica nada', async () => {
      const plano = await novoPlano();
      const c = await novaComunidade();
      const subId = unique('sub_');
      const o = { subId, customer: c.customer, priceId: plano.priceId, observedAt: agora() };

      expect(await aplicarSub(c.tenantId, c.tenantId, o)).toBe('applied');
      expect(await aplicarSub(c.tenantId, c.tenantId, o)).toBe('applied'); // duplicado
      expect(await aplicarSub(c.tenantId, c.tenantId, o)).toBe('applied');

      expect(await subDe(subId)).toHaveLength(1);
      const { rows } = await owner.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_events WHERE tenant_id = $1 AND action = 'billing.subscription_synced' AND target_id = $2`,
        [c.tenantId, subId],
      );
      expect(Number(rows[0]!.n)).toBe(1);
    });

    it('estado ANTIGO nunca sobrepoe estado NOVO (fora de ordem)', async () => {
      const plano = await novoPlano();
      const c = await novaComunidade();
      const subId = unique('sub_');
      const t0 = Date.now();
      const em = (ms: number) => new Date(t0 + ms).toISOString();

      // Chega primeiro o evento MAIS RECENTE (cancelada), depois o antigo (ativa).
      expect(await aplicarSub(c.tenantId, c.tenantId, { subId, customer: c.customer, priceId: plano.priceId, status: 'canceled', observedAt: em(2000) })).toBe('applied');
      expect(await aplicarSub(c.tenantId, c.tenantId, { subId, customer: c.customer, priceId: plano.priceId, status: 'active', observedAt: em(1000) })).toBe('stale');
      expect((await subDe(subId))[0]!.status).toBe('canceled');
      // Um evento posterior ainda vale.
      expect(await aplicarSub(c.tenantId, c.tenantId, { subId, customer: c.customer, priceId: plano.priceId, status: 'active', observedAt: em(3000) })).toBe('applied');
      expect((await subDe(subId))[0]!.status).toBe('active');
    });

    it('processamento CONCORRENTE do mesmo evento gera UMA assinatura', async () => {
      const plano = await novoPlano();
      const c = await novaComunidade();
      const subId = unique('sub_');
      const o = { subId, customer: c.customer, priceId: plano.priceId, observedAt: agora() };
      const rs = await Promise.all(Array.from({ length: 8 }, () => aplicarSub(c.tenantId, c.tenantId, o)));
      expect(rs.every((r) => r === 'applied')).toBe(true);
      expect(await subDe(subId)).toHaveLength(1);
    });

    it('concorrencia entre estado ANTIGO e NOVO: o novo sempre prevalece', async () => {
      const plano = await novoPlano();
      for (let rodada = 0; rodada < 5; rodada++) {
        const c = await novaComunidade();
        const subId = unique('sub_');
        const t0 = Date.now();
        await aplicarSub(c.tenantId, c.tenantId, { subId, customer: c.customer, priceId: plano.priceId, status: 'incomplete', observedAt: new Date(t0).toISOString() });
        await Promise.all([
          aplicarSub(c.tenantId, c.tenantId, { subId, customer: c.customer, priceId: plano.priceId, status: 'active', observedAt: new Date(t0 + 1000).toISOString() }),
          aplicarSub(c.tenantId, c.tenantId, { subId, customer: c.customer, priceId: plano.priceId, status: 'incomplete', observedAt: new Date(t0 + 500).toISOString() }),
          aplicarSub(c.tenantId, c.tenantId, { subId, customer: c.customer, priceId: plano.priceId, status: 'past_due', observedAt: new Date(t0 + 700).toISOString(), pastDueAt: new Date(t0 + 700).toISOString() }),
        ]);
        expect((await subDe(subId))[0]!.status, `rodada ${rodada}`).toBe('active');
      }
    });

    it('a comunidade B nao usa a assinatura nem o cliente da A', async () => {
      const plano = await novoPlano();
      const a = await novaComunidade();
      const b = await novaComunidade();
      const subA = unique('sub_');
      await aplicarSub(a.tenantId, a.tenantId, { subId: subA, customer: a.customer, priceId: plano.priceId });

      // B tenta gravar uma assinatura com o cliente de A.
      expect(await aplicarSub(b.tenantId, b.tenantId, { subId: unique('sub_'), customer: a.customer, priceId: plano.priceId })).toBe('customer_mismatch');
      // B tenta assumir a assinatura de A com o proprio cliente.
      expect(await aplicarSub(b.tenantId, b.tenantId, { subId: subA, customer: b.customer, priceId: plano.priceId, status: 'canceled', observedAt: dias(1) })).toBe('customer_mismatch');
      expect((await subDe(subA))[0]!.status).toBe('active');
      // B, no contexto de B, nao grava para A.
      expect(await aplicarSub(b.tenantId, a.tenantId, { subId: unique('sub_'), customer: a.customer, priceId: plano.priceId })).toBe('forbidden');

      const { rows } = await owner.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_events WHERE tenant_id = $1 AND action IN ('billing.customer_mismatch','billing.subscription_mismatch')`,
        [b.tenantId],
      );
      expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(2);
    });

    it('a comunidade nao le assinaturas nem faturas de outra (RLS)', async () => {
      const plano = await novoPlano();
      const a = await novaComunidade();
      const b = await novaComunidade();
      await aplicarSub(a.tenantId, a.tenantId, { subId: unique('sub_'), customer: a.customer, priceId: plano.priceId });
      const vistoPorB = await comoComunidade(b.tenantId, (db) => db.query('SELECT * FROM tenant_subscriptions'));
      expect(vistoPorB.rowCount).toBe(0);
      const vistoPorA = await comoComunidade(a.tenantId, (db) => db.query('SELECT * FROM tenant_subscriptions'));
      expect(vistoPorA.rowCount).toBe(1);
      const cliente = await comoComunidade(b.tenantId, (db) => db.query('SELECT * FROM tenant_billing'));
      expect(cliente.rows.map((r) => r.tenant_id)).toEqual([b.tenantId]);
    });

    it('preco desconhecido: o evento fica para reprocessar, nada e gravado', async () => {
      const c = await novaComunidade();
      const subId = unique('sub_');
      expect(await aplicarSub(c.tenantId, c.tenantId, { subId, customer: c.customer, priceId: 'price_que_nao_existe' })).toBe('unknown_plan');
      expect(await subDe(subId)).toHaveLength(0);
    });

    it('nao existem duas assinaturas VIVAS na mesma comunidade', async () => {
      const plano = await novoPlano();
      const c = await novaComunidade();
      await aplicarSub(c.tenantId, c.tenantId, { subId: unique('sub_'), customer: c.customer, priceId: plano.priceId });
      await expect(
        aplicarSub(c.tenantId, c.tenantId, { subId: unique('sub_'), customer: c.customer, priceId: plano.priceId }),
      ).rejects.toThrow(/tenant_subscriptions_one_live/);
    });

    it('runtime nao escreve nas tabelas de cobranca diretamente', async () => {
      const c = await novaComunidade();
      for (const tabela of ['tenant_subscriptions', 'tenant_billing', 'billing_invoices', 'stripe_webhook_events']) {
        await expect(
          comoComunidade(c.tenantId, (db) => db.query(`DELETE FROM ${tabela}`)),
          tabela,
        ).rejects.toThrow(/permission denied/i);
      }
    });

    it('o worker aplica em qualquer comunidade', async () => {
      const plano = await novoPlano();
      const c = await novaComunidade();
      const subId = unique('sub_');
      const r = await withContext(worker, { tenantId: null, userId: null, platformAccess: false }, (db) =>
        db.query<{ r: string }>(
          `SELECT app.apply_stripe_subscription($1,$2,$3,$4,'active',now(),now() + interval '30 days',false,NULL,NULL,NULL,NULL,now()) AS r`,
          [c.tenantId, subId, c.customer, plano.priceId],
        ),
      );
      expect(r.rows[0]!.r).toBe('applied');
    });
  });

  // ---------------------------------------------------------------------------
  describe('past_due · tolerancia com referencia persistente', () => {
    it('grava a entrada, MANTEM com webhook repetido e limpa ao sair', async () => {
      const plano = await novoPlano();
      const c = await novaComunidade();
      const subId = unique('sub_');
      const desde = new Date(Date.now() - 2 * 86_400_000);
      const base = { subId, customer: c.customer, priceId: plano.priceId, status: 'past_due' };

      await aplicarSub(c.tenantId, c.tenantId, { ...base, pastDueAt: desde.toISOString(), observedAt: agora(-5000) });
      const primeira = (await subDe(subId))[0]!.past_due_since!;
      expect(new Date(primeira).toISOString()).toBe(desde.toISOString());

      // Webhook duplicado, e outro evento past_due mais novo com "novo" past_due_at:
      // a referencia NAO anda.
      await aplicarSub(c.tenantId, c.tenantId, { ...base, pastDueAt: desde.toISOString(), observedAt: agora(-4000) });
      await aplicarSub(c.tenantId, c.tenantId, { ...base, pastDueAt: agora(), observedAt: agora() });
      expect(new Date((await subDe(subId))[0]!.past_due_since!).toISOString()).toBe(desde.toISOString());

      // Pagou: sai de past_due e a referencia some.
      await aplicarSub(c.tenantId, c.tenantId, { ...base, status: 'active', observedAt: agora(1000) });
      expect((await subDe(subId))[0]!.past_due_since).toBeNull();

      // Novo atraso = nova contagem.
      const novo = new Date(Date.now() + 5000);
      await aplicarSub(c.tenantId, c.tenantId, { ...base, pastDueAt: novo.toISOString(), observedAt: agora(2000) });
      expect(new Date((await subDe(subId))[0]!.past_due_since!).toISOString()).toBe(novo.toISOString());
    });

    it('past_due sem referencia e impossivel (CHECK)', async () => {
      const plano = await novoPlano();
      const c = await novaComunidade();
      await expect(
        owner.query(
          `INSERT INTO tenant_subscriptions (tenant_id, plan_id, stripe_customer_id, stripe_subscription_id, status, stripe_synced_at)
           VALUES ($1, $2, $3, $4, 'past_due', now())`,
          [c.tenantId, plano.id, c.customer, unique('sub_')],
        ),
      ).rejects.toThrow(/past_due_reference/);
    });

    it('o estado de cobranca segue a tolerancia configurada', async () => {
      const plano = await novoPlano();
      const c = await novaComunidade();
      expect(await estadoDe(c.tenantId)).toBe('NO_SUBSCRIPTION');
      const subId = unique('sub_');
      const base = { subId, customer: c.customer, priceId: plano.priceId };

      await aplicarSub(c.tenantId, c.tenantId, { ...base, status: 'incomplete', observedAt: agora(-9000) });
      expect(await estadoDe(c.tenantId)).toBe('PENDING');
      await aplicarSub(c.tenantId, c.tenantId, { ...base, status: 'active', observedAt: agora(-8000) });
      expect(await estadoDe(c.tenantId)).toBe('ACTIVE');

      // Atrasada ha 1 dia: dentro dos 3 dias.
      await aplicarSub(c.tenantId, c.tenantId, { ...base, status: 'past_due', pastDueAt: dias(-1), observedAt: agora(-7000) });
      expect(await estadoDe(c.tenantId)).toBe('PAST_DUE_GRACE');
      // O Super Admin encurta a tolerancia para 0: passa a bloqueada.
      await ligarCobranca(false, 0);
      expect(await estadoDe(c.tenantId)).toBe('PAST_DUE_BLOCKED');
      await ligarCobranca(false, 3);
      expect(await estadoDe(c.tenantId)).toBe('PAST_DUE_GRACE');

      // Atrasada ha 4 dias: fora.
      await aplicarSub(c.tenantId, c.tenantId, { ...base, status: 'active', observedAt: agora(-6000) });
      await aplicarSub(c.tenantId, c.tenantId, { ...base, status: 'past_due', pastDueAt: dias(-4), observedAt: agora(-5000) });
      expect(await estadoDe(c.tenantId)).toBe('PAST_DUE_BLOCKED');

      await aplicarSub(c.tenantId, c.tenantId, { ...base, status: 'canceled', observedAt: agora(-4000) });
      expect(await estadoDe(c.tenantId)).toBe('CANCELED');
    });

    it('o estado de outra comunidade nao e revelado', async () => {
      const a = await novaComunidade();
      const b = await novaComunidade();
      const r = await comoComunidade(b.tenantId, (db) =>
        db.query<{ s: string | null }>('SELECT app.tenant_billing_state($1) AS s', [a.tenantId]),
      );
      expect(r.rows[0]!.s).toBeNull();
      const e = await comoComunidade(b.tenantId, (db) => db.query('SELECT * FROM app.tenant_entitlements($1)', [a.tenantId]));
      expect(e.rowCount).toBe(0);
      const cnt = await comoComunidade(b.tenantId, (db) =>
        db.query<{ n: number | null }>('SELECT app.tenant_active_draw_count($1) AS n', [a.tenantId]),
      );
      expect(cnt.rows[0]!.n).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  describe('limites do plano · envio de sorteio para revisao', () => {
    it('com a cobranca DESLIGADA (padrao) nada e barrado', async () => {
      await ligarCobranca(false);
      const c = await novaComunidade(false);
      const r = await check(c.tenantId);
      expect(r.allowed).toBe(true);
      expect(r.reason).toBe('ENFORCEMENT_OFF');
    });

    it('ligada: sem assinatura, pendente, atrasada fora da tolerancia ou cancelada = bloqueado', async () => {
      await ligarCobranca(true);
      try {
        const plano = await novoPlano({ maxDraws: 10 });
        const c = await novaComunidade();
        expect((await check(c.tenantId)).reason).toBe('SUBSCRIPTION_NO_SUBSCRIPTION');
        const subId = unique('sub_');
        const base = { subId, customer: c.customer, priceId: plano.priceId };
        await aplicarSub(c.tenantId, c.tenantId, { ...base, status: 'incomplete', observedAt: agora(-9000) });
        expect((await check(c.tenantId)).reason).toBe('SUBSCRIPTION_PENDING');
        await aplicarSub(c.tenantId, c.tenantId, { ...base, status: 'active', observedAt: agora(-8000) });
        expect((await check(c.tenantId)).allowed).toBe(true);
        await aplicarSub(c.tenantId, c.tenantId, { ...base, status: 'past_due', pastDueAt: dias(-1), observedAt: agora(-7000) });
        expect((await check(c.tenantId)).allowed).toBe(true); // dentro da tolerancia
        await aplicarSub(c.tenantId, c.tenantId, { ...base, status: 'active', observedAt: agora(-6000) });
        await aplicarSub(c.tenantId, c.tenantId, { ...base, status: 'past_due', pastDueAt: dias(-4), observedAt: agora(-5000) });
        expect((await check(c.tenantId)).reason).toBe('SUBSCRIPTION_PAST_DUE_BLOCKED');
        await aplicarSub(c.tenantId, c.tenantId, { ...base, status: 'canceled', observedAt: agora(-4000) });
        expect((await check(c.tenantId)).reason).toBe('SUBSCRIPTION_CANCELED');
      } finally {
        await ligarCobranca(false);
      }
    });

    it('rascunho nao consome a franquia; revisao, agendada, ativa e pausada consomem', async () => {
      await ligarCobranca(true);
      try {
        const plano = await novoPlano({ maxDraws: 2 });
        const c = await novaComunidade();
        await aplicarSub(c.tenantId, c.tenantId, { subId: unique('sub_'), customer: c.customer, priceId: plano.priceId });
        for (let i = 0; i < 5; i++) await novoSorteio(c.tenantId); // rascunhos livres
        expect((await check(c.tenantId)).allowed).toBe(true);
        await novoSorteio(c.tenantId, 'REVISÃO COMPLIANCE');
        expect(await check(c.tenantId)).toMatchObject({ allowed: true, used: 1, max_allowed: 2 });
        await novoSorteio(c.tenantId, 'PAUSADA');
        expect(await check(c.tenantId)).toMatchObject({ allowed: false, reason: 'DRAW_LIMIT_REACHED', used: 2 });
        // Encerrar libera a vaga.
        await owner.query(`UPDATE draws SET status = 'VENDAS ENCERRADAS' WHERE tenant_id = $1 AND status = 'PAUSADA'`, [c.tenantId]);
        expect((await check(c.tenantId)).allowed).toBe(true);
      } finally {
        await ligarCobranca(false);
      }
    });

    it('DOWNGRADE acima do novo limite: nada e cancelado, mas nada NOVO entra', async () => {
      await ligarCobranca(true);
      try {
        const grande = await novoPlano({ maxDraws: 5 });
        const pequeno = await novoPlano({ maxDraws: 1 });
        const c = await novaComunidade();
        const subId = unique('sub_');
        await aplicarSub(c.tenantId, c.tenantId, { subId, customer: c.customer, priceId: grande.priceId, observedAt: agora(-2000) });
        await novoSorteio(c.tenantId, 'ATIVA');
        await novoSorteio(c.tenantId, 'ATIVA');
        await novoSorteio(c.tenantId, 'AGENDADA');
        expect((await check(c.tenantId)).allowed).toBe(true);

        await aplicarSub(c.tenantId, c.tenantId, { subId, customer: c.customer, priceId: pequeno.priceId, observedAt: agora(-1000) });
        expect(await check(c.tenantId)).toMatchObject({ allowed: false, reason: 'DRAW_LIMIT_REACHED', used: 3, max_allowed: 1 });
        const { rows } = await owner.query<{ status: string; n: string }>(
          `SELECT status, count(*) AS n FROM draws WHERE tenant_id = $1 GROUP BY status ORDER BY status`,
          [c.tenantId],
        );
        expect(rows.map((r) => `${r.status}:${r.n}`)).toEqual(['AGENDADA:1', 'ATIVA:2']);
      } finally {
        await ligarCobranca(false);
      }
    });

    it('envios CONCORRENTES nunca ultrapassam o limite', async () => {
      await ligarCobranca(true);
      try {
        const plano = await novoPlano({ maxDraws: 2 });
        const c = await novaComunidade();
        await aplicarSub(c.tenantId, c.tenantId, { subId: unique('sub_'), customer: c.customer, priceId: plano.priceId });
        const ids = await Promise.all(Array.from({ length: 6 }, () => novoSorteio(c.tenantId)));

        // Cada solicitacao: checa E envia para revisao NA MESMA transacao (como a API fara).
        const resultados = await Promise.all(
          ids.map((id) =>
            comoComunidade(c.tenantId, async (db) => {
              const { rows } = await db.query<{ allowed: boolean }>('SELECT allowed FROM app.check_draw_submission($1)', [c.tenantId]);
              if (!rows[0]!.allowed) return false;
              await db.query(`UPDATE draws SET status = 'REVISÃO COMPLIANCE' WHERE id = $1`, [id]);
              return true;
            }),
          ),
        );
        expect(resultados.filter(Boolean)).toHaveLength(2);
        const { rows } = await owner.query<{ n: string }>(
          `SELECT count(*) AS n FROM draws WHERE tenant_id = $1 AND status = 'REVISÃO COMPLIANCE'`,
          [c.tenantId],
        );
        expect(Number(rows[0]!.n)).toBe(2);
      } finally {
        await ligarCobranca(false);
      }
    });

    it('INTERCALADO de forma deterministica: a segunda espera o commit da primeira e ja ve a vaga ocupada', async () => {
      await ligarCobranca(true);
      try {
        const plano = await novoPlano({ maxDraws: 1 });
        const c = await novaComunidade();
        await aplicarSub(c.tenantId, c.tenantId, { subId: unique('sub_'), customer: c.customer, priceId: plano.priceId });
        const [d1, d2] = await Promise.all([novoSorteio(c.tenantId), novoSorteio(c.tenantId)]);
        const dorme = (ms: number) => new Promise((r) => setTimeout(r, ms));

        const enviar = (id: string, segurarMs: number) =>
          comoComunidade(c.tenantId, async (db) => {
            const { rows } = await db.query<{ allowed: boolean }>('SELECT allowed FROM app.check_draw_submission($1)', [c.tenantId]);
            if (!rows[0]!.allowed) return false;
            await db.query(`UPDATE draws SET status = 'REVISÃO COMPLIANCE' WHERE id = $1`, [id]);
            // Segura a transacao ABERTA: sem o lock por comunidade, a outra checagem
            // enxergaria a contagem ANTIGA e tambem seria liberada.
            await dorme(segurarMs);
            return true;
          });

        const primeira = enviar(d1, 600);
        await dorme(150);
        const segunda = enviar(d2, 0);
        expect(await Promise.all([primeira, segunda])).toEqual([true, false]);
      } finally {
        await ligarCobranca(false);
      }
    });

    it('uma comunidade nao consome nem enxerga a franquia da outra', async () => {
      await ligarCobranca(true);
      try {
        const plano = await novoPlano({ maxDraws: 1 });
        const a = await novaComunidade();
        const b = await novaComunidade();
        await aplicarSub(a.tenantId, a.tenantId, { subId: unique('sub_'), customer: a.customer, priceId: plano.priceId });
        // B tem sub em OUTRO plano, ilimitado.
        const livre = await novoPlano({ maxDraws: null });
        await aplicarSub(b.tenantId, b.tenantId, { subId: unique('sub_'), customer: b.customer, priceId: livre.priceId });
        await novoSorteio(a.tenantId, 'ATIVA');
        expect((await check(a.tenantId)).allowed).toBe(false);
        for (let i = 0; i < 4; i++) await novoSorteio(b.tenantId, 'ATIVA');
        expect((await check(b.tenantId)).allowed).toBe(true);
        // B perguntando pela A: FORBIDDEN.
        const r = await comoComunidade(b.tenantId, (db) =>
          db.query<{ reason: string }>('SELECT reason FROM app.check_draw_submission($1)', [a.tenantId]),
        );
        expect(r.rows[0]!.reason).toBe('FORBIDDEN');
      } finally {
        await ligarCobranca(false);
      }
    });
  });

  describe('enforcamento no banco · envio de sorteio para revisao (gatilho)', () => {
    const enviar = (tenantId: string, drawId: string, ate: string = 'REVISÃO COMPLIANCE') =>
      comoComunidade(tenantId, (db) => db.query(`UPDATE draws SET status = $2::draw_status WHERE id = $1`, [drawId, ate]));
    const statusDe = async (drawId: string) =>
      (await owner.query<{ status: string }>('SELECT status FROM draws WHERE id = $1', [drawId])).rows[0]!.status;
    const dorme = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('cobranca DESLIGADA: o envio passa sem assinatura nenhuma (padrao)', async () => {
      await ligarCobranca(false);
      const c = await novaComunidade(false);
      const d = await novoSorteio(c.tenantId);
      await enviar(c.tenantId, d);
      expect(await statusDe(d)).toBe('REVISÃO COMPLIANCE');
    });

    it('LIGADA e SEM assinatura: recusa com o motivo; rascunho continua livre', async () => {
      await ligarCobranca(true);
      try {
        const c = await novaComunidade(false);
        const d = await novoSorteio(c.tenantId);
        await novoSorteio(c.tenantId); // criar rascunho nao e barrado
        await comoComunidade(c.tenantId, (db) => db.query(`UPDATE draws SET description = 'editar rascunho e livre' WHERE id = $1`, [d]));
        await expect(enviar(c.tenantId, d)).rejects.toThrow(/ENTITLEMENT:SUBSCRIPTION_NO_SUBSCRIPTION/);
        expect(await statusDe(d)).toBe('RASCUNHO');
      } finally {
        await ligarCobranca(false);
      }
    });

    it('cada estado da politica: ACTIVE, TRIALING e PAST_DUE_GRACE liberam; os demais barram', async () => {
      await ligarCobranca(true);
      try {
        const plano = await novoPlano({ maxDraws: 50 });
        const casos: [string, string | null, boolean, string?][] = [
          ['active', null, true],
          ['trialing', null, true],
          ['past_due', dias(-1), true], // dentro da tolerancia
          ['past_due', dias(-4), false, 'SUBSCRIPTION_PAST_DUE_BLOCKED'],
          ['unpaid', null, false, 'SUBSCRIPTION_UNPAID'],
          ['paused', null, false, 'SUBSCRIPTION_PAUSED'],
          ['canceled', null, false, 'SUBSCRIPTION_CANCELED'],
          ['incomplete', null, false, 'SUBSCRIPTION_PENDING'],
        ];
        for (const [status, pastDueAt, liberado, motivo] of casos) {
          const c = await novaComunidade();
          await aplicarSub(c.tenantId, c.tenantId, { subId: unique('sub_'), customer: c.customer, priceId: plano.priceId, status, pastDueAt });
          const d = await novoSorteio(c.tenantId);
          if (liberado) {
            await enviar(c.tenantId, d);
            expect(await statusDe(d), status).toBe('REVISÃO COMPLIANCE');
          } else {
            await expect(enviar(c.tenantId, d), status).rejects.toThrow(new RegExp(`ENTITLEMENT:${motivo}`));
            expect(await statusDe(d), status).toBe('RASCUNHO');
          }
        }
      } finally {
        await ligarCobranca(false);
      }
    });

    it('limite: a ultima vaga entra, a seguinte e recusada com used/max no detalhe', async () => {
      await ligarCobranca(true);
      try {
        const plano = await novoPlano({ maxDraws: 2 });
        const c = await novaComunidade();
        await aplicarSub(c.tenantId, c.tenantId, { subId: unique('sub_'), customer: c.customer, priceId: plano.priceId });
        const [a, b, x] = await Promise.all([novoSorteio(c.tenantId), novoSorteio(c.tenantId), novoSorteio(c.tenantId)]);
        await enviar(c.tenantId, a!);
        await enviar(c.tenantId, b!);
        const erro = await enviar(c.tenantId, x!).catch((e: { message: string; detail?: string }) => e);
        expect((erro as { message: string }).message).toBe('ENTITLEMENT:DRAW_LIMIT_REACHED');
        expect((erro as { detail?: string }).detail).toBe('used=2;max=2');
      } finally {
        await ligarCobranca(false);
      }
    });

    it('RETOMAR PAUSADA -> ATIVA e aprovar REVISAO -> ATIVA nao consomem vaga (mesmo no limite)', async () => {
      await ligarCobranca(true);
      try {
        const plano = await novoPlano({ maxDraws: 1 });
        const c = await novaComunidade();
        await aplicarSub(c.tenantId, c.tenantId, { subId: unique('sub_'), customer: c.customer, priceId: plano.priceId });
        const pausado = await novoSorteio(c.tenantId, 'PAUSADA'); // ocupa a unica vaga
        await enviar(c.tenantId, pausado, 'ATIVA');
        expect(await statusDe(pausado)).toBe('ATIVA');
        await enviar(c.tenantId, pausado, 'PAUSADA');
        await enviar(c.tenantId, pausado, 'VENDAS ENCERRADAS'); // concluir o que ja vendeu nao e barrado
        expect(await statusDe(pausado)).toBe('VENDAS ENCERRADAS');
      } finally {
        await ligarCobranca(false);
      }
    });

    it('DOWNGRADE acima do limite: nada muda nos sorteios; o envio novo e barrado; o que ja existe segue o ciclo', async () => {
      await ligarCobranca(true);
      try {
        const grande = await novoPlano({ maxDraws: 10 });
        const pequeno = await novoPlano({ maxDraws: 2 });
        const c = await novaComunidade();
        const subId = unique('sub_');
        await aplicarSub(c.tenantId, c.tenantId, { subId, customer: c.customer, priceId: grande.priceId, observedAt: agora(-2000) });
        const ids = await Promise.all(Array.from({ length: 4 }, () => novoSorteio(c.tenantId, 'ATIVA')));
        await aplicarSub(c.tenantId, c.tenantId, { subId, customer: c.customer, priceId: pequeno.priceId, observedAt: agora(-1000) });

        const novo = await novoSorteio(c.tenantId);
        await expect(enviar(c.tenantId, novo)).rejects.toThrow(/ENTITLEMENT:DRAW_LIMIT_REACHED/);
        // Os quatro continuam ATIVA; pausar/retomar/encerrar seguem permitidos.
        await enviar(c.tenantId, ids[0]!, 'PAUSADA');
        await enviar(c.tenantId, ids[0]!, 'ATIVA');
        await enviar(c.tenantId, ids[1]!, 'VENDAS ENCERRADAS');
        expect(await statusDe(ids[2]!)).toBe('ATIVA');
        // Encerrados dois, ainda ha 3 contando (acima do limite 2): segue barrado ate voltar para baixo.
        await expect(enviar(c.tenantId, novo)).rejects.toThrow(/DRAW_LIMIT_REACHED/);
        await enviar(c.tenantId, ids[2]!, 'VENDAS ENCERRADAS');
        // Sobram 2 contando (ids[0] e ids[3]) e o limite e 2: continua barrado — o envio so
        // volta quando a utilizacao ficar ABAIXO do limite.
        await expect(enviar(c.tenantId, novo)).rejects.toThrow(/DRAW_LIMIT_REACHED/);
        await enviar(c.tenantId, ids[3]!, 'VENDAS ENCERRADAS');
        await enviar(c.tenantId, novo); // 1 contando de 2: entra
        expect(await statusDe(novo)).toBe('REVISÃO COMPLIANCE');
      } finally {
        await ligarCobranca(false);
      }
    });

    it('INTERCALADO de forma deterministica: dois envios para a ULTIMA vaga, um entra e o outro e recusado', async () => {
      await ligarCobranca(true);
      try {
        const plano = await novoPlano({ maxDraws: 5 });
        const c = await novaComunidade();
        await aplicarSub(c.tenantId, c.tenantId, { subId: unique('sub_'), customer: c.customer, priceId: plano.priceId });
        for (let i = 0; i < 4; i++) await novoSorteio(c.tenantId, 'ATIVA'); // 4 de 5
        const [d1, d2] = await Promise.all([novoSorteio(c.tenantId), novoSorteio(c.tenantId)]);

        const tentar = (id: string, segurarMs: number) =>
          comoComunidade(c.tenantId, async (db) => {
            await db.query(`UPDATE draws SET status = 'REVISÃO COMPLIANCE' WHERE id = $1`, [id]);
            await dorme(segurarMs); // segura a transacao ABERTA, ja com a vaga tomada
            return true;
          }).catch((e: Error) => (e.message.startsWith('ENTITLEMENT:') ? false : Promise.reject(e)));

        const primeira = tentar(d1!, 600);
        await dorme(150);
        const segunda = tentar(d2!, 0);
        expect(await Promise.all([primeira, segunda])).toEqual([true, false]);
        const { rows } = await owner.query<{ n: string }>(`SELECT count(*) AS n FROM draws WHERE tenant_id = $1 AND status IN ('REVISÃO COMPLIANCE','AGENDADA','ATIVA','PAUSADA')`, [c.tenantId]);
        expect(Number(rows[0]!.n)).toBe(5);
      } finally {
        await ligarCobranca(false);
      }
    });

    it('sem o gatilho o envio simultaneo passaria: o gatilho e o que protege (nao a API)', async () => {
      await ligarCobranca(true);
      try {
        const plano = await novoPlano({ maxDraws: 1 });
        const c = await novaComunidade();
        await aplicarSub(c.tenantId, c.tenantId, { subId: unique('sub_'), customer: c.customer, priceId: plano.priceId });
        const ids = await Promise.all(Array.from({ length: 6 }, () => novoSorteio(c.tenantId)));
        const resultados = await Promise.all(ids.map((id) => enviar(c.tenantId, id).then(() => true, () => false)));
        expect(resultados.filter(Boolean)).toHaveLength(1);
      } finally {
        await ligarCobranca(false);
      }
    });

    it('o dono do schema, o worker e a plataforma (aprovacao) nao sao barrados', async () => {
      await ligarCobranca(true);
      try {
        const c = await novaComunidade(false); // sem assinatura
        const d = await novoSorteio(c.tenantId, 'REVISÃO COMPLIANCE');
        const admin = await seedUser(owner, `${unique('adm-')}@x.test`, 'Admin');
        await owner.query("INSERT INTO platform_admins (user_id, role) VALUES ($1, 'PLATFORM_COMPLIANCE')", [admin.userId]);
        // Aprovar quem JA esta em revisao nao ocupa vaga nova.
        await withContext(app, { userId: admin.userId, tenantId: c.tenantId, platformAccess: true }, (db) =>
          db.query(`UPDATE draws SET status = 'ATIVA' WHERE id = $1`, [d]),
        );
        expect(await statusDe(d)).toBe('ATIVA');
        const r = await novoSorteio(c.tenantId);
        await owner.query(`UPDATE draws SET status = 'REVISÃO COMPLIANCE' WHERE id = $1`, [r]);
      } finally {
        await ligarCobranca(false);
      }
    });
  });

  describe('enforcamento no banco · equipe (aceite de convite)', () => {
    const conviteDe = async (tenantId: string, email: string, role = 'SUPPORT') => {
      const token = randomBytes(32).toString('hex');
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO invitations (tenant_id, email, role, token_hash) VALUES ($1, $2, $3::membership_role, $4) RETURNING id`,
        [tenantId, email.toLowerCase(), role, token],
      );
      return { id: rows[0]!.id, hash: token };
    };
    const aceitar = (userId: string, hash: string, segurarMs = 0) =>
      withContext(app, { userId, tenantId: null, platformAccess: false }, async (db) => {
        const r = await db.query('SELECT * FROM app.accept_invitation($1)', [hash]);
        if (segurarMs) await new Promise((res) => setTimeout(res, segurarMs));
        return r;
      });
    async function pessoa(prefix = 'p-') {
      const email = `${unique(prefix)}@x.test`.toLowerCase();
      const u = await seedUser(owner, email, 'Pessoa');
      return { userId: u.userId, email };
    }
    // A comunidade precisa ter o PROPRIETARIO: ele nao conta na franquia, e sem ele o primeiro a
    // entrar seria o dono (isencao do convite de dono).
    async function dono(tenantId: string) {
      const d = await pessoa('dono-');
      await owner.query(`INSERT INTO memberships (tenant_id, user_id, role, accepted_at) VALUES ($1,$2,'OWNER',now())`, [tenantId, d.userId]);
    }
    async function equipe(tenantId: string, n: number) {
      await dono(tenantId);
      for (let i = 0; i < n; i++) {
        const p = await pessoa('m-');
        await owner.query(`INSERT INTO memberships (tenant_id, user_id, role, accepted_at) VALUES ($1,$2,'SUPPORT',now())`, [tenantId, p.userId]);
      }
    }
    // Membros ALEM do proprietario (a franquia de `max_team_members`).
    const membros = async (tenantId: string) =>
      Number((await owner.query<{ n: number }>('SELECT app.team_member_count_unchecked($1) AS n', [tenantId])).rows[0]!.n);

    it('convite PENDENTE nao consome vaga; so membros vigentes contam', async () => {
      const plano = await novoPlano({ maxTeam: 3 });
      const c = await novaComunidade();
      await aplicarSub(c.tenantId, c.tenantId, { subId: unique('sub_'), customer: c.customer, priceId: plano.priceId });
      await equipe(c.tenantId, 2);
      for (let i = 0; i < 4; i++) await conviteDe(c.tenantId, `${unique('c')}@x.test`);
      const r = await comoComunidade(c.tenantId, (db) => db.query<{ n: number }>('SELECT app.tenant_team_member_count($1) AS n', [c.tenantId]));
      expect(r.rows[0]!.n).toBe(2);
    });

    it('com vaga: aceita; no limite: recusa, o convite continua ABERTO e nenhum vinculo nasce', async () => {
      await ligarCobranca(true);
      try {
        const plano = await novoPlano({ maxTeam: 3 });
        const c = await novaComunidade();
        await aplicarSub(c.tenantId, c.tenantId, { subId: unique('sub_'), customer: c.customer, priceId: plano.priceId });
        await equipe(c.tenantId, 2);

        const p1 = await pessoa();
        const i1 = await conviteDe(c.tenantId, p1.email);
        await aceitar(p1.userId, i1.hash); // 2 -> 3
        expect(await membros(c.tenantId)).toBe(3);

        const p2 = await pessoa();
        const i2 = await conviteDe(c.tenantId, p2.email);
        await expect(aceitar(p2.userId, i2.hash)).rejects.toThrow(/ENTITLEMENT:MEMBER_LIMIT_REACHED/);
        expect(await membros(c.tenantId)).toBe(3);
        const { rows } = await owner.query<{ accepted_at: Date | null }>('SELECT accepted_at FROM invitations WHERE id = $1', [i2.id]);
        expect(rows[0]!.accepted_at).toBeNull();
      } finally {
        await ligarCobranca(false);
      }
    });

    it('ACEITES SIMULTANEOS da ultima vaga: um entra, o outro recebe o limite (intercalado, deterministico)', async () => {
      await ligarCobranca(true);
      try {
        const plano = await novoPlano({ maxTeam: 5 });
        const c = await novaComunidade();
        await aplicarSub(c.tenantId, c.tenantId, { subId: unique('sub_'), customer: c.customer, priceId: plano.priceId });
        await equipe(c.tenantId, 4);
        const [a, b] = [await pessoa(), await pessoa()];
        const [ia, ib] = [await conviteDe(c.tenantId, a.email), await conviteDe(c.tenantId, b.email)];

        const tentar = (p: { userId: string }, i: { hash: string }, segurar: number) =>
          aceitar(p.userId, i.hash, segurar).then(() => true, (e: Error) => (e.message.startsWith('ENTITLEMENT:') ? false : Promise.reject(e)));
        const primeiro = tentar(a, ia, 600);
        await new Promise((r) => setTimeout(r, 150));
        const segundo = tentar(b, ib, 0);
        expect(await Promise.all([primeiro, segundo])).toEqual([true, false]);
        expect(await membros(c.tenantId)).toBe(5);
      } finally {
        await ligarCobranca(false);
      }
    });

    it('seis aceites em paralelo para 2 vagas: exatamente 2 entram', async () => {
      await ligarCobranca(true);
      try {
        const plano = await novoPlano({ maxTeam: 4 });
        const c = await novaComunidade();
        await aplicarSub(c.tenantId, c.tenantId, { subId: unique('sub_'), customer: c.customer, priceId: plano.priceId });
        await equipe(c.tenantId, 2);
        const pares = await Promise.all(
          Array.from({ length: 6 }, async () => {
            const p = await pessoa();
            return { p, i: await conviteDe(c.tenantId, p.email) };
          }),
        );
        const rs = await Promise.all(pares.map(({ p, i }) => aceitar(p.userId, i.hash).then(() => true, () => false)));
        expect(rs.filter(Boolean)).toHaveLength(2);
        expect(await membros(c.tenantId)).toBe(4);
      } finally {
        await ligarCobranca(false);
      }
    });

    it('REMOVER um membro libera a vaga', async () => {
      await ligarCobranca(true);
      try {
        const plano = await novoPlano({ maxTeam: 2 });
        const c = await novaComunidade();
        await aplicarSub(c.tenantId, c.tenantId, { subId: unique('sub_'), customer: c.customer, priceId: plano.priceId });
        await equipe(c.tenantId, 2);
        const p = await pessoa();
        const inv = await conviteDe(c.tenantId, p.email);
        await expect(aceitar(p.userId, inv.hash)).rejects.toThrow(/MEMBER_LIMIT_REACHED/);
        await owner.query(`UPDATE memberships SET revoked_at = now() WHERE id = (SELECT id FROM memberships WHERE tenant_id = $1 AND revoked_at IS NULL AND role <> 'OWNER' LIMIT 1)`, [c.tenantId]);
        await aceitar(p.userId, inv.hash);
        expect(await membros(c.tenantId)).toBe(2);
      } finally {
        await ligarCobranca(false);
      }
    });

    it('quem JA e membro e recebe outro papel nao ocupa vaga; o dono/primeiro membro nunca e barrado', async () => {
      await ligarCobranca(true);
      try {
        const plano = await novoPlano({ maxTeam: 1 });
        const c = await novaComunidade();
        await aplicarSub(c.tenantId, c.tenantId, { subId: unique('sub_'), customer: c.customer, priceId: plano.priceId });
        // Comunidade SEM membros e SEM assinatura: o dono entra (bootstrap do convite de dono).
        const semPlano = await novaComunidade(false);
        const donoNovo = await pessoa('dono-');
        const conviteDono = await conviteDe(semPlano.tenantId, donoNovo.email, 'OWNER');
        await aceitar(donoNovo.userId, conviteDono.hash);
        expect(await membros(semPlano.tenantId)).toBe(0); // o proprietario nao conta na franquia
        const { rows: donos } = await owner.query(`SELECT 1 FROM memberships WHERE tenant_id = $1 AND role = 'OWNER' AND revoked_at IS NULL`, [semPlano.tenantId]);
        expect(donos).toHaveLength(1);

        // Equipe cheia (1 de 1): a mesma pessoa ganha OUTRO papel sem ocupar vaga...
        await dono(c.tenantId);
        const p = await pessoa();
        await owner.query(`INSERT INTO memberships (tenant_id, user_id, role, accepted_at) VALUES ($1,$2,'SUPPORT',now())`, [c.tenantId, p.userId]);
        const outroPapel = await conviteDe(c.tenantId, p.email, 'FINANCE');
        await aceitar(p.userId, outroPapel.hash);
        expect(await membros(c.tenantId)).toBe(1);
        // ... e uma pessoa NOVA e barrada.
        const nova = await pessoa();
        await expect(aceitar(nova.userId, (await conviteDe(c.tenantId, nova.email)).hash)).rejects.toThrow(/MEMBER_LIMIT_REACHED/);
      } finally {
        await ligarCobranca(false);
      }
    });

    it('sem plano (cancelada), com equipe existente: barra; sem cobranca ligada: livre', async () => {
      const c = await novaComunidade(false);
      await equipe(c.tenantId, 1);
      const p = await pessoa();
      const inv = await conviteDe(c.tenantId, p.email);
      await ligarCobranca(true);
      try {
        await expect(aceitar(p.userId, inv.hash)).rejects.toThrow(/ENTITLEMENT:NO_PLAN/);
      } finally {
        await ligarCobranca(false);
      }
      await aceitar(p.userId, inv.hash);
      expect(await membros(c.tenantId)).toBe(2);
    });

    it('convite revogado, vencido, usado ou de e-mail alheio: as respostas de sempre, nunca o limite', async () => {
      await ligarCobranca(true);
      try {
        const plano = await novoPlano({ maxTeam: 1 });
        const c = await novaComunidade();
        await aplicarSub(c.tenantId, c.tenantId, { subId: unique('sub_'), customer: c.customer, priceId: plano.priceId });
        await equipe(c.tenantId, 1); // cheia
        const p = await pessoa();
        const revogado = await conviteDe(c.tenantId, p.email);
        await owner.query('UPDATE invitations SET revoked_at = now() WHERE id = $1', [revogado.id]);
        await expect(aceitar(p.userId, revogado.hash)).rejects.toThrow(/convite encerrado|P0001/i);
        await expect(aceitar(p.userId, revogado.hash)).rejects.not.toThrow(/ENTITLEMENT/);

        const vencido = await conviteDe(c.tenantId, p.email);
        await owner.query(`UPDATE invitations SET expires_at = now() - interval '1 day' WHERE id = $1`, [vencido.id]);
        await expect(aceitar(p.userId, vencido.hash)).rejects.not.toThrow(/ENTITLEMENT/);

        const alheio = await pessoa();
        const alvo = await pessoa();
        const deOutro = await conviteDe(c.tenantId, alvo.email);
        await expect(aceitar(alheio.userId, deOutro.hash)).rejects.toThrow(/convite inexistente|P0002/i);
      } finally {
        await ligarCobranca(false);
      }
    });

    it('a franquia de uma comunidade nao interfere na outra', async () => {
      await ligarCobranca(true);
      try {
        const cheio = await novoPlano({ maxTeam: 1 });
        const folgado = await novoPlano({ maxTeam: 10 });
        const a = await novaComunidade();
        const b = await novaComunidade();
        await aplicarSub(a.tenantId, a.tenantId, { subId: unique('sub_'), customer: a.customer, priceId: cheio.priceId });
        await aplicarSub(b.tenantId, b.tenantId, { subId: unique('sub_'), customer: b.customer, priceId: folgado.priceId });
        await equipe(a.tenantId, 1);
        await equipe(b.tenantId, 3);
        const p = await pessoa();
        await aceitar(p.userId, (await conviteDe(b.tenantId, p.email)).hash); // B aceita
        const q = await pessoa();
        await expect(aceitar(q.userId, (await conviteDe(a.tenantId, q.email)).hash)).rejects.toThrow(/MEMBER_LIMIT_REACHED/);
        expect(await membros(b.tenantId)).toBe(4);
      } finally {
        await ligarCobranca(false);
      }
    });
  });

  describe('funcionalidades do plano', () => {
    const verdict = (tenantId: string, feature: string, ctx = tenantId) =>
      comoComunidade(ctx, (db) => db.query<{ allowed: boolean; reason: string }>('SELECT * FROM app.tenant_feature_verdict($1,$2)', [tenantId, feature]));

    it('desligada: liberada; ligada: so com o direito comercial E o plano vigente que a inclui', async () => {
      const comFeature = await novoPlano();
      await owner.query(`UPDATE plans SET features = ARRAY['relatorios-avancados'] WHERE id = $1`, [comFeature.id]);
      const semFeature = await novoPlano();
      const a = await novaComunidade();
      const b = await novaComunidade();
      await aplicarSub(a.tenantId, a.tenantId, { subId: unique('sub_'), customer: a.customer, priceId: comFeature.priceId });
      await aplicarSub(b.tenantId, b.tenantId, { subId: unique('sub_'), customer: b.customer, priceId: semFeature.priceId });

      expect((await verdict(b.tenantId, 'relatorios-avancados')).rows[0]).toEqual({ allowed: true, reason: 'ENFORCEMENT_OFF' });
      await ligarCobranca(true);
      try {
        expect((await verdict(a.tenantId, 'relatorios-avancados')).rows[0]).toEqual({ allowed: true, reason: 'OK' });
        expect((await verdict(b.tenantId, 'relatorios-avancados')).rows[0]).toEqual({ allowed: false, reason: 'FEATURE_NOT_IN_PLAN' });
        // Outra comunidade perguntando pela A: FORBIDDEN.
        expect((await verdict(a.tenantId, 'relatorios-avancados', b.tenantId)).rows[0]).toEqual({ allowed: false, reason: 'FORBIDDEN' });
      } finally {
        await ligarCobranca(false);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('faturas e ajustes da plataforma (separados de orders/payments)', () => {
    async function fatura(tenantId: string, invoiceId: string, o: { customer: string; subId?: string | null; status?: string; observedAt?: string; due?: number; paid?: number }) {
      const r = await comoComunidade(tenantId, (db) =>
        db.query<{ r: string }>(
          `SELECT app.apply_stripe_invoice($1,$2,$3,$4,$5::invoice_status,'BRL',$6,$7,$8,1,now(),now() + interval '30 days',NULL,NULL,now(),$9) AS r`,
          [tenantId, invoiceId, o.customer, o.subId ?? null, o.status ?? 'open', o.due ?? 1000, o.paid ?? 0, (o.due ?? 1000) - (o.paid ?? 0), o.observedAt ?? agora()],
        ),
      );
      return r.rows[0]!.r;
    }

    it('grava, ignora o antigo e nao regride pago para aberto', async () => {
      const c = await novaComunidade();
      const inv = unique('in_');
      const t0 = Date.now();
      expect(await fatura(c.tenantId, inv, { customer: c.customer, status: 'paid', paid: 1000, observedAt: new Date(t0 + 2000).toISOString() })).toBe('applied');
      expect(await fatura(c.tenantId, inv, { customer: c.customer, status: 'open', observedAt: new Date(t0 + 1000).toISOString() })).toBe('stale');
      const { rows } = await owner.query<{ status: string; amount_paid_cents: string }>('SELECT status, amount_paid_cents FROM billing_invoices WHERE stripe_invoice_id = $1', [inv]);
      expect(rows[0]).toMatchObject({ status: 'paid', amount_paid_cents: '1000' });
    });

    it('fatura que chega ANTES da assinatura passa a apontar para ela depois', async () => {
      const plano = await novoPlano();
      const c = await novaComunidade();
      const inv = unique('in_');
      const subId = unique('sub_');
      await fatura(c.tenantId, inv, { customer: c.customer, subId });
      let r = await owner.query<{ subscription_id: string | null }>('SELECT subscription_id FROM billing_invoices WHERE stripe_invoice_id = $1', [inv]);
      expect(r.rows[0]!.subscription_id).toBeNull();
      await aplicarSub(c.tenantId, c.tenantId, { subId, customer: c.customer, priceId: plano.priceId });
      r = await owner.query('SELECT subscription_id FROM billing_invoices WHERE stripe_invoice_id = $1', [inv]);
      expect(r.rows[0]!.subscription_id).not.toBeNull();
    });

    it('fatura de cliente alheio e recusada e a FK composta impede o vinculo por SQL', async () => {
      const a = await novaComunidade();
      const b = await novaComunidade();
      expect(await fatura(b.tenantId, unique('in_'), { customer: a.customer })).toBe('customer_mismatch');
      await expect(
        owner.query(
          `INSERT INTO billing_invoices (tenant_id, stripe_invoice_id, stripe_customer_id, status, currency, amount_due_cents, stripe_synced_at)
           VALUES ($1, $2, $3, 'open', 'brl', 1, now())`,
          [b.tenantId, unique('in_'), a.customer],
        ),
      ).rejects.toThrow(/customer_of_tenant/);
    });

    it('reembolso/disputa: idempotente, ordenado e por comunidade', async () => {
      const a = await novaComunidade();
      const b = await novaComunidade();
      const inv = unique('in_');
      await fatura(a.tenantId, inv, { customer: a.customer, status: 'paid', paid: 1000 });
      const obj = unique('re_');
      const aj = (tenantId: string, customer: string, status: string, obs: string) =>
        comoComunidade(tenantId, (db) =>
          db.query<{ r: string }>(
            `SELECT app.apply_stripe_adjustment($1,$2,$3,'REFUND',$4,500,'BRL',$5,NULL,$6) AS r`,
            [tenantId, customer, inv, obj, status, obs],
          ),
        );
      const t0 = Date.now();
      expect((await aj(a.tenantId, a.customer, 'succeeded', new Date(t0 + 2000).toISOString())).rows[0]!.r).toBe('applied');
      expect((await aj(a.tenantId, a.customer, 'pending', new Date(t0 + 1000).toISOString())).rows[0]!.r).toBe('stale');
      expect((await aj(b.tenantId, b.customer, 'succeeded', new Date(t0 + 3000).toISOString())).rows[0]!.r).toBe('customer_mismatch');
      const { rows } = await owner.query<{ status: string; tenant_id: string }>('SELECT status, tenant_id FROM billing_adjustments WHERE stripe_object_id = $1', [obj]);
      expect(rows).toEqual([{ status: 'succeeded', tenant_id: a.tenantId }]);
    });
  });

  // ---------------------------------------------------------------------------
  describe('eventos do webhook · lease, retry, conclusao autorizada e retencao', () => {
    const novoId = () => unique('evt_').replace(/[^a-z0-9_]/gi, '');

    const registrar = (id: string, payload: unknown = { subscriptionId: 'sub_x' }) =>
      comoWorker((db) =>
        db.query<{ r: string }>(
          `SELECT app.record_stripe_event($1,'invoice.paid',now(),false,'invoice','in_x','cus_x',$2::jsonb) AS r`,
          [id, JSON.stringify(payload)],
        ),
      );
    const pegar = (id: string, lease = 60) =>
      comoWorker((db) =>
        db.query<{ lease_token: string; attempts: number; payload: Record<string, unknown> }>(
          'SELECT * FROM app.claim_stripe_event($1, $2)',
          [id, lease],
        ),
      );
    const concluir = (id: string, token: string | null, status: string, tenant: string | null = null, erro: string | null = null) =>
      comoWorker((db) =>
        db.query<{ ok: boolean }>('SELECT app.finish_stripe_event($1,$2,$3::stripe_event_status,$4,$5) AS ok', [id, token, status, tenant, erro]),
      );
    const linha = async (id: string) =>
      (await owner.query<{ status: string; attempts: number; tenant_id: string | null; payload: unknown; next_attempt_at: Date }>(
        'SELECT status, attempts, tenant_id, payload, next_attempt_at FROM stripe_webhook_events WHERE event_id = $1',
        [id],
      )).rows[0]!;

    it('o mesmo evento chegando de novo (inclusive em paralelo) e registrado UMA vez', async () => {
      const id = novoId();
      const rs = await Promise.all(Array.from({ length: 6 }, () => registrar(id)));
      expect(rs.filter((r) => r.rows[0]!.r === 'NEW')).toHaveLength(1);
      const { rows } = await owner.query<{ n: string }>('SELECT count(*) AS n FROM stripe_webhook_events WHERE event_id = $1', [id]);
      expect(Number(rows[0]!.n)).toBe(1);
    });

    it('so aceita ID de evento no formato da Stripe e payload minimo (ate 4 KB)', async () => {
      await expect(registrar('qualquer-coisa')).rejects.toThrow(/id_format/);
      // Um evento cru da Stripe (com e-mail, endereco...) nao cabe: o teto e do banco.
      await expect(registrar(novoId(), { blob: 'x'.repeat(6000) })).rejects.toThrow(/payload_minimal/);
    });

    it('so UM processo pega o evento; o payload minimo vem junto', async () => {
      const id = novoId();
      await registrar(id, { subscriptionId: 'sub_abc' });
      const rs = await Promise.all(Array.from({ length: 6 }, () => pegar(id)));
      const vencedores = rs.filter((r) => r.rowCount === 1);
      expect(vencedores).toHaveLength(1);
      expect(vencedores[0]!.rows[0]!.payload).toEqual({ subscriptionId: 'sub_abc' });
      expect((await linha(id)).status).toBe('PROCESSING');
    });

    it('conclui SOMENTE com o token do lease vigente', async () => {
      const id = novoId();
      await registrar(id);
      const token = (await pegar(id)).rows[0]!.lease_token;

      expect((await concluir(id, null, 'PROCESSED')).rows[0]!.ok).toBe(false); // sem token
      expect((await concluir(id, '00000000-0000-4000-8000-000000000000', 'PROCESSED')).rows[0]!.ok).toBe(false); // adivinhado
      expect((await linha(id)).status).toBe('PROCESSING');

      expect((await concluir(id, token, 'PROCESSED')).rows[0]!.ok).toBe(true);
      expect((await linha(id)).status).toBe('PROCESSED');
      // Concluido: nem o dono do token conclui de novo, nem alguem o reabre.
      expect((await concluir(id, token, 'FAILED')).rows[0]!.ok).toBe(false);
      expect((await pegar(id)).rowCount).toBe(0);
      expect((await linha(id)).status).toBe('PROCESSED');
    });

    it('quem perdeu o lease NAO sobrescreve o resultado de quem o assumiu', async () => {
      const id = novoId();
      await registrar(id);
      const antigo = (await pegar(id)).rows[0]!.lease_token;
      // O processo travou: o lease vence e outro assume.
      await owner.query(`UPDATE stripe_webhook_events SET lease_expires_at = now() - interval '1 second' WHERE event_id = $1`, [id]);
      const novo = (await pegar(id)).rows[0]!.lease_token;
      expect(novo).not.toBe(antigo);

      expect((await concluir(id, antigo, 'FAILED', null, 'atrasado')).rows[0]!.ok).toBe(false);
      expect((await concluir(id, novo, 'PROCESSED')).rows[0]!.ok).toBe(true);
      expect((await linha(id)).status).toBe('PROCESSED');
    });

    it('lease ainda vigente: ninguem mais pega (recuperacao so depois de vencer)', async () => {
      const id = novoId();
      await registrar(id);
      await pegar(id);
      expect((await pegar(id)).rowCount).toBe(0);
      expect((await comoWorker((db) => db.query('SELECT * FROM app.list_stripe_events_due(50)'))).rows.map((r: { event_id: string }) => r.event_id)).not.toContain(id);
      await owner.query(`UPDATE stripe_webhook_events SET lease_expires_at = now() - interval '1 second' WHERE event_id = $1`, [id]);
      expect((await comoWorker((db) => db.query('SELECT * FROM app.list_stripe_events_due(50)'))).rows.map((r: { event_id: string }) => r.event_id)).toContain(id);
    });

    it('falha volta a fila COM RECUO; so e pega de novo quando o recuo vence', async () => {
      const id = novoId();
      await registrar(id);
      const token = (await pegar(id)).rows[0]!.lease_token;
      expect((await concluir(id, token, 'FAILED', null, 'Stripe fora do ar')).rows[0]!.ok).toBe(true);
      const depois = await linha(id);
      expect(depois.status).toBe('FAILED');
      expect(new Date(depois.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 10_000);
      expect((await pegar(id)).rowCount).toBe(0); // ainda no recuo
      await owner.query(`UPDATE stripe_webhook_events SET next_attempt_at = now() WHERE event_id = $1`, [id]);
      const de_novo = await pegar(id);
      expect(de_novo.rowCount).toBe(1);
      expect(de_novo.rows[0]!.attempts).toBe(2);
    });

    it('esgotadas as tentativas o evento vira DEAD e sai da fila', async () => {
      const id = novoId();
      await registrar(id);
      for (let i = 1; i <= 10; i++) {
        await owner.query(`UPDATE stripe_webhook_events SET next_attempt_at = now() WHERE event_id = $1`, [id]);
        const token = (await pegar(id)).rows[0]!.lease_token;
        expect((await concluir(id, token, 'FAILED', null, `tentativa ${i}`)).rows[0]!.ok).toBe(true);
      }
      expect((await linha(id)).status).toBe('DEAD');
      expect((await pegar(id)).rowCount).toBe(0);
    });

    it('a comunidade do evento nao muda: outra comunidade nao o conclui', async () => {
      const a = await novaComunidade(false);
      const b = await novaComunidade(false);
      const id = novoId();
      await registrar(id);
      let token = (await pegar(id)).rows[0]!.lease_token;
      // Concluido como FAILED pela comunidade A: o evento passa a ser da A.
      await comoComunidade(a.tenantId, (db) =>
        db.query('SELECT app.finish_stripe_event($1,$2,$3::stripe_event_status,$4,$5)', [id, token, 'FAILED', a.tenantId, 'x']),
      );
      expect((await linha(id)).tenant_id).toBe(a.tenantId);

      await owner.query(`UPDATE stripe_webhook_events SET next_attempt_at = now() WHERE event_id = $1`, [id]);
      token = (await pegar(id)).rows[0]!.lease_token;
      // B nao age em nome da A ...
      await expect(
        comoComunidade(b.tenantId, (db) =>
          db.query('SELECT app.finish_stripe_event($1,$2,$3::stripe_event_status,$4,$5)', [id, token, 'PROCESSED', a.tenantId, null]),
        ),
      ).rejects.toThrow(/sem acesso a comunidade/);
      // ... e, mesmo com o token, nao move o evento da A para si.
      await expect(
        comoComunidade(b.tenantId, (db) =>
          db.query('SELECT app.finish_stripe_event($1,$2,$3::stripe_event_status,$4,$5)', [id, token, 'PROCESSED', b.tenantId, null]),
        ),
      ).rejects.toThrow(/outra comunidade/);
      expect((await linha(id)).status).toBe('PROCESSING');
    });

    it('estado final invalido e lease fora da faixa sao recusados', async () => {
      const id = novoId();
      await registrar(id);
      const token = (await pegar(id)).rows[0]!.lease_token;
      await expect(concluir(id, token, 'RECEIVED')).rejects.toThrow(/estado final invalido/);
      await expect(pegar(id, 5)).rejects.toThrow(/lease fora do intervalo/);
    });

    it('a comunidade nao le a fila de eventos; a plataforma e o worker leem', async () => {
      const id = novoId();
      await registrar(id);
      const c = await novaComunidade(false);
      const vistoPelaComunidade = await comoComunidade(c.tenantId, (db) => db.query('SELECT event_id FROM stripe_webhook_events'));
      expect(vistoPelaComunidade.rowCount).toBe(0);
      // O runtime da API tampouco lista o que esta na hora: so o worker.
      const listaApi = await comoComunidade(c.tenantId, (db) => db.query('SELECT * FROM app.list_stripe_events_due(50)'));
      expect(listaApi.rowCount).toBe(0);
      const admin = await seedUser(owner, `${unique('adm-')}@x.test`, 'Admin');
      await owner.query("INSERT INTO platform_admins (user_id, role) VALUES ($1, 'PLATFORM_FINANCE')", [admin.userId]);
      const daPlataforma = await withPlatform(app, { userId: admin.userId }, (db) => db.query('SELECT event_id FROM stripe_webhook_events WHERE event_id = $1', [id]));
      expect(daPlataforma.rowCount).toBe(1);
    });

    it('RETENCAO: zera o payload de evento terminal, guarda os ids e remove a linha so depois; o pendente nunca sai', async () => {
      const finalizado = novoId();
      const antigo = novoId();
      const pendente = novoId();
      const emAndamento = novoId();
      for (const id of [finalizado, antigo, pendente, emAndamento]) await registrar(id);
      const tk = (await pegar(finalizado)).rows[0]!.lease_token;
      await concluir(finalizado, tk, 'PROCESSED');
      const tk2 = (await pegar(antigo)).rows[0]!.lease_token;
      await concluir(antigo, tk2, 'PROCESSED');
      await pegar(emAndamento);

      // 40 dias: passou da retencao do payload, nao da da linha. 100 dias: passou das duas.
      await owner.query(`UPDATE stripe_webhook_events SET received_at = now() - interval '40 days' WHERE event_id IN ($1,$2)`, [finalizado, pendente]);
      await owner.query(`UPDATE stripe_webhook_events SET received_at = now() - interval '100 days' WHERE event_id IN ($1,$2)`, [antigo, emAndamento]);

      const r = await comoWorker((db) => db.query<{ payloads_cleared: number; rows_deleted: number }>('SELECT * FROM app.purge_stripe_events(30, 90)'));
      expect(r.rows[0]!.rows_deleted).toBeGreaterThanOrEqual(1);

      const f = await linha(finalizado);
      expect(f.status).toBe('PROCESSED'); // a linha (idempotencia) fica
      expect(f.payload).toBeNull(); // o payload sai
      expect(await linha(antigo)).toBeUndefined(); // passou de 90 dias: removida
      expect((await linha(pendente)).payload).not.toBeNull(); // nao concluido: intacto
      expect((await linha(emAndamento)).status).toBe('PROCESSING'); // nem em andamento

      // A API (app_user) nao dispara a retencao.
      const daApi = await comoComunidade((await novaComunidade(false)).tenantId, (db) => db.query('SELECT * FROM app.purge_stripe_events(30, 90)'));
      expect(daApi.rows[0]).toMatchObject({ payloads_cleared: 0, rows_deleted: 0 });
    });

    it('a retencao nunca deixa a linha sair antes do payload', async () => {
      await expect(comoWorker((db) => db.query('SELECT * FROM app.purge_stripe_events(30, 10)'))).rejects.toThrow(/nao pode sair antes/);
    });
  });

  // ---------------------------------------------------------------------------
  describe('Checkout aberto · um por comunidade', () => {
    const registrarSessao = (tenantId: string, planId: string, sessao: string, ctx = tenantId, expira = dias(1)) =>
      comoComunidade(ctx, (db) =>
        db.query('SELECT app.record_checkout_session($1,$2,NULL,$3,$4,$5)', [tenantId, planId, sessao, `https://checkout.stripe.test/${sessao}`, expira]),
      );
    const sess = () => unique('cs_test_').replace(/[^a-z0-9_]/gi, '');

    it('so admite UM Checkout aberto por comunidade (indice parcial)', async () => {
      const plano = await novoPlano();
      const c = await novaComunidade(false);
      await registrarSessao(c.tenantId, plano.id, sess());
      await expect(registrarSessao(c.tenantId, plano.id, sess())).rejects.toThrow(/billing_checkout_one_open/);
    });

    it('um Checkout VENCIDO e fechado ao registrar o proximo; concluido libera a vaga', async () => {
      const plano = await novoPlano();
      const c = await novaComunidade(false);
      const velha = sess();
      await registrarSessao(c.tenantId, plano.id, velha, c.tenantId, new Date(Date.now() + 1000).toISOString());
      await owner.query(`UPDATE billing_checkout_sessions SET expires_at = now() - interval '1 minute' WHERE stripe_session_id = $1`, [velha]);
      const nova = sess();
      await registrarSessao(c.tenantId, plano.id, nova);
      const { rows } = await owner.query<{ status: string }>('SELECT status FROM billing_checkout_sessions WHERE stripe_session_id = $1', [velha]);
      expect(rows[0]!.status).toBe('EXPIRED');

      const r = await comoComunidade(c.tenantId, (db) => db.query<{ r: string }>(`SELECT app.set_checkout_session_status($1,$2,'COMPLETED') AS r`, [c.tenantId, nova]));
      expect(r.rows[0]!.r).toBe('updated');
      await registrarSessao(c.tenantId, plano.id, sess()); // vaga liberada
    });

    it('a comunidade B nao mexe na sessao da A; a resolucao vem do que NOS gravamos', async () => {
      const plano = await novoPlano();
      const a = await novaComunidade(false);
      const b = await novaComunidade(false);
      const s = sess();
      await registrarSessao(a.tenantId, plano.id, s);
      const r = await comoComunidade(b.tenantId, (db) => db.query<{ r: string }>(`SELECT app.set_checkout_session_status($1,$2,'COMPLETED') AS r`, [b.tenantId, s]));
      expect(r.rows[0]!.r).toBe('unknown_session');
      const f = await comoComunidade(b.tenantId, (db) => db.query<{ r: string }>(`SELECT app.set_checkout_session_status($1,$2,'COMPLETED') AS r`, [a.tenantId, s]));
      expect(f.rows[0]!.r).toBe('forbidden');
      await expect(registrarSessao(a.tenantId, plano.id, sess(), b.tenantId)).rejects.toThrow(/sem acesso a comunidade/);

      const t = await comoComunidade(b.tenantId, (db) => db.query<{ t: string | null }>('SELECT app.resolve_tenant_by_checkout_session($1) AS t', [s]));
      expect(t.rows[0]!.t).toBe(a.tenantId);
      const nada = await comoComunidade(b.tenantId, (db) => db.query<{ t: string | null }>('SELECT app.resolve_tenant_by_checkout_session($1) AS t', ['cs_test_nao_e_nossa']));
      expect(nada.rows[0]!.t).toBeNull();
    });
  });

  describe('visao de limites e consumo', () => {
    it('devolve plano, consumo, fim da tolerancia e o veredito sem tomar lock', async () => {
      const plano = await novoPlano({ maxDraws: 3, maxTeam: 5 });
      const c = await novaComunidade();
      const subId = unique('sub_');
      await aplicarSub(c.tenantId, c.tenantId, { subId, customer: c.customer, priceId: plano.priceId, status: 'past_due', pastDueAt: dias(-1) });
      await novoSorteio(c.tenantId, 'ATIVA');
      await novoSorteio(c.tenantId);
      const r = await comoComunidade(c.tenantId, (db) =>
        db.query<{ state: string; plan_code: string; draws_used: number; team_used: number; grace_ends_at: Date; enforcement_enabled: boolean }>(
          'SELECT * FROM app.tenant_entitlements($1)',
          [c.tenantId],
        ),
      );
      const e = r.rows[0]!;
      expect(e).toMatchObject({ state: 'PAST_DUE_GRACE', draws_used: 1, team_used: 0, enforcement_enabled: false });
      // 1 dia atras + 3 dias de tolerancia = daqui a ~2 dias.
      const faltam = (new Date(e.grace_ends_at).getTime() - Date.now()) / 86_400_000;
      expect(faltam).toBeGreaterThan(1.9);
      expect(faltam).toBeLessThan(2.1);
      const v = await comoComunidade(c.tenantId, (db) => db.query('SELECT * FROM app.draw_submission_verdict($1)', [c.tenantId]));
      expect(v.rows[0]).toMatchObject({ allowed: true, reason: 'ENFORCEMENT_OFF' });
    });

    it('SEM assinatura e cobranca ligada: rascunho continua livre, o envio para revisao e bloqueado', async () => {
      await ligarCobranca(true);
      try {
        const c = await novaComunidade(false);
        await novoSorteio(c.tenantId); // criar rascunho nao passa pelo veredito
        const v = await comoComunidade(c.tenantId, (db) => db.query('SELECT * FROM app.draw_submission_verdict($1)', [c.tenantId]));
        expect(v.rows[0]).toMatchObject({ allowed: false, reason: 'SUBSCRIPTION_NO_SUBSCRIPTION' });
        // Sorteios que ja existem e a apuracao nao dependem da assinatura: o veredito so
        // fala de ENVIAR novo sorteio; nada aqui toca `draws` existentes.
        const { rows } = await owner.query<{ n: string }>(`SELECT count(*) AS n FROM draws WHERE tenant_id = $1`, [c.tenantId]);
        expect(Number(rows[0]!.n)).toBe(1);
      } finally {
        await ligarCobranca(false);
      }
    });
  });

});
