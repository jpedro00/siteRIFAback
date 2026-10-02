import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createPool, type DbPool } from '@clubedarifa/db';
import {
  cleanup,
  createHarness,
  currentCode,
  grantMembership,
  hasTestDatabase,
  loginAs,
  seedAccount,
  seedConfirmedTotp,
  seedTenantWithSlug,
  skipReason,
  unique,
  verifyMfa,
  type Harness,
} from './helpers/apiHarness.js';
import { computeProofHash } from '../src/modules/results/resultService.js';

/**
 * Fechamento, apuracao e resultado. M06 · RN09 · RN20.
 *
 * O caminho e o de verdade: o organizador fecha as vendas pela API; o WORKER (as
 * funcoes de sistema, com o papel do worker) congela o snapshot e abre a
 * apuracao; o organizador publica; a pagina publica mostra so o que pode.
 */
describe.skipIf(!hasTestDatabase)(`Resultado do sorteio ${hasTestDatabase ? '' : skipReason}`, () => {
  let harness: Harness;
  let worker: DbPool;
  let slug: string;
  let tenantId: string;
  let cookie: string;
  let semMfaCookie: string;

  beforeAll(async () => {
    harness = await createHarness();
    worker = createPool({
      connectionString: process.env['TEST_WORKER_DATABASE_URL'] ?? '',
      applicationName: 'test-worker-results',
      max: 2,
    });
    await cleanup(harness.owner);

    slug = unique('res-');
    tenantId = await seedTenantWithSlug(harness.owner, slug, 'Comunidade do Resultado');

    const organizer = await seedAccount(harness.owner);
    await grantMembership(harness.owner, { tenantId, userId: organizer.userId, role: 'OPERATOR' });
    const secret = await seedConfirmedTotp(harness.owner, organizer.userId);
    const login = await loginAs(harness, organizer);
    cookie = (await verifyMfa(harness, login.cookie, await currentCode(secret))).cookie;

    // Mesmo papel, mas SEM segundo fator satisfeito nesta sessao.
    const outro = await seedAccount(harness.owner);
    await grantMembership(harness.owner, { tenantId, userId: outro.userId, role: 'OPERATOR' });
    await seedConfirmedTotp(harness.owner, outro.userId);
    semMfaCookie = (await loginAs(harness, outro)).cookie;
  }, 180_000);

  afterAll(async () => {
    await worker?.end();
    await harness?.close();
  });

  // ---- cenario ------------------------------------------------------------

  async function sorteio(total = 100, policy?: string): Promise<string> {
    const { rows } = await harness.owner.query<{ id: string }>(
      `INSERT INTO draws (tenant_id, slug, title, description, prize_name, ticket_price_cents,
                          total_numbers, status, draw_date, no_winner_policy)
       VALUES ($1, $2, 'Rifa do Resultado', 'Regulamento.', 'Moto', 1500, $3, 'ATIVA',
               now() + interval '7 days', COALESCE($4, 'PROXIMO_VENDIDO_ACIMA')) RETURNING id`,
      [tenantId, unique('r-'), total, policy ?? null],
    );
    return rows[0]!.id;
  }

  async function venda(drawId: string, numeros: number[], nome = 'Maria Souza', fone = '+55 11 91234-5678') {
    const { rows: b } = await harness.owner.query<{ id: string }>(
      'INSERT INTO buyers (tenant_id, name, phone) VALUES ($1, $2, $3) RETURNING id',
      [tenantId, nome, fone],
    );
    const { rows: o } = await harness.owner.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, draw_id, buyer_id, status, unit_price_cents, quantity,
                           total_cents, accepted_terms_at, paid_at)
       VALUES ($1, $2, $3, 'PAGO', 1500, $4, $5, now(), now()) RETURNING id`,
      [tenantId, drawId, b[0]!.id, numeros.length, numeros.length * 1500],
    );
    const orderId = o[0]!.id;
    await harness.owner.query(
      'INSERT INTO order_items (tenant_id, order_id, number, unit_price_cents) SELECT $1, $2, n, 1500 FROM unnest($3::int[]) AS n',
      [tenantId, orderId, numeros],
    );
    await harness.owner.query(
      "INSERT INTO draw_numbers (tenant_id, draw_id, number, status, order_id) SELECT $1, $2, n, 'PAGO', $3 FROM unnest($4::int[]) AS n",
      [tenantId, drawId, orderId, numeros],
    );
    return orderId;
  }

  /** Fecha as vendas pela API, e o "worker" congela o retrato e abre a apuracao. */
  async function ateApuracao(drawId: string): Promise<void> {
    const fecha = await request(harness.app)
      .post(`/api/tenant/draws/${drawId}/status`)
      .set('Cookie', cookie)
      .set('x-tenant-slug', slug)
      .send({ status: 'VENDAS ENCERRADAS' });
    expect(fecha.status, JSON.stringify(fecha.body)).toBe(200);
    const s = await worker.query<{ id: string | null }>('SELECT app.worker_create_draw_snapshot($1) AS id', [drawId]);
    expect(s.rows[0]!.id).not.toBeNull();
    await worker.query("SELECT app.worker_transition_draw($1, 'APURAÇÃO', NULL)", [drawId]);
  }

  const evidencia = { evidenceText: 'Loteria Federal, concurso 6001 — 1º prêmio.', federalContest: '6001' };

  function publicar(drawId: string, body: Record<string, unknown>, c = cookie) {
    return request(harness.app)
      .post(`/api/tenant/draws/${drawId}/result`)
      .set('Cookie', c)
      .set('x-tenant-slug', slug)
      .send(body);
  }

  function corrigir(drawId: string, body: Record<string, unknown>) {
    return request(harness.app)
      .post(`/api/tenant/draws/${drawId}/result/correction`)
      .set('Cookie', cookie)
      .set('x-tenant-slug', slug)
      .send(body);
  }

  function paginaPublica(drawSlug: string) {
    return request(harness.app).get(`/api/public/draws/${drawSlug}/result`).set('x-tenant-slug', slug);
  }

  async function slugDe(drawId: string): Promise<string> {
    const { rows } = await harness.owner.query<{ slug: string }>('SELECT slug FROM draws WHERE id = $1', [drawId]);
    return rows[0]!.slug;
  }

  async function contar(sql: string, params: unknown[]): Promise<number> {
    const { rows } = await harness.owner.query<{ n: number }>(sql, params);
    return rows[0]!.n;
  }

  // -------------------------------------------------------------------------
  describe('publicar o resultado', () => {
    it('caminho feliz: calcula, mascara, prova, muda o estado e publica o evento', async () => {
      const id = await sorteio();
      const pedido = await venda(id, [7, 42]);
      await venda(id, [50], 'Joao Pereira', '(21) 99876-0001');
      await ateApuracao(id);

      const res = await publicar(id, { federalNumber: '12342', ...evidencia });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.current).toMatchObject({
        version: 1,
        status: 'VIGENTE',
        source: 'LOTERIA_FEDERAL',
        federalNumber: '12342',
        federalContest: '6001',
        candidateNumber: 42,
        winningNumber: 42,
        winningLabel: '42',
        winnerMasked: 'M*** S***',
      });
      expect(res.body.winnerOrderId).toBe(pedido);
      expect(res.body.previous).toEqual([]);

      const { rows } = await harness.owner.query<{ status: string }>('SELECT status::text AS status FROM draws WHERE id = $1', [id]);
      expect(rows[0]!.status).toBe('RESULTADO PUBLICADO');
      expect(
        await contar("SELECT count(*)::int AS n FROM outbox WHERE event_type = 'draw.result_published' AND payload->>'drawId' = $1", [id]),
      ).toBe(1);
      expect(
        await contar("SELECT count(*)::int AS n FROM audit_events WHERE action = 'draw.result_published' AND target_id = $1", [id]),
      ).toBe(1);
    });

    it('a prova e refazivel: o hash sai do snapshot, da fonte, das tentativas e do contemplado', async () => {
      const id = await sorteio();
      const pedido = await venda(id, [7, 42]);
      await ateApuracao(id);
      const res = await publicar(id, { federalNumber: '12342', ...evidencia });

      const { rows } = await harness.owner.query<{ sha256: string }>('SELECT sha256 FROM draw_snapshots WHERE draw_id = $1', [id]);
      const esperado = computeProofHash({
        snapshotSha256: rows[0]!.sha256,
        federalNumber: '12342',
        federalContest: '6001',
        labelDigits: 2,
        candidateNumber: 42,
        attempts: [{ number: 42, inGrid: true, sold: true }],
        winningNumber: 42,
        winnerOrderId: pedido,
      });
      expect(res.body.current.proofSha256).toBe(esperado);
      expect(res.body.current.snapshotSha256).toBe(rows[0]!.sha256);
    });

    it('numero nao vendido: usa o proximo vendido acima e mostra cada tentativa', async () => {
      const id = await sorteio();
      await venda(id, [43]);
      await ateApuracao(id);

      const res = await publicar(id, { federalNumber: '99940', ...evidencia });

      expect(res.body.current).toMatchObject({ candidateNumber: 40, winningNumber: 43 });
      expect(res.body.current.attempts.map((a: { number: number }) => a.number)).toEqual([40, 41, 42, 43]);
    });

    it('grade de 500: candidato fora da grade recomeca no 0, e o rotulo tem 3 digitos', async () => {
      const id = await sorteio(500);
      await venda(id, [2, 400]);
      await ateApuracao(id);

      const res = await publicar(id, { federalNumber: '55731', ...evidencia });

      expect(res.body.current).toMatchObject({ candidateNumber: 731, winningNumber: 2, winningLabel: '002' });
      expect(res.body.current.attempts[0]).toEqual({ number: 731, inGrid: false, sold: false });
    });

    it('SEM_CONTEMPLADO: numero nao vendido nao procura outro e ninguem e contemplado', async () => {
      const id = await sorteio(100, 'SEM_CONTEMPLADO');
      await venda(id, [43]);
      await ateApuracao(id);

      const res = await publicar(id, { federalNumber: '99940', ...evidencia });

      expect(res.status).toBe(201);
      expect(res.body.current.winningNumber).toBeNull();
      expect(res.body.current.winnerMasked).toBeNull();
      expect(res.body.winnerOrderId).toBeNull();
    });

    it('o retrato fica visivel ao organizador junto do sorteio', async () => {
      const id = await sorteio();
      await venda(id, [1, 2, 3]);
      await ateApuracao(id);

      const res = await request(harness.app)
        .get(`/api/tenant/draws/${id}`)
        .set('Cookie', cookie)
        .set('x-tenant-slug', slug);

      expect(res.body.status).toBe('APURAÇÃO');
      expect(res.body.snapshot).toMatchObject({ paidCount: 3 });
      expect(res.body.snapshot.sha256).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // -------------------------------------------------------------------------
  describe('o que barra a publicacao', () => {
    it('fora de APURAÇÃO: ativa, ou encerrada sem retrato, nao publica', async () => {
      const ativa = await sorteio();
      expect((await publicar(ativa, { federalNumber: '12342', ...evidencia })).status).toBe(409);

      const encerrada = await sorteio();
      await venda(encerrada, [1]);
      await request(harness.app)
        .post(`/api/tenant/draws/${encerrada}/status`)
        .set('Cookie', cookie)
        .set('x-tenant-slug', slug)
        .send({ status: 'VENDAS ENCERRADAS' });
      expect((await publicar(encerrada, { federalNumber: '12342', ...evidencia })).status).toBe(409);
    });

    it('a rota de status NAO leva a RESULTADO PUBLICADO nem a APURAÇÃO', async () => {
      const id = await sorteio();
      await venda(id, [1]);
      await ateApuracao(id);
      for (const destino of ['RESULTADO PUBLICADO', 'ARQUIVADA', 'ATIVA']) {
        const res = await request(harness.app)
          .post(`/api/tenant/draws/${id}/status`)
          .set('Cookie', cookie)
          .set('x-tenant-slug', slug)
          .send({ status: destino });
        expect(res.status, destino).toBe(409);
      }
    });

    it('duas publicacoes: a segunda e recusada e ha um unico resultado', async () => {
      const id = await sorteio();
      await venda(id, [42]);
      await ateApuracao(id);
      expect((await publicar(id, { federalNumber: '12342', ...evidencia })).status).toBe(201);

      const segunda = await publicar(id, { federalNumber: '12399', ...evidencia });

      expect(segunda.status).toBe(409);
      expect(await contar('SELECT count(*)::int AS n FROM draw_results WHERE draw_id = $1', [id])).toBe(1);
    });

    it('publicacoes simultaneas: uma vence', async () => {
      const id = await sorteio();
      await venda(id, [42]);
      await ateApuracao(id);
      const respostas = await Promise.all(
        Array.from({ length: 4 }, () => publicar(id, { federalNumber: '12342', ...evidencia })),
      );
      expect(respostas.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await contar('SELECT count(*)::int AS n FROM draw_results WHERE draw_id = $1', [id])).toBe(1);
    });

    it('sem evidencia, com numero invalido ou curto demais: 400', async () => {
      const id = await sorteio();
      await venda(id, [42]);
      await ateApuracao(id);
      expect((await publicar(id, { federalNumber: '12342' })).status).toBe(400);
      expect((await publicar(id, { federalNumber: 'abcde', ...evidencia })).status).toBe(400);
      expect((await publicar(id, { federalNumber: '7', ...evidencia })).status).toBe(400);
      expect((await publicar(id, { federalNumber: '12342', evidenceUrl: 'http://x.exemplo' })).status).toBe(400);
    });

    it('sem o segundo fator satisfeito, nao publica (RN12)', async () => {
      const id = await sorteio();
      await venda(id, [42]);
      await ateApuracao(id);
      const res = await publicar(id, { federalNumber: '12342', ...evidencia }, semMfaCookie);
      expect(res.status).toBe(403);
      expect(await contar('SELECT count(*)::int AS n FROM draw_results WHERE draw_id = $1', [id])).toBe(0);
    });

    it('sem sessao: 401', async () => {
      const id = await sorteio();
      const res = await request(harness.app)
        .post(`/api/tenant/draws/${id}/result`)
        .set('x-tenant-slug', slug)
        .send({ federalNumber: '12342', ...evidencia });
      expect(res.status).toBe(401);
    });

    it('sorteio de OUTRA comunidade: 404', async () => {
      const outra = unique('alheia-');
      const outroTenant = await seedTenantWithSlug(harness.owner, outra, 'Alheia');
      const { rows } = await harness.owner.query<{ id: string }>(
        `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers, status)
         VALUES ($1, $2, 'Alheio', 'P', 1000, 100, 'APURAÇÃO') RETURNING id`,
        [outroTenant, unique('a-')],
      );
      expect((await publicar(rows[0]!.id, { federalNumber: '12342', ...evidencia })).status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe('pagina publica', () => {
    it('mostra numero, nome MASCARADO, fonte, data e hash — e nada de dado pessoal', async () => {
      const id = await sorteio();
      await venda(id, [42], 'Maria Souza', '+55 11 91234-5678');
      await ateApuracao(id);
      await publicar(id, { federalNumber: '12342', ...evidencia });

      const res = await paginaPublica(await slugDe(id));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ drawTitle: 'Rifa do Resultado', labelDigits: 2 });
      expect(res.body.current).toMatchObject({
        winningLabel: '42',
        winnerMasked: 'M*** S***',
        source: 'LOTERIA_FEDERAL',
      });
      expect(res.body.current.proofSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(res.body.current.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);

      const texto = JSON.stringify(res.body);
      expect(texto).not.toContain('Maria');
      expect(texto).not.toContain('91234');
      expect(res.body).not.toHaveProperty('winnerOrderId');
    });

    it('sem resultado publicado: 404', async () => {
      const id = await sorteio();
      expect((await paginaPublica(await slugDe(id))).status).toBe(404);
      await venda(id, [1]);
      await ateApuracao(id);
      expect((await paginaPublica(await slugDe(id))).status).toBe(404);
    });

    it('a vitrine continua mostrando o sorteio em APURAÇÃO e com resultado publicado', async () => {
      const id = await sorteio();
      await venda(id, [42]);
      await ateApuracao(id);
      const durante = await request(harness.app).get('/api/public/draws').set('x-tenant-slug', slug);
      expect(durante.body.draws.find((d: { id: string }) => d.id === id)?.status).toBe('APURAÇÃO');

      await publicar(id, { federalNumber: '12342', ...evidencia });
      const depois = await request(harness.app).get('/api/public/draws').set('x-tenant-slug', slug);
      expect(depois.body.draws.find((d: { id: string }) => d.id === id)?.status).toBe('RESULTADO PUBLICADO');
    });

    it('resultado de OUTRA comunidade nao aparece', async () => {
      const id = await sorteio();
      await venda(id, [42]);
      await ateApuracao(id);
      await publicar(id, { federalNumber: '12342', ...evidencia });
      const outra = unique('vazia-');
      await seedTenantWithSlug(harness.owner, outra, 'Vazia');
      const res = await request(harness.app)
        .get(`/api/public/draws/${await slugDe(id)}/result`)
        .set('x-tenant-slug', outra);
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe('RN09 · correcao de resultado', () => {
    async function publicado(): Promise<{ id: string; pedidoA: string; pedidoB: string }> {
      const id = await sorteio();
      const pedidoA = await venda(id, [42], 'Maria Souza');
      const pedidoB = await venda(id, [43], 'Joao Pereira');
      await ateApuracao(id);
      expect((await publicar(id, { federalNumber: '12342', ...evidencia })).status).toBe(201);
      return { id, pedidoA, pedidoB };
    }

    it('cria a versao 2; a 1 fica RETIFICADA e VISIVEL', async () => {
      const { id, pedidoB } = await publicado();

      const res = await corrigir(id, {
        federalNumber: '12343',
        ...evidencia,
        reason: 'Digitei o número do concurso errado.',
      });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.current).toMatchObject({
        version: 2,
        status: 'VIGENTE',
        winningNumber: 43,
        correctionReason: 'Digitei o número do concurso errado.',
      });
      expect(res.body.winnerOrderId).toBe(pedidoB);
      expect(res.body.previous).toHaveLength(1);
      expect(res.body.previous[0]).toMatchObject({ version: 1, status: 'RETIFICADA', winningNumber: 42 });
      expect(res.body.current.proofSha256).not.toBe(res.body.previous[0].proofSha256);

      // A pagina publica mostra as duas, com a antiga marcada.
      const publica = await paginaPublica(await slugDe(id));
      expect(publica.body.current.version).toBe(2);
      expect(publica.body.previous.map((v: { status: string }) => v.status)).toEqual(['RETIFICADA']);
    });

    it('a versao 1 continua intacta no banco', async () => {
      const { id } = await publicado();
      await corrigir(id, { federalNumber: '12343', ...evidencia, reason: 'Corrigindo o número.' });
      const { rows } = await harness.owner.query(
        'SELECT version, status, federal_number, winning_number FROM draw_results WHERE draw_id = $1 ORDER BY version',
        [id],
      );
      expect(rows).toEqual([
        { version: 1, status: 'RETIFICADA', federal_number: '12342', winning_number: 42 },
        { version: 2, status: 'VIGENTE', federal_number: '12343', winning_number: 43 },
      ]);
    });

    it('audita a correcao (antes/depois, motivo) e publica draw.result_corrected', async () => {
      const { id } = await publicado();
      await corrigir(id, { federalNumber: '12343', ...evidencia, reason: 'Corrigindo o número.' });

      const { rows } = await harness.owner.query<{ before: { version: number }; after: { reason: string; winnerChanged: boolean } }>(
        "SELECT before, after FROM audit_events WHERE action = 'draw.result_corrected' AND target_id = $1",
        [id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.before.version).toBe(1);
      expect(rows[0]!.after).toMatchObject({ reason: 'Corrigindo o número.', winnerChanged: true });
      expect(
        await contar("SELECT count(*)::int AS n FROM outbox WHERE event_type = 'draw.result_corrected' AND payload->>'drawId' = $1", [id]),
      ).toBe(1);
    });

    it('exige motivo, e so vale para resultado ja publicado', async () => {
      const { id } = await publicado();
      expect((await corrigir(id, { federalNumber: '12343', ...evidencia })).status).toBe(400);
      expect((await corrigir(id, { federalNumber: '12343', ...evidencia, reason: 'ab' })).status).toBe(400);

      const apurando = await sorteio();
      await venda(apurando, [1]);
      await ateApuracao(apurando);
      expect((await corrigir(apurando, { federalNumber: '12343', ...evidencia, reason: 'Sem resultado ainda.' })).status).toBe(409);
    });

    it('correcoes seguidas geram versoes 2, 3, 4...; so a ultima e vigente', async () => {
      const { id } = await publicado();
      for (const n of ['12344', '12345', '12346']) {
        expect((await corrigir(id, { federalNumber: n, ...evidencia, reason: `Ajuste ${n}.` })).status).toBe(200);
      }
      const { rows } = await harness.owner.query('SELECT version, status FROM draw_results WHERE draw_id = $1 ORDER BY version', [id]);
      expect(rows.map((r) => `${r.version}:${r.status}`)).toEqual(['1:RETIFICADA', '2:RETIFICADA', '3:RETIFICADA', '4:VIGENTE']);
    });

    it('correcoes simultaneas: uma vence por vez, nunca duas vigentes', async () => {
      const { id } = await publicado();
      await Promise.all(
        ['12350', '12351', '12352'].map((n) => corrigir(id, { federalNumber: n, ...evidencia, reason: `Ajuste ${n}.` })),
      );
      expect(await contar("SELECT count(*)::int AS n FROM draw_results WHERE draw_id = $1 AND status = 'VIGENTE'", [id])).toBe(1);
    });

    it('a leitura do organizador traz o pedido contemplado', async () => {
      const { id, pedidoA } = await publicado();
      const res = await request(harness.app)
        .get(`/api/tenant/draws/${id}/result`)
        .set('Cookie', cookie)
        .set('x-tenant-slug', slug);
      expect(res.status).toBe(200);
      expect(res.body.winnerOrderId).toBe(pedidoA);
    });
  });
});
