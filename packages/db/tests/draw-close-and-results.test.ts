import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OUTBOX_PAYLOAD_SCHEMAS, drawTransitionEvents, type OutboxEventType } from '@clubedarifa/shared';
import { withTenant } from '../src/context.js';
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
 * 0014 · fechamento, snapshot (RN20) e resultado versionado (RN09).
 *
 * Tres coisas em prova: (1) o sistema so faz as transicoes que lhe cabem, e cada
 * uma deixa auditoria e outbox; (2) o snapshot congela, mascara e nao muda; (3)
 * o resultado nunca e reescrito nem apagado.
 */
describe.skipIf(!hasTestDatabase)(`0014 · fechamento e resultado ${
  hasTestDatabase ? '' : describeSkipReason()
}`, () => {
  let owner: DbPool;
  let app: DbPool;
  let worker: DbPool;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    await ensureMigrated();
    owner = ownerPool();
    app = appPool();
    worker = workerPool();
    await resetFoundationTables();
    tenantId = (await seedTenant(owner, unique('fech-'), 'Fechamento')).tenantId;
    userId = (await seedUser(owner, `${unique('u-')}@example.com`, 'Organizador')).userId;
  }, 120_000);

  afterAll(async () => {
    await owner?.end();
    await app?.end();
    await worker?.end();
  });

  async function sorteio(
    status = 'ATIVA',
    extra: { total?: number; salesStartAt?: string; policy?: string } = {},
  ): Promise<string> {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO draws (tenant_id, slug, title, description, prize_name, ticket_price_cents,
                          total_numbers, status, sales_start_at, no_winner_policy)
       VALUES ($1, $2, 'Sorteio X', 'Regulamento completo.', 'Moto', 1000, $3, $4::draw_status,
               $5::timestamptz, COALESCE($6, 'PROXIMO_VENDIDO_ACIMA')) RETURNING id`,
      [tenantId, unique('s-'), extra.total ?? 100, status, extra.salesStartAt ?? null, extra.policy ?? null],
    );
    return rows[0]!.id;
  }

  /** Uma venda PAGA: comprador, pedido, itens e numeros. */
  async function venda(drawId: string, numeros: number[], nome = 'Maria Souza', fone = '+55 11 91234-5678') {
    const { rows: b } = await owner.query<{ id: string }>(
      'INSERT INTO buyers (tenant_id, name, phone) VALUES ($1, $2, $3) RETURNING id',
      [tenantId, nome, fone],
    );
    const { rows: o } = await owner.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, draw_id, buyer_id, status, unit_price_cents, quantity,
                           total_cents, accepted_terms_at, paid_at)
       VALUES ($1, $2, $3, 'PAGO', 1000, $4, $5, now(), now()) RETURNING id`,
      [tenantId, drawId, b[0]!.id, numeros.length, numeros.length * 1000],
    );
    const orderId = o[0]!.id;
    await owner.query(
      `INSERT INTO order_items (tenant_id, order_id, number, unit_price_cents)
       SELECT $1, $2, n, 1000 FROM unnest($3::int[]) AS n`,
      [tenantId, orderId, numeros],
    );
    await owner.query(
      `INSERT INTO draw_numbers (tenant_id, draw_id, number, status, order_id)
       SELECT $1, $2, n, 'PAGO', $3 FROM unnest($4::int[]) AS n`,
      [tenantId, drawId, orderId, numeros],
    );
    return orderId;
  }

  const transicao = (drawId: string, para: string, motivo: string | null = null) =>
    worker.query('SELECT app.worker_transition_draw($1, $2::draw_status, $3) AS s', [drawId, para, motivo]);
  const retrato = (drawId: string) =>
    worker.query<{ id: string | null }>('SELECT app.worker_create_draw_snapshot($1) AS id', [drawId]);

  async function eventos(drawId: string): Promise<{ event_type: string; payload: unknown }[]> {
    const { rows } = await owner.query<{ event_type: string; payload: unknown }>(
      "SELECT event_type, payload FROM outbox WHERE payload->>'drawId' = $1 ORDER BY created_at, id",
      [drawId],
    );
    return rows;
  }

  // -------------------------------------------------------------------------
  describe('funcoes de sistema · quem pode executar', () => {
    it('o papel da aplicacao NAO executa as funcoes do worker', async () => {
      const id = await sorteio();
      await expect(app.query('SELECT app.worker_transition_draw($1, $2::draw_status, NULL)', [id, 'VENDAS ENCERRADAS'])).rejects.toThrow(
        /permission denied/i,
      );
      await expect(app.query('SELECT app.worker_create_draw_snapshot($1)', [id])).rejects.toThrow(/permission denied/i);
    });

    it('o worker NAO ganha UPDATE em draws: so a funcao muda o estado', async () => {
      const id = await sorteio();
      await expect(worker.query("UPDATE draws SET status = 'VENDAS ENCERRADAS' WHERE id = $1", [id])).rejects.toThrow(
        /permission denied/i,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('transicoes do sistema', () => {
    it('fechar as vendas: ATIVA e PAUSADA -> VENDAS ENCERRADAS, com auditoria e draw.sales_closed', async () => {
      for (const partida of ['ATIVA', 'PAUSADA']) {
        const id = await sorteio(partida);
        await transicao(id, 'VENDAS ENCERRADAS', 'close_at vencido');

        const { rows } = await owner.query('SELECT status::text AS status FROM draws WHERE id = $1', [id]);
        expect(rows[0]!.status).toBe('VENDAS ENCERRADAS');
        expect((await eventos(id)).map((e) => e.event_type)).toEqual(['draw.sales_closed']);

        const { rows: audit } = await owner.query(
          `SELECT actor_type, actor_user_id, before, after FROM audit_events
            WHERE target_id = $1 AND action = 'draw.status_changed'`,
          [id],
        );
        expect(audit[0]).toMatchObject({ actor_type: 'SYSTEM', actor_user_id: null });
        expect(audit[0]!.before).toEqual({ status: partida });
        expect(audit[0]!.after).toMatchObject({ status: 'VENDAS ENCERRADAS', reason: 'close_at vencido' });
      }
    });

    it('o payload do evento obedece ao schema compartilhado', async () => {
      const id = await sorteio();
      await transicao(id, 'VENDAS ENCERRADAS');
      const [evento] = await eventos(id);
      expect(() => OUTBOX_PAYLOAD_SCHEMAS[evento!.event_type as OutboxEventType].parse(evento!.payload)).not.toThrow();
    });

    it('paridade: os eventos da funcao SQL sao os de drawTransitionEvents', async () => {
      const casos: [string, string][] = [
        ['ATIVA', 'VENDAS ENCERRADAS'],
        ['PAUSADA', 'VENDAS ENCERRADAS'],
      ];
      for (const [de, para] of casos) {
        const id = await sorteio(de);
        await transicao(id, para);
        expect((await eventos(id)).map((e) => e.event_type)).toEqual(
          drawTransitionEvents(de as never, para as never),
        );
      }

      // VENDAS ENCERRADAS -> APURAÇÃO (exige snapshot)
      const id = await sorteio('VENDAS ENCERRADAS');
      await venda(id, [1]);
      await retrato(id);
      await transicao(id, 'APURAÇÃO');
      expect((await eventos(id)).map((e) => e.event_type)).toEqual(
        drawTransitionEvents('VENDAS ENCERRADAS', 'APURAÇÃO'),
      );

      // AGENDADA -> ATIVA
      const ag = await sorteio('AGENDADA', { salesStartAt: new Date(Date.now() - 60_000).toISOString() });
      await transicao(ag, 'ATIVA');
      expect((await eventos(ag)).map((e) => e.event_type)).toEqual(drawTransitionEvents('AGENDADA', 'ATIVA'));
    });

    it('AGENDADA so abre quando a hora chegou', async () => {
      const cedo = await sorteio('AGENDADA', { salesStartAt: new Date(Date.now() + 3_600_000).toISOString() });
      await expect(transicao(cedo, 'ATIVA')).rejects.toThrow(/ainda nao chegou a hora/);
      const semData = await sorteio('AGENDADA');
      await expect(transicao(semData, 'ATIVA')).rejects.toThrow(/ainda nao chegou a hora/);
    });

    it('APURAÇÃO exige o snapshot (RN20)', async () => {
      const id = await sorteio('VENDAS ENCERRADAS');
      await expect(transicao(id, 'APURAÇÃO')).rejects.toThrow(/snapshot/);
    });

    it('o sistema NAO faz o que nao lhe cabe', async () => {
      const proibidas: [string, string][] = [
        ['RASCUNHO', 'ATIVA'],
        ['REVISÃO COMPLIANCE', 'ATIVA'],
        ['ATIVA', 'PAUSADA'],
        ['ATIVA', 'CANCELADA'],
        ['VENDAS ENCERRADAS', 'ATIVA'],
        ['VENDAS ENCERRADAS', 'RESULTADO PUBLICADO'],
        ['APURAÇÃO', 'RESULTADO PUBLICADO'],
        ['RESULTADO PUBLICADO', 'ARQUIVADA'],
      ];
      for (const [de, para] of proibidas) {
        const id = await sorteio(de);
        await expect(transicao(id, para), `${de} → ${para}`).rejects.toThrow(/nao pode levar/);
        const { rows } = await owner.query('SELECT status::text AS status FROM draws WHERE id = $1', [id]);
        expect(rows[0]!.status).toBe(de);
      }
    });

    it('repetir a transicao nao a repete: o estado e conferido na transacao', async () => {
      const id = await sorteio();
      await transicao(id, 'VENDAS ENCERRADAS');
      await expect(transicao(id, 'VENDAS ENCERRADAS')).rejects.toThrow(/nao pode levar/);
      expect((await eventos(id)).filter((e) => e.event_type === 'draw.sales_closed')).toHaveLength(1);
    });

    it('sorteio inexistente e erro claro', async () => {
      await expect(transicao('00000000-0000-4000-8000-000000000000', 'VENDAS ENCERRADAS')).rejects.toThrow(
        /inexistente/,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('snapshot · RN20', () => {
    it('so existe com as vendas encerradas', async () => {
      const id = await sorteio('ATIVA');
      expect((await retrato(id)).rows[0]!.id).toBeNull();
    });

    it('pendencia bloqueia: numero PENDENTE ou reserva viva impedem o retrato', async () => {
      const id = await sorteio('VENDAS ENCERRADAS');
      await owner.query(
        "INSERT INTO draw_numbers (tenant_id, draw_id, number, status) VALUES ($1, $2, 5, 'PENDENTE')",
        [tenantId, id],
      );
      expect((await retrato(id)).rows[0]!.id).toBeNull();

      await owner.query('DELETE FROM draw_numbers WHERE draw_id = $1', [id]);
      await owner.query(
        `INSERT INTO draw_numbers (tenant_id, draw_id, number, status, expires_at)
         VALUES ($1, $2, 6, 'RESERVADO', now() + interval '10 minutes')`,
        [tenantId, id],
      );
      expect((await retrato(id)).rows[0]!.id).toBeNull();
    });

    it('reserva VENCIDA nao e pendencia', async () => {
      const id = await sorteio('VENDAS ENCERRADAS');
      await owner.query(
        `INSERT INTO draw_numbers (tenant_id, draw_id, number, status, expires_at)
         VALUES ($1, $2, 6, 'RESERVADO', now() - interval '1 minute')`,
        [tenantId, id],
      );
      expect((await retrato(id)).rows[0]!.id).not.toBeNull();
    });

    it('congela numeros pagos, precos e regulamento, com compradores MASCARADOS', async () => {
      const id = await sorteio('VENDAS ENCERRADAS');
      const pedidoA = await venda(id, [7, 3], 'Maria Souza', '+55 11 91234-5678');
      await venda(id, [50], 'joao', '(21) 99876-0001');

      const sid = (await retrato(id)).rows[0]!.id;
      expect(sid).not.toBeNull();

      const { rows } = await owner.query<{ payload: Record<string, unknown>; sha256: string; paid_count: number }>(
        'SELECT payload, sha256, paid_count FROM draw_snapshots WHERE id = $1',
        [sid],
      );
      const { payload } = rows[0]!;
      expect(rows[0]!.paid_count).toBe(3);
      expect(payload).toMatchObject({
        title: 'Sorteio X',
        regulation: 'Regulamento completo.',
        totalNumbers: 100,
        labelDigits: 2,
        ticketPriceCents: 1000,
        resultSource: 'LOTERIA_FEDERAL',
        noWinnerPolicy: 'PROXIMO_VENDIDO_ACIMA',
        paidCount: 3,
      });
      const pagos = payload['paidNumbers'] as { number: number; buyer: string; phoneLast4: string; orderId: string }[];
      expect(pagos.map((p) => p.number)).toEqual([3, 7, 50]);
      expect(pagos[0]).toMatchObject({ buyer: 'M*** S***', phoneLast4: '5678', orderId: pedidoA });
      expect(pagos[2]).toMatchObject({ buyer: 'j***', phoneLast4: '0001' });
      // Nome inteiro e telefone completo NUNCA entram no retrato.
      expect(JSON.stringify(payload)).not.toContain('Maria');
      expect(JSON.stringify(payload)).not.toContain('91234');
    });

    it('o hash e o SHA-256 do conteudo e pode ser refeito', async () => {
      const id = await sorteio('VENDAS ENCERRADAS');
      await venda(id, [1, 2]);
      const sid = (await retrato(id)).rows[0]!.id;
      const { rows } = await owner.query<{ ok: boolean }>(
        `SELECT sha256 = encode(sha256(convert_to(payload::text, 'UTF8')), 'hex') AS ok
           FROM draw_snapshots WHERE id = $1`,
        [sid],
      );
      expect(rows[0]!.ok).toBe(true);
    });

    it('idempotente: chamar de novo devolve o mesmo retrato, sem duplicar', async () => {
      const id = await sorteio('VENDAS ENCERRADAS');
      await venda(id, [9]);
      const a = (await retrato(id)).rows[0]!.id;
      const b = (await retrato(id)).rows[0]!.id;
      expect(a).toBe(b);
      const { rows } = await owner.query('SELECT count(*)::int AS n FROM draw_snapshots WHERE draw_id = $1', [id]);
      expect(rows[0]!.n).toBe(1);
      const { rows: audit } = await owner.query(
        "SELECT count(*)::int AS n FROM audit_events WHERE target_id = $1 AND action = 'draw.snapshot_created'",
        [id],
      );
      expect(audit[0]!.n).toBe(1);
    });

    it('so-insercao: nem o dono altera ou apaga', async () => {
      const id = await sorteio('VENDAS ENCERRADAS');
      await venda(id, [4]);
      await retrato(id);
      await expect(owner.query("UPDATE draw_snapshots SET paid_count = 99 WHERE draw_id = $1", [id])).rejects.toThrow(
        /somente-insercao/,
      );
      await expect(owner.query('DELETE FROM draw_snapshots WHERE draw_id = $1', [id])).rejects.toThrow(/somente-insercao/);
    });

    it('a aplicacao nao insere retrato por conta propria', async () => {
      const id = await sorteio('VENDAS ENCERRADAS');
      await expect(
        withTenant(app, { tenantId }, (c) =>
          c.query(
            `INSERT INTO draw_snapshots (tenant_id, draw_id, payload, sha256, paid_count)
             VALUES ($1, $2, '{}'::jsonb, repeat('a', 64), 0)`,
            [tenantId, id],
          ),
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it('RLS: a comunidade B nao le o retrato da A', async () => {
      const id = await sorteio('VENDAS ENCERRADAS');
      await venda(id, [8]);
      await retrato(id);
      const b = (await seedTenant(owner, unique('outra-'), 'Outra')).tenantId;
      const visiveis = await withTenant(app, { tenantId: b }, (c) => c.query('SELECT id FROM draw_snapshots'));
      expect(visiveis.rowCount).toBe(0);
      const proprios = await withTenant(app, { tenantId }, (c) =>
        c.query('SELECT id FROM draw_snapshots WHERE draw_id = $1', [id]),
      );
      expect(proprios.rowCount).toBe(1);
    });

    it('mascara de nome', async () => {
      const { rows } = await owner.query<{ m: string }>(
        `SELECT app.mask_name('  Maria   da Silva ') AS m
         UNION ALL SELECT app.mask_name('joao') UNION ALL SELECT app.mask_name('') UNION ALL SELECT app.mask_name(NULL)`,
      );
      expect(rows.map((r) => r.m)).toEqual(['M*** d*** S***', 'j***', '', '']);
    });
  });

  // -------------------------------------------------------------------------
  describe('draw_results · versionado, nunca reescrito (RN09)', () => {
    const hash = 'a'.repeat(64);

    async function resultado(drawId: string, over: Record<string, unknown> = {}) {
      const v = {
        version: 1,
        status: 'VIGENTE',
        federal_number: '48372',
        evidence_text: 'Concurso 6001',
        evidence_url: null,
        winning_number: null,
        winner_order_id: null,
        correction_reason: null,
        ...over,
      };
      return owner.query(
        `INSERT INTO draw_results
           (tenant_id, draw_id, version, status, source, federal_number, evidence_text, evidence_url,
            label_digits, candidate_number, winning_number, winner_order_id, attempts,
            snapshot_sha256, proof_sha256, correction_reason, published_by)
         VALUES ($1, $2, $3, $4, 'LOTERIA_FEDERAL', $5, $6, $7, 2, 72, $8, $9, '[]'::jsonb, $10, $10, $11, $12)
         RETURNING id`,
        [tenantId, drawId, v.version, v.status, v.federal_number, v.evidence_text, v.evidence_url,
         v.winning_number, v.winner_order_id, hash, v.correction_reason, userId],
      );
    }

    it('aceita um resultado com evidencia', async () => {
      const id = await sorteio('RESULTADO PUBLICADO');
      await expect(resultado(id)).resolves.toBeDefined();
    });

    it('sem evidencia (nem texto nem link), nao existe', async () => {
      const id = await sorteio('RESULTADO PUBLICADO');
      await expect(resultado(id, { evidence_text: null })).rejects.toThrow(/draw_results_evidence_present/);
    });

    it('link de evidencia so https; numero da Federal so digitos', async () => {
      const id = await sorteio('RESULTADO PUBLICADO');
      await expect(resultado(id, { evidence_url: 'http://x.exemplo/a' })).rejects.toThrow(/draw_results_evidence_https/);
      await expect(resultado(id, { federal_number: '12a45' })).rejects.toThrow(/draw_results_federal_digits/);
    });

    it('contemplado e pedido andam juntos', async () => {
      const id = await sorteio('RESULTADO PUBLICADO');
      await expect(resultado(id, { winning_number: 72 })).rejects.toThrow(/draw_results_winner_consistent/);
    });

    it('uma unica versao VIGENTE por sorteio', async () => {
      const id = await sorteio('RESULTADO PUBLICADO');
      await resultado(id);
      await expect(resultado(id, { version: 2, correction_reason: 'x y z' })).rejects.toThrow(/draw_results_one_current/);
    });

    it('a versao 2 exige motivo de correcao', async () => {
      const id = await sorteio('RESULTADO PUBLICADO');
      await resultado(id);
      await owner.query("UPDATE draw_results SET status = 'RETIFICADA' WHERE draw_id = $1", [id]);
      await expect(resultado(id, { version: 2 })).rejects.toThrow(/draw_results_correction_reason/);
      await expect(resultado(id, { version: 2, correction_reason: 'Numero digitado errado.' })).resolves.toBeDefined();
    });

    it('so VIGENTE -> RETIFICADA e permitido: nada mais muda, nada volta, nada se apaga', async () => {
      const id = await sorteio('RESULTADO PUBLICADO');
      await resultado(id);

      await expect(owner.query("UPDATE draw_results SET federal_number = '99999' WHERE draw_id = $1", [id])).rejects.toThrow(
        /imutavel/,
      );
      await expect(owner.query("UPDATE draw_results SET proof_sha256 = repeat('b', 64) WHERE draw_id = $1", [id])).rejects.toThrow(
        /imutavel/,
      );
      await expect(owner.query('DELETE FROM draw_results WHERE draw_id = $1', [id])).rejects.toThrow(/nao se apaga/);

      await owner.query("UPDATE draw_results SET status = 'RETIFICADA' WHERE draw_id = $1", [id]);
      await expect(owner.query("UPDATE draw_results SET status = 'VIGENTE' WHERE draw_id = $1", [id])).rejects.toThrow(
        /imutavel/,
      );
    });

    it('RLS: a comunidade B nao le nem grava resultado da A', async () => {
      const id = await sorteio('RESULTADO PUBLICADO');
      await resultado(id);
      const b = (await seedTenant(owner, unique('outrar-'), 'Outra')).tenantId;

      const lidos = await withTenant(app, { tenantId: b }, (c) => c.query('SELECT id FROM draw_results'));
      expect(lidos.rowCount).toBe(0);
      const alterados = await withTenant(app, { tenantId: b }, (c) =>
        c.query("UPDATE draw_results SET status = 'RETIFICADA' WHERE draw_id = $1", [id]),
      );
      expect(alterados.rowCount).toBe(0);
    });

    it('a aplicacao so atualiza a coluna status', async () => {
      const id = await sorteio('RESULTADO PUBLICADO');
      await resultado(id);
      await expect(
        withTenant(app, { tenantId }, (c) =>
          c.query("UPDATE draw_results SET federal_number = '11111' WHERE draw_id = $1", [id]),
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it('anon, authenticated e service_role nao tem privilegio nas tabelas novas', async () => {
      const { rows } = await owner.query<{ papel: string; tem: boolean }>(
        `SELECT r.rolname AS papel,
                has_table_privilege(r.rolname, 'public.draw_results', 'SELECT,INSERT,UPDATE,DELETE')
                OR has_table_privilege(r.rolname, 'public.draw_snapshots', 'SELECT,INSERT,UPDATE,DELETE') AS tem
           FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role')`,
      );
      for (const row of rows) expect(row.tem, row.papel).toBe(false);
    });
  });

  describe('politica de "sem contemplado" (S5)', () => {
    it('so aceita as politicas conhecidas', async () => {
      await expect(sorteio('RASCUNHO', { policy: 'INVENTADA' })).rejects.toThrow(/draws_no_winner_policy_known/);
      await expect(sorteio('RASCUNHO', { policy: 'SEM_CONTEMPLADO' })).resolves.toBeDefined();
    });
  });
});
