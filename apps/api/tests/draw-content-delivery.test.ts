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

/**
 * Conteudo do sorteio (assistente de 9 passos) e entrega do premio. DOC-01 §4, §6, §15.
 *
 * O caminho e o de verdade: a API cria e edita o rascunho; o resultado e publicado pelo
 * mesmo fluxo de results.test.ts (fechamento pela API, snapshot pelo "worker"); a entrega e
 * o arquivamento sao feitos pela API, e o banco e conferido por baixo.
 */
const REGULAMENTO =
  'Regulamento do sorteio de teste: participam todos os números pagos e o resultado segue a Loteria Federal do dia indicado.';

describe.skipIf(!hasTestDatabase)(`Conteudo do sorteio e entrega ${hasTestDatabase ? '' : skipReason}`, () => {
  let harness: Harness;
  let worker: DbPool;
  let slug: string;
  let tenantId: string;
  let cookie: string;
  let slugB: string;
  let cookieB: string;
  let suporteCookie: string;

  beforeAll(async () => {
    harness = await createHarness();
    worker = createPool({
      connectionString: process.env['TEST_WORKER_DATABASE_URL'] ?? '',
      applicationName: 'test-worker-content',
      max: 2,
    });
    await cleanup(harness.owner);

    slug = unique('cnt-');
    tenantId = await seedTenantWithSlug(harness.owner, slug, 'Comunidade do Conteudo');
    const dono = await seedAccount(harness.owner);
    await grantMembership(harness.owner, { tenantId, userId: dono.userId, role: 'OWNER' });
    const secret = await seedConfirmedTotp(harness.owner, dono.userId);
    cookie = (await verifyMfa(harness, (await loginAs(harness, dono)).cookie, await currentCode(secret))).cookie;

    const suporte = await seedAccount(harness.owner);
    await grantMembership(harness.owner, { tenantId, userId: suporte.userId, role: 'SUPPORT' });
    suporteCookie = (await loginAs(harness, suporte)).cookie;

    slugB = unique('cntb-');
    const tenantB = await seedTenantWithSlug(harness.owner, slugB, 'Outra Comunidade');
    const donoB = await seedAccount(harness.owner);
    await grantMembership(harness.owner, { tenantId: tenantB, userId: donoB.userId, role: 'OWNER' });
    const secretB = await seedConfirmedTotp(harness.owner, donoB.userId);
    cookieB = (await verifyMfa(harness, (await loginAs(harness, donoB)).cookie, await currentCode(secretB))).cookie;
  }, 180_000);

  afterAll(async () => {
    await worker?.end();
    await harness?.close();
  });

  // ---- cenario ------------------------------------------------------------

  const base = () => ({
    title: `Sorteio ${unique('t-')}`,
    regulation: REGULAMENTO,
    prizes: [{ name: 'Moto 0 km' }],
    ticketPriceCents: 1500,
    totalNumbers: 100,
    drawDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });

  const como = (c = cookie, s = slug) => ({
    get: (url: string) => request(harness.app).get(url).set('Cookie', c).set('x-tenant-slug', s),
    post: (url: string, body: object = {}) =>
      request(harness.app).post(url).set('Cookie', c).set('x-tenant-slug', s).send(body),
    patch: (url: string, body: object = {}) =>
      request(harness.app).patch(url).set('Cookie', c).set('x-tenant-slug', s).send(body),
  });

  const criar = (body: Record<string, unknown> = {}) => como().post('/api/tenant/draws', { ...base(), ...body });

  async function estado(id: string): Promise<string> {
    const { rows } = await harness.owner.query<{ s: string }>('SELECT status::text AS s FROM draws WHERE id = $1', [id]);
    return rows[0]!.s;
  }

  /** Rascunho -> ATIVA sem passar pela revisao (so o cenario; a revisao e testada em outro arquivo). */
  async function ativar(id: string): Promise<void> {
    await harness.owner.query(`UPDATE draws SET status = 'ATIVA' WHERE id = $1`, [id]);
  }

  async function venda(drawId: string, numeros: number[]) {
    const { rows: b } = await harness.owner.query<{ id: string }>(
      `INSERT INTO buyers (tenant_id, name, phone) VALUES ($1, 'Maria Souza', '+55 11 91234-5678') RETURNING id`,
      [tenantId],
    );
    const { rows: o } = await harness.owner.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, draw_id, buyer_id, status, unit_price_cents, quantity, total_cents, accepted_terms_at, paid_at)
       VALUES ($1, $2, $3, 'PAGO', 1500, $4, $5, now(), now()) RETURNING id`,
      [tenantId, drawId, b[0]!.id, numeros.length, numeros.length * 1500],
    );
    await harness.owner.query(
      'INSERT INTO order_items (tenant_id, order_id, number, unit_price_cents) SELECT $1, $2, n, 1500 FROM unnest($3::int[]) AS n',
      [tenantId, o[0]!.id, numeros],
    );
    await harness.owner.query(
      "INSERT INTO draw_numbers (tenant_id, draw_id, number, status, order_id) SELECT $1, $2, n, 'PAGO', $3 FROM unnest($4::int[]) AS n",
      [tenantId, drawId, o[0]!.id, numeros],
    );
  }

  /** Cria, ativa, vende, fecha, apura e PUBLICA o resultado. Devolve o id do sorteio. */
  async function ateResultadoPublicado(): Promise<string> {
    const criado = await criar();
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    const id = criado.body.id as string;
    await ativar(id);
    await venda(id, [42]);
    const fecha = await como().post(`/api/tenant/draws/${id}/status`, { status: 'VENDAS ENCERRADAS' });
    expect(fecha.status, JSON.stringify(fecha.body)).toBe(200);
    await worker.query('SELECT app.worker_create_draw_snapshot($1)', [id]);
    await worker.query("SELECT app.worker_transition_draw($1, 'APURAÇÃO', NULL)", [id]);
    const pub = await como().post(`/api/tenant/draws/${id}/result`, {
      federalNumber: '12342',
      evidenceText: 'Loteria Federal, concurso 6001.',
      federalContest: '6001',
    });
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    return id;
  }

  const entrega = (over: Record<string, unknown> = {}) => ({
    method: 'ENVIO',
    deliveredAt: new Date().toISOString(),
    trackingCode: 'BR123456789XX',
    notes: 'Entregue na portaria, assinado por familiar.',
    winnerImageAuthorized: true,
    ...over,
  });

  // -------------------------------------------------------------------------
  describe('conteudo: subtitulo, categoria, regulamento, valor do premio e personalizacao', () => {
    it('grava tudo e a vitrine devolve; sem ajuste, a personalizacao vem no padrao', async () => {
      const res = await criar({
        subtitle: 'Concorra a uma moto zero',
        category: 'Veículos',
        customization: { progressMode: 'PERCENTUAL', headline: 'Corra, restam poucos!', ctaLabel: 'Quero meus números' },
        prizes: [
          { name: 'Moto 0 km', estimatedValueCents: 2_500_000 },
          { name: 'Capacete', description: 'Integral' },
        ],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({
        subtitle: 'Concorra a uma moto zero',
        category: 'Veículos',
        regulation: REGULAMENTO,
        customization: { progressMode: 'PERCENTUAL', headline: 'Corra, restam poucos!', ctaLabel: 'Quero meus números' },
      });
      expect(res.body.prizes.map((p: { estimatedValueCents: number | null }) => p.estimatedValueCents)).toEqual([2_500_000, null]);

      await ativar(res.body.id);
      const slugDoSorteio = (await harness.owner.query<{ slug: string }>('SELECT slug FROM draws WHERE id = $1', [res.body.id])).rows[0]!.slug;
      const publico = await request(harness.app).get(`/api/public/draws/${slugDoSorteio}`).set('x-tenant-slug', slug);
      expect(publico.status).toBe(200);
      expect(publico.body).toMatchObject({
        subtitle: 'Concorra a uma moto zero',
        category: 'Veículos',
        regulation: REGULAMENTO,
        customization: { progressMode: 'PERCENTUAL', headline: 'Corra, restam poucos!', ctaLabel: 'Quero meus números' },
      });

      const simples = await criar();
      expect(simples.body).toMatchObject({
        subtitle: null,
        category: null,
        customization: { progressMode: 'FALTAM', headline: null, ctaLabel: null },
      });
    });

    it('personalizacao invalida e recusada: campo desconhecido, texto longo e modo fora da lista', async () => {
      for (const customization of [
        { corDeFundo: '#000' },
        { headline: 'x'.repeat(121) },
        { ctaLabel: 'y'.repeat(31) },
        { progressMode: 'EXPLODIR' },
        { headline: '' },
      ]) {
        const res = await criar({ customization });
        expect(res.status, JSON.stringify(customization)).toBe(400);
      }
    });

    it('valor estimado negativo ou absurdo e recusado', async () => {
      expect((await criar({ prizes: [{ name: 'Moto', estimatedValueCents: -1 }] })).status).toBe(400);
      expect((await criar({ prizes: [{ name: 'Moto', estimatedValueCents: 2_000_000_001 }] })).status).toBe(400);
    });

    it('edicao do rascunho: null limpa subtitulo e personalizacao; o objeto SUBSTITUI o anterior', async () => {
      const criado = await criar({ subtitle: 'Antigo', customization: { headline: 'Antiga', progressMode: 'OCULTAR' } });
      const id = criado.body.id as string;

      const troca = await como().patch(`/api/tenant/draws/${id}`, { customization: { ctaLabel: 'Comprar' } });
      expect(troca.status, JSON.stringify(troca.body)).toBe(200);
      // Substituiu: a chamada e o modo anteriores nao sobrevivem.
      expect(troca.body.customization).toMatchObject({ progressMode: 'FALTAM', headline: null, ctaLabel: 'Comprar' });

      const limpa = await como().patch(`/api/tenant/draws/${id}`, { subtitle: null, customization: null, category: 'Casa' });
      expect(limpa.status, JSON.stringify(limpa.body)).toBe(200);
      expect(limpa.body).toMatchObject({
        subtitle: null,
        category: 'Casa',
        customization: { progressMode: 'FALTAM', headline: null, ctaLabel: null },
      });
    });

    it('so o rascunho se edita: depois de ATIVA, o conteudo nao muda', async () => {
      const criado = await criar();
      await ativar(criado.body.id);
      const res = await como().patch(`/api/tenant/draws/${criado.body.id}`, { subtitle: 'Tarde demais' });
      expect(res.status).toBe(409);
    });

    it('RN02: sem regulamento (ou com um texto de enfeite), o envio para revisao e recusado com a orientacao', async () => {
      for (const regulation of [undefined, 'curto', '   ']) {
        const criado = await criar({ regulation });
        expect(criado.status, JSON.stringify(criado.body)).toBe(201);
        const envio = await como().post(`/api/tenant/draws/${criado.body.id}/status`, { status: 'REVISÃO COMPLIANCE' });
        expect(envio.status, String(regulation)).toBe(400);
        expect(envio.body.error.message).toMatch(/regulamento/i);
        expect(await estado(criado.body.id)).toBe('RASCUNHO');
      }
      const ok = await criar();
      expect((await como().post(`/api/tenant/draws/${ok.body.id}/status`, { status: 'REVISÃO COMPLIANCE' })).status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  describe('entrega do premio e arquivamento (DOC-01 §15)', () => {
    it('antes do resultado publicado, nao ha o que entregar (409)', async () => {
      const criado = await criar();
      const res = await como().post(`/api/tenant/draws/${criado.body.id}/delivery`, entrega());
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/resultado/i);
    });

    it('registra a entrega: o organizador ve tudo; o publico ve SO que foi entregue, quando e como', async () => {
      const id = await ateResultadoPublicado();
      const quando = '2030-03-01T15:00:00.000Z';
      const res = await como().post(`/api/tenant/draws/${id}/delivery`, entrega({ deliveredAt: quando }));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.delivery).toMatchObject({
        method: 'ENVIO',
        trackingCode: 'BR123456789XX',
        notes: 'Entregue na portaria, assinado por familiar.',
        winnerImageAuthorized: true,
      });
      expect(new Date(res.body.delivery.deliveredAt).toISOString()).toBe(quando);

      const slugDoSorteio = (await harness.owner.query<{ slug: string }>('SELECT slug FROM draws WHERE id = $1', [id])).rows[0]!.slug;
      const publico = await request(harness.app).get(`/api/public/draws/${slugDoSorteio}/result`).set('x-tenant-slug', slug);
      expect(publico.status).toBe(200);
      expect(Object.keys(publico.body.delivery).sort()).toEqual(['deliveredAt', 'method']);
      expect(JSON.stringify(publico.body)).not.toMatch(/BR123456789XX|portaria|winnerImage/);
    });

    it('corrigir a entrega atualiza o registro (um por sorteio) e a trilha guarda quem e quando, sem rastreio nem observacao', async () => {
      const id = await ateResultadoPublicado();
      await como().post(`/api/tenant/draws/${id}/delivery`, entrega({ method: 'RETIRADA', trackingCode: undefined }));
      const dois = await como().post(`/api/tenant/draws/${id}/delivery`, entrega({ method: 'TRANSFERENCIA', winnerImageAuthorized: false }));
      expect(dois.status).toBe(200);
      expect(dois.body.delivery).toMatchObject({ method: 'TRANSFERENCIA', winnerImageAuthorized: false });

      const { rows: n } = await harness.owner.query<{ n: number }>('SELECT count(*)::int AS n FROM draw_deliveries WHERE draw_id = $1', [id]);
      expect(n[0]!.n).toBe(1);

      const { rows: trilha } = await harness.owner.query<{ action: string; after: unknown }>(
        `SELECT action, after FROM audit_events WHERE target_id = $1 AND action LIKE 'draw.delivery_%' ORDER BY occurred_at`,
        [id],
      );
      expect(trilha.map((t) => t.action)).toEqual(['draw.delivery_recorded', 'draw.delivery_updated']);
      expect(JSON.stringify(trilha)).not.toMatch(/BR123456789XX|portaria/);
    });

    it('entrada invalida e recusada: forma desconhecida, data malformada, rastreio gigante', async () => {
      const id = await ateResultadoPublicado();
      for (const ruim of [{ method: 'DRONE' }, { deliveredAt: 'ontem' }, { trackingCode: 'x'.repeat(101) }, { winnerImageAuthorized: 'sim' }]) {
        const res = await como().post(`/api/tenant/draws/${id}/delivery`, entrega(ruim));
        expect(res.status, JSON.stringify(ruim)).toBe(400);
      }
    });

    it('arquivar exige a entrega registrada; depois de arquivado, tudo e somente leitura', async () => {
      const id = await ateResultadoPublicado();

      const semEntrega = await como().post(`/api/tenant/draws/${id}/status`, { status: 'ARQUIVADA' });
      expect(semEntrega.status).toBe(409);
      expect(semEntrega.body.error.message).toMatch(/entrega/i);
      expect(await estado(id)).toBe('RESULTADO PUBLICADO');

      // O banco tambem barra (por baixo da API): nem o dono do schema arquiva sem entrega.
      await expect(harness.owner.query(`UPDATE draws SET status = 'ARQUIVADA' WHERE id = $1`, [id])).rejects.toThrow(/registre a entrega/);

      expect((await como().post(`/api/tenant/draws/${id}/delivery`, entrega())).status).toBe(200);
      const arquiva = await como().post(`/api/tenant/draws/${id}/status`, { status: 'ARQUIVADA' });
      expect(arquiva.status, JSON.stringify(arquiva.body)).toBe(200);
      expect(arquiva.body.status).toBe('ARQUIVADA');

      const { rows: ev } = await harness.owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM outbox WHERE event_type = 'draw.archived' AND payload->>'drawId' = $1`,
        [id],
      );
      expect(ev[0]!.n).toBe(1);

      // Somente leitura: nem corrigir a entrega, nem arquivar de novo.
      const tarde = await como().post(`/api/tenant/draws/${id}/delivery`, entrega({ method: 'RETIRADA' }));
      expect(tarde.status).toBe(409);
      expect(tarde.body.error.message).toMatch(/arquivado/i);
      await expect(
        harness.owner.query(`UPDATE draw_deliveries SET method = 'RETIRADA' WHERE draw_id = $1`, [id]),
      ).rejects.toThrow(/resultado publicado/);

      // O resultado publico continua la, com a entrega.
      const slugDoSorteio = (await harness.owner.query<{ slug: string }>('SELECT slug FROM draws WHERE id = $1', [id])).rows[0]!.slug;
      const publico = await request(harness.app).get(`/api/public/draws/${slugDoSorteio}/result`).set('x-tenant-slug', slug);
      expect(publico.status).toBe(200);
      expect(publico.body.delivery).toMatchObject({ method: 'ENVIO' });
    });

    it('so quem tem a permissao registra; outra comunidade nao alcanca o sorteio', async () => {
      const id = await ateResultadoPublicado();
      expect((await como(suporteCookie).post(`/api/tenant/draws/${id}/delivery`, entrega())).status).toBe(403);
      const deB = await como(cookieB, slugB).post(`/api/tenant/draws/${id}/delivery`, entrega());
      expect(deB.status).toBe(404);
      const { rows } = await harness.owner.query('SELECT 1 FROM draw_deliveries WHERE draw_id = $1', [id]);
      expect(rows).toHaveLength(0);
    });
  });
});
