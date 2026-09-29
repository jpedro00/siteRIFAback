import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  cleanup,
  createHarness,
  currentCode,
  grantMembership,
  grantPlatformRole,
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
 * Sorteio alinhado ao DOC-01 §18 (migration 0012), pela API.
 *
 * O que estes testes protegem: o preco cobrado e sempre o decidido no servidor,
 * fica travado na reserva, e o rascunho so segue para revisao quando completo.
 */
describe.skipIf(!hasTestDatabase)(`Sorteio DOC-01 · API ${hasTestDatabase ? '' : skipReason}`, () => {
  let harness: Harness;
  let slug: string;
  let organizerCookie: string;
  let platformCookie: string;

  const amanha = () => new Date(Date.now() + 86_400_000).toISOString();
  const emDias = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

  beforeAll(async () => {
    harness = await createHarness();
    await cleanup(harness.owner);

    slug = unique('doc01-');
    const tenantId = await seedTenantWithSlug(harness.owner, slug, 'Comunidade DOC-01');

    const organizer = await seedAccount(harness.owner);
    await grantMembership(harness.owner, { tenantId, userId: organizer.userId, role: 'OPERATOR' });
    organizerCookie = (await loginAs(harness, organizer)).cookie;

    const admin = await seedAccount(harness.owner);
    await grantPlatformRole(harness.owner, { userId: admin.userId, role: 'PLATFORM_COMPLIANCE' });
    const secret = await seedConfirmedTotp(harness.owner, admin.userId);
    const login = await loginAs(harness, admin);
    platformCookie = (await verifyMfa(harness, login.cookie, await currentCode(secret))).cookie;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  const base = () => ({
    title: `Sorteio ${unique('t-')}`,
    prizes: [{ name: 'Moto 0 km' }],
    ticketPriceCents: 1500,
    totalNumbers: 100,
    drawDate: emDias(30),
  });

  function criar(body: Record<string, unknown> = {}) {
    return request(harness.app)
      .post('/api/tenant/draws')
      .set('Cookie', organizerCookie)
      .set('x-tenant-slug', slug)
      .send({ ...base(), ...body });
  }

  function editar(id: string, body: Record<string, unknown>) {
    return request(harness.app)
      .patch(`/api/tenant/draws/${id}`)
      .set('Cookie', organizerCookie)
      .set('x-tenant-slug', slug)
      .send(body);
  }

  function status(id: string, to: string) {
    return request(harness.app)
      .post(`/api/tenant/draws/${id}/status`)
      .set('Cookie', organizerCookie)
      .set('x-tenant-slug', slug)
      .send({ status: to });
  }

  async function ativarPorSql(id: string): Promise<void> {
    await harness.owner.query("UPDATE draws SET status = 'ATIVA' WHERE id = $1", [id]);
  }

  function reservar(id: string, numbers: number[]) {
    return request(harness.app)
      .post(`/api/public/draws/${id}/reservations`)
      .set('x-tenant-slug', slug)
      .send({ numbers });
  }

  // -------------------------------------------------------------------------
  describe('criacao', () => {
    it('aceita varios premios e devolve a posicao de cada um', async () => {
      const res = await criar({
        prizes: [
          { name: 'Moto', description: 'Zero km', imageUrl: 'https://cdn.exemplo/moto.jpg' },
          { name: 'Capacete' },
        ],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.prizes).toEqual([
        { position: 1, name: 'Moto', description: 'Zero km', imageUrl: 'https://cdn.exemplo/moto.jpg' },
        { position: 2, name: 'Capacete', description: null, imageUrl: null },
      ]);
      // O premio principal continua nas colunas de resumo da listagem.
      expect(res.body.prizeName).toBe('Moto');
      expect(res.body.prizeImageUrl).toBe('https://cdn.exemplo/moto.jpg');
    });

    it('sem premio, e recusado', async () => {
      expect((await criar({ prizes: [] })).status).toBe(400);
    });

    it('link de imagem em http e recusado (so https)', async () => {
      const res = await criar({ prizes: [{ name: 'Moto', imageUrl: 'http://antigo.exemplo/a.jpg' }] });
      expect(res.status).toBe(400);
    });

    it('padroes: fechamento AO_ESGOTAR, fonte LOTERIA_FEDERAL, limiares 25 e 10', async () => {
      const res = await criar();
      expect(res.body.closeMode).toBe('AO_ESGOTAR');
      expect(res.body.resultSource).toBe('LOTERIA_FEDERAL');
      expect(res.body.thresholds).toEqual([25, 10]);
      expect(res.body.status).toBe('RASCUNHO');
    });

    it('RN13 · labelDigits: 2 para 100; 3 para 500 e 1000', async () => {
      for (const [grade, digitos] of [
        [100, 2],
        [500, 3],
        [1000, 3],
      ] as const) {
        const res = await criar({ totalNumbers: grade });
        expect(res.status).toBe(201);
        expect(res.body.labelDigits, `grade ${grade}`).toBe(digitos);
      }
    });

    it('promocional MENOR que o cheio e aceito; igual ou maior, recusado', async () => {
      const ok = await criar({ promotionalPriceCents: 1000, promoUntil: amanha() });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);

      for (const promo of [1500, 1800]) {
        const ruim = await criar({ promotionalPriceCents: promo, promoUntil: amanha() });
        expect(ruim.status, `promocional ${promo}`).toBe(400);
      }
    });

    it('promocional sem prazo e recusado', async () => {
      expect((await criar({ promotionalPriceCents: 1000 })).status).toBe(400);
    });

    it('fechamento posterior a data do sorteio e recusado', async () => {
      const res = await criar({ drawDate: emDias(10), closeAt: emDias(12) });
      expect(res.status).toBe(400);
    });

    it('limiares fora de ordem sao recusados', async () => {
      expect((await criar({ thresholds: [10, 25] })).status).toBe(400);
      expect((await criar({ thresholds: [50, 20, 5] })).status).toBe(201);
    });
  });

  // -------------------------------------------------------------------------
  describe('preco efetivo e preco travado na reserva', () => {
    it('promocao vigente: o preco efetivo e o promocional e a vitrine mostra o selo', async () => {
      const draw = await criar({ promotionalPriceCents: 1000, promoUntil: emDias(2) });
      await ativarPorSql(draw.body.id);

      const publico = await request(harness.app)
        .get(`/api/public/draws/${draw.body.slug}`)
        .set('x-tenant-slug', slug);

      expect(publico.status).toBe(200);
      expect(publico.body).toMatchObject({
        unitPriceCents: 1000,
        ticketPriceCents: 1500,
        promotionalPriceCents: 1000,
        promoActive: true,
      });
      expect(publico.body.promoUntil).not.toBeNull();
    });

    it('promocao vencida: volta ao preco cheio e o promocional some da vitrine', async () => {
      const draw = await criar({ promotionalPriceCents: 1000, promoUntil: emDias(2) });
      await ativarPorSql(draw.body.id);
      await harness.owner.query(
        "UPDATE draws SET promo_until = now() - interval '1 minute' WHERE id = $1",
        [draw.body.id],
      );

      const publico = await request(harness.app)
        .get(`/api/public/draws/${draw.body.slug}`)
        .set('x-tenant-slug', slug);

      expect(publico.body).toMatchObject({
        unitPriceCents: 1500,
        promotionalPriceCents: null,
        promoUntil: null,
        promoActive: false,
      });
    });

    it('a reserva usa o preco efetivo e o TRAVA: promocao que vence depois nao muda o pedido', async () => {
      const draw = await criar({ promotionalPriceCents: 1000, promoUntil: emDias(2) });
      await ativarPorSql(draw.body.id);

      const reserva = await reservar(draw.body.id, [3, 4]);
      expect(reserva.status, JSON.stringify(reserva.body)).toBe(201);
      expect(reserva.body.unitPriceCents).toBe(1000);
      expect(reserva.body.totalCents).toBe(2000);

      // A promocao vence no meio dos 30 minutos.
      await harness.owner.query(
        "UPDATE draws SET promo_until = now() - interval '1 minute' WHERE id = $1",
        [draw.body.id],
      );

      const pedido = await request(harness.app)
        .post('/api/public/orders')
        .set('x-tenant-slug', slug)
        .send({
          reservationId: reserva.body.reservationId,
          buyer: { name: 'Maria Souza', phone: '+55 11 91234-5678' },
          acceptedTerms: true,
        });

      expect(pedido.status, JSON.stringify(pedido.body)).toBe(201);
      expect(pedido.body.unitPriceCents, 'o preco da reserva vale').toBe(1000);
      expect(pedido.body.totalCents).toBe(2000);
    });

    it('sem promocao, reservar e comprar usa o preco cheio', async () => {
      const draw = await criar();
      await ativarPorSql(draw.body.id);
      const reserva = await reservar(draw.body.id, [7]);
      expect(reserva.body.unitPriceCents).toBe(1500);
    });
  });

  // -------------------------------------------------------------------------
  describe('edicao do rascunho', () => {
    it('edita preco, grade e premios; o premio principal acompanha', async () => {
      const draw = await criar();
      const res = await editar(draw.body.id, {
        title: 'Titulo novo',
        ticketPriceCents: 2500,
        totalNumbers: 500,
        prizes: [{ name: 'Carro' }, { name: 'Moto' }],
      });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({
        title: 'Titulo novo',
        ticketPriceCents: 2500,
        totalNumbers: 500,
        labelDigits: 3,
        prizeName: 'Carro',
      });
      expect(res.body.prizes.map((p: { name: string }) => p.name)).toEqual(['Carro', 'Moto']);
    });

    it('null limpa a promocao', async () => {
      const draw = await criar({ promotionalPriceCents: 1000, promoUntil: emDias(3) });
      const res = await editar(draw.body.id, { promotionalPriceCents: null, promoUntil: null });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.configuredPromotionalPriceCents).toBeNull();
      expect(res.body.configuredPromoUntil).toBeNull();
    });

    it('as regras entre campos valem sobre o estado MESCLADO', async () => {
      const draw = await criar({ promotionalPriceCents: 1000, promoUntil: emDias(3) });
      // Subir so o promocional para acima do cheio que ja existe.
      const res = await editar(draw.body.id, { promotionalPriceCents: 1600 });
      expect(res.status).toBe(400);
    });

    it('depois do envio para revisao, nao edita mais', async () => {
      const draw = await criar();
      expect((await status(draw.body.id, 'REVISÃO COMPLIANCE')).status).toBe(200);
      const res = await editar(draw.body.id, { title: 'Trocado por baixo dos panos' });
      expect(res.status).toBe(409);
    });

    it('sorteio de OUTRA comunidade nao e encontrado', async () => {
      const outra = unique('outra-');
      const outroTenant = await seedTenantWithSlug(harness.owner, outra, 'Outra');
      const { rows } = await harness.owner.query<{ id: string }>(
        `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers)
         VALUES ($1, $2, 'Alheio', 'P', 1000, 100) RETURNING id`,
        [outroTenant, unique('alheio-')],
      );
      const res = await editar(rows[0]!.id, { title: 'Invadido' });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe('checklist do envio para revisao', () => {
    it('sem data do sorteio, nao vai para revisao e a resposta lista o que falta', async () => {
      const draw = await criar({ drawDate: undefined });
      const res = await status(draw.body.id, 'REVISÃO COMPLIANCE');

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('data do sorteio');
      const { rows } = await harness.owner.query('SELECT status FROM draws WHERE id = $1', [draw.body.id]);
      expect(rows[0]!.status).toBe('RASCUNHO');
    });

    it('fechamento por data sem a data de fechamento nao segue', async () => {
      const draw = await criar({ closeMode: 'POR_DATA' });
      const res = await status(draw.body.id, 'REVISÃO COMPLIANCE');
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('data de fechamento');
    });

    it('rascunho completo segue para revisao', async () => {
      const draw = await criar({ closeMode: 'POR_DATA', closeAt: emDias(20) });
      expect((await status(draw.body.id, 'REVISÃO COMPLIANCE')).status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  describe('motivo da reprovacao chega ao organizador', () => {
    it('reprovado, o organizador le o motivo; reenviado, o motivo some', async () => {
      const draw = await criar();
      expect((await status(draw.body.id, 'REVISÃO COMPLIANCE')).status).toBe(200);

      const reprova = await request(harness.app)
        .post(`/api/platform/draws/${draw.body.id}/review`)
        .set('Cookie', platformCookie)
        .send({ to: 'RASCUNHO', reason: 'Falta informar a fonte do resultado.' });
      expect(reprova.status, JSON.stringify(reprova.body)).toBe(200);

      const lido = await request(harness.app)
        .get(`/api/tenant/draws/${draw.body.id}`)
        .set('Cookie', organizerCookie)
        .set('x-tenant-slug', slug);
      expect(lido.body.reviewNote).toBe('Falta informar a fonte do resultado.');
      expect(lido.body.status).toBe('RASCUNHO');

      expect((await status(draw.body.id, 'REVISÃO COMPLIANCE')).status).toBe(200);
      const depois = await request(harness.app)
        .get(`/api/tenant/draws/${draw.body.id}`)
        .set('Cookie', organizerCookie)
        .set('x-tenant-slug', slug);
      expect(depois.body.reviewNote).toBeNull();
    });
  });
});
