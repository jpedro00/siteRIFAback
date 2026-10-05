import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createPool } from '@clubedarifa/db';
import {
  TEST_APP_URL,
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
 * Marca e paginas da comunidade, envio de imagem, compradores e limite por pedido.
 * Somente as regras criticas: isolamento, validacao do arquivo, mascara de nomes,
 * permissao e o limite aplicado no servidor.
 */

// PNG minimo valido (1x1).
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe.skipIf(!hasTestDatabase)(`Comunidade, imagens e compradores ${hasTestDatabase ? '' : skipReason}`, () => {
  let harness: Harness;
  let slug: string;
  let tenantId: string;
  let cookie: string;
  let suporteCookie: string;
  let slugB: string;
  let cookieB: string;

  beforeAll(async () => {
    harness = await createHarness();
    await cleanup(harness.owner);

    slug = unique('com-');
    tenantId = await seedTenantWithSlug(harness.owner, slug, 'Comunidade A');
    const dono = await seedAccount(harness.owner);
    await grantMembership(harness.owner, { tenantId, userId: dono.userId, role: 'OWNER' });
    const secret = await seedConfirmedTotp(harness.owner, dono.userId);
    cookie = (await verifyMfa(harness, (await loginAs(harness, dono)).cookie, await currentCode(secret))).cookie;

    const suporte = await seedAccount(harness.owner);
    await grantMembership(harness.owner, { tenantId, userId: suporte.userId, role: 'SUPPORT' });
    suporteCookie = (await loginAs(harness, suporte)).cookie;

    slugB = unique('comb-');
    const tenantB = await seedTenantWithSlug(harness.owner, slugB, 'Comunidade B');
    const donoB = await seedAccount(harness.owner);
    await grantMembership(harness.owner, { tenantId: tenantB, userId: donoB.userId, role: 'OWNER' });
    const secretB = await seedConfirmedTotp(harness.owner, donoB.userId);
    cookieB = (await verifyMfa(harness, (await loginAs(harness, donoB)).cookie, await currentCode(secretB))).cookie;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  const como = (c = cookie, s = slug) => ({
    get: (url: string) => request(harness.app).get(url).set('Cookie', c).set('x-tenant-slug', s),
    put: (url: string, body: object = {}) => request(harness.app).put(url).set('Cookie', c).set('x-tenant-slug', s).send(body),
    post: (url: string, body: object = {}) => request(harness.app).post(url).set('Cookie', c).set('x-tenant-slug', s).send(body),
  });
  const publico = (url: string, s = slug) => request(harness.app).get(url).set('x-tenant-slug', s);

  describe('marca e paginas', () => {
    it('salva, devolve ao publico e apaga com texto vazio', async () => {
      const put = await como().put('/api/tenant/community', {
        publicName: 'Clube Azul',
        description: 'Sorteios beneficentes.',
        footerText: '© Clube Azul',
        primaryColor: '#1d4ed8',
        contact: { whatsapp: '+55 11 99999-0000', instagram: '@clubeazul' },
        pages: { about: 'Somos o Clube Azul.', terms: 'Termos do clube.' },
      });
      expect(put.status, JSON.stringify(put.body)).toBe(200);

      const pub = await publico('/api/public/tenant');
      expect(pub.body.publicName).toBe('Clube Azul');
      expect(pub.body.colors.primary).toBe('#1d4ed8');
      expect(pub.body.contact.whatsapp).toBe('+55 11 99999-0000');
      expect(pub.body.pages.about).toBe('Somos o Clube Azul.');
      expect(pub.body.footerText).toBe('© Clube Azul');

      const apaga = await como().put('/api/tenant/community', { pages: { about: '' }, contact: { instagram: '' } });
      expect(apaga.body.pages.about).toBeUndefined();
      expect(apaga.body.pages.terms).toBe('Termos do clube.');
      expect(apaga.body.contact.instagram).toBeUndefined();
      expect(apaga.body.contact.whatsapp).toBe('+55 11 99999-0000');
    });

    it('cor invalida e campo desconhecido sao recusados; quem so atende nao edita', async () => {
      expect((await como().put('/api/tenant/community', { primaryColor: 'azul' })).status).toBe(400);
      expect((await como().put('/api/tenant/community', { qualquer: 1 })).status).toBe(400);
      expect((await como(suporteCookie).put('/api/tenant/community', { publicName: 'X' })).status).toBe(403);
    });

    it('a edicao fica na trilha sem o texto das paginas', async () => {
      const { rows } = await harness.owner.query<{ after: { pages?: string[] } }>(
        `SELECT after FROM audit_events WHERE tenant_id = $1 AND action = 'tenant.community_updated' ORDER BY occurred_at DESC LIMIT 1`,
        [tenantId],
      );
      expect(rows[0]!.after.pages).toContain('terms');
      expect(JSON.stringify(rows[0]!.after)).not.toContain('Termos do clube');
    });
  });

  describe('imagens', () => {
    it('envia, devolve o caminho publico e serve o arquivo sem sessao nem comunidade', async () => {
      const up = await como().post('/api/tenant/media', { contentType: 'image/png', dataBase64: PNG_1X1 });
      expect(up.status, JSON.stringify(up.body)).toBe(201);
      expect(up.body.url).toMatch(/^\/api\/public\/media\/[0-9a-f-]{36}$/);

      // <img> nao manda cookie nem cabecalho de comunidade.
      const get = await request(harness.app).get(up.body.url);
      expect(get.status).toBe(200);
      expect(get.headers['content-type']).toBe('image/png');
      expect(get.headers['cache-control']).toContain('immutable');
      expect(get.headers['x-content-type-options']).toBe('nosniff');
    });

    it('recusa arquivo que nao e do tipo declarado e quem nao pode enviar', async () => {
      const falso = Buffer.from('<script>alert(1)</script>').toString('base64').padEnd(40, 'A');
      expect((await como().post('/api/tenant/media', { contentType: 'image/png', dataBase64: falso })).status).toBe(400);
      expect((await como().post('/api/tenant/media', { contentType: 'image/svg+xml', dataBase64: PNG_1X1 })).status).toBe(400);
      expect((await como(suporteCookie).post('/api/tenant/media', { contentType: 'image/png', dataBase64: PNG_1X1 })).status).toBe(403);
    });

    it('id inexistente ou malformado e 404', async () => {
      expect((await request(harness.app).get('/api/public/media/00000000-0000-4000-8000-000000000000')).status).toBe(404);
      expect((await request(harness.app).get('/api/public/media/nao-e-uuid')).status).toBe(404);
    });

    it('a imagem enviada vale como imagem de premio e de banner; link http continua recusado', async () => {
      const up = await como().post('/api/tenant/media', { contentType: 'image/png', dataBase64: PNG_1X1 });
      const base = {
        title: `Sorteio ${unique('img-')}`,
        regulation: 'Regulamento de teste com texto suficiente para passar na validação do sorteio.',
        ticketPriceCents: 1000,
        totalNumbers: 100,
        drawDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      };
      const ok = await como().post('/api/tenant/draws', {
        ...base,
        prizes: [{ name: 'Moto', imageUrl: up.body.url }],
        customization: { bannerUrl: up.body.url, accentColor: '#16a34a', showCountdown: true },
      });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      expect(ok.body.customization.bannerUrl).toBe(up.body.url);
      expect(ok.body.customization.showCountdown).toBe(true);

      const ruim = await como().post('/api/tenant/draws', { ...base, prizes: [{ name: 'Moto', imageUrl: 'http://x.test/a.png' }] });
      expect(ruim.status).toBe(400);
    });
  });

  describe('limite por pedido e compradores', () => {
    let drawId: string;
    let drawSlug: string;

    beforeAll(async () => {
      const criado = await como().post('/api/tenant/draws', {
        title: `Sorteio ${unique('lim-')}`,
        regulation: 'Regulamento de teste com texto suficiente para passar na validação do sorteio.',
        prizes: [{ name: 'Moto' }],
        ticketPriceCents: 1000,
        totalNumbers: 100,
        drawDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        customization: { minPerOrder: 2, maxPerOrder: 3 },
      });
      expect(criado.status, JSON.stringify(criado.body)).toBe(201);
      drawId = criado.body.id;
      drawSlug = criado.body.slug;
      await harness.owner.query("UPDATE draws SET status = 'ATIVA' WHERE id = $1", [drawId]);
    });

    const reservar = (numbers: number[]) =>
      request(harness.app)
        .post(`/api/public/draws/${drawId}/reservations`)
        .set('x-tenant-slug', slug)
        .send({ numbers });

    it('aplica minimo e maximo no servidor', async () => {
      expect((await reservar([1])).status).toBe(400);
      expect((await reservar([1, 2, 3, 4])).status).toBe(400);
      expect((await reservar([5, 6])).status).toBe(201);
    });

    it('minimo maior que o maximo e recusado na criacao', async () => {
      const r = await como().post('/api/tenant/draws', {
        title: 'Sorteio com limites trocados',
        regulation: 'Regulamento de teste com texto suficiente para passar na validação do sorteio.',
        prizes: [{ name: 'Moto' }],
        ticketPriceCents: 1000,
        totalNumbers: 100,
        drawDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        customization: { minPerOrder: 5, maxPerOrder: 2 },
      });
      expect(r.status).toBe(400);
    });

    async function pedidoPago(nome: string, quantidade: number) {
      const { rows: b } = await harness.owner.query<{ id: string }>(
        `INSERT INTO buyers (tenant_id, name, phone, email) VALUES ($1, $2, '+55 11 91234-5678', 'segredo@x.test') RETURNING id`,
        [tenantId, nome],
      );
      await harness.owner.query(
        `INSERT INTO orders (tenant_id, draw_id, buyer_id, status, unit_price_cents, quantity, total_cents, accepted_terms_at, paid_at)
         VALUES ($1, $2, $3, 'PAGO', 1000, $4, $5, now(), now())`,
        [tenantId, drawId, b[0]!.id, quantidade, quantidade * 1000],
      );
    }

    it('lista publica de compradores: vazia por padrao, mascarada quando o organizador permite', async () => {
      await pedidoPago('Maria Souza Lima', 3);
      const fechada = await publico(`/api/public/draws/${drawSlug}/buyers`);
      expect(fechada.body.buyers).toEqual([]);

      await harness.owner.query(
        `UPDATE draws SET customization = customization || '{"showBuyers": true}'::jsonb WHERE id = $1`,
        [drawId],
      );
      const aberta = await publico(`/api/public/draws/${drawSlug}/buyers`);
      expect(aberta.body.buyers[0].name).toBe('Maria L.');
      expect(aberta.body.buyers[0].quantity).toBe(3);
      // Nada alem de nome mascarado, quantidade e data.
      expect(Object.keys(aberta.body.buyers[0]).sort()).toEqual(['name', 'paidAt', 'quantity']);
      expect(JSON.stringify(aberta.body)).not.toContain('segredo@x.test');
    });

    it('painel: busca por nome/telefone, resumo e isolamento entre comunidades', async () => {
      await pedidoPago('Joao Prado', 1);
      const todos = await como().get('/api/tenant/buyers');
      expect(todos.status, JSON.stringify(todos.body)).toBe(200);
      const maria = todos.body.buyers.find((b: { name: string }) => b.name === 'Maria Souza Lima');
      expect(maria.numbers).toBe(3);
      expect(maria.totalPaidCents).toBe(3000);
      expect(maria.draws[0].slug).toBe(drawSlug);

      const busca = await como().get('/api/tenant/buyers?search=prado');
      expect(busca.body.buyers.map((b: { name: string }) => b.name)).toEqual(['Joao Prado']);

      const outra = await como(cookieB, slugB).get('/api/tenant/buyers');
      expect(outra.body.buyers).toEqual([]);

      // Contato do comprador e dado pessoal: so com buyer:read:full.
      expect((await como(suporteCookie).get('/api/tenant/buyers')).status).toBe(403);
    });
  });

  describe('Financeiro: observacao', () => {
    it('o banco recusa a anotacao sem acesso de plataforma', async () => {
      const app = createPool({ connectionString: TEST_APP_URL, applicationName: 'test-recon-review', max: 1 });
      try {
        await expect(
          app.query(
            `SELECT app.platform_review_reconciliation('00000000-0000-4000-8000-000000000000', 'EM_ANALISE', 'x', NULL)`,
          ),
        ).rejects.toThrow(/plataforma/);
      } finally {
        await app.end();
      }
    });
  });
});
