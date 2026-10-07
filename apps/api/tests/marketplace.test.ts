import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createPool, type DbPool } from '@clubedarifa/db';
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
 * Marketplace universal: lista publica entre comunidades SEM abrir mao do isolamento.
 * Em todos os testes a API roda com TENANT_HEADER_ENABLED=false (como em producao).
 */
describe.skipIf(!hasTestDatabase)(`marketplace universal ${hasTestDatabase ? '' : skipReason}`, () => {
  let h: Harness;
  let appPool: DbPool;

  interface Comunidade {
    slug: string;
    tenantId: string;
    nome: string;
    cookie: string;
    userId: string;
  }
  let a: Comunidade;
  let b: Comunidade;
  let suspensa: Comunidade;
  const sorteios: Record<string, { id: string; slug: string; title: string }> = {};

  async function novaComunidade(prefixo: string, nome: string): Promise<Comunidade> {
    const slug = unique(prefixo);
    const tenantId = await seedTenantWithSlug(h.owner, slug, nome);
    const dono = await seedAccount(h.owner);
    await grantMembership(h.owner, { tenantId, userId: dono.userId, role: 'OWNER' });
    const secret = await seedConfirmedTotp(h.owner, dono.userId);
    const cookie = (await verifyMfa(h, (await loginAs(h, dono)).cookie, await currentCode(secret))).cookie;
    return { slug, tenantId, nome, cookie, userId: dono.userId };
  }

  async function criarSorteio(c: Comunidade, chave: string, titulo: string, status: string): Promise<void> {
    const res = await request(h.app)
      .post('/api/tenant/draws')
      .set('Cookie', c.cookie)
      .set('x-tenant-slug', c.slug)
      .send({
        title: titulo,
        regulation: 'Regulamento de teste com texto suficiente para passar na validação do sorteio.',
        prizes: [{ name: `Prêmio ${titulo}` }],
        ticketPriceCents: 1500,
        totalNumbers: 100,
        drawDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    if (status !== 'RASCUNHO') await h.owner.query('UPDATE draws SET status = $2::draw_status WHERE id = $1', [res.body.id, status]);
    sorteios[chave] = { id: res.body.id, slug: res.body.slug, title: titulo };
  }

  beforeAll(async () => {
    h = await createHarness({ tenantHeaderEnabled: false });
    appPool = createPool({ connectionString: TEST_APP_URL, applicationName: 'test-marketplace-app', max: 2 });
    await cleanup(h.owner);

    a = await novaComunidade('mkt-a-', 'Rifas do Azul');
    b = await novaComunidade('mkt-b-', 'Sorteios do Verde');
    suspensa = await novaComunidade('mkt-s-', 'Comunidade Suspensa');

    await criarSorteio(a, 'a1', 'Moto Azul', 'ATIVA');
    await criarSorteio(a, 'a2', 'Casa Azul', 'ATIVA');
    await criarSorteio(a, 'rascunhoA', 'Rascunho Azul', 'RASCUNHO');
    await criarSorteio(a, 'revisaoA', 'Em Revisao Azul', 'REVISÃO COMPLIANCE');
    await criarSorteio(b, 'b1', 'Carro Verde', 'ATIVA');
    await criarSorteio(b, 'b2', 'Viagem Verde', 'RESULTADO PUBLICADO');
    await criarSorteio(suspensa, 's1', 'Rifa da Suspensa', 'ATIVA');
    await h.owner.query("UPDATE tenants SET status = 'SUSPENDED' WHERE id = $1", [suspensa.tenantId]).catch(async () => {
      await h.owner.query("UPDATE tenants SET status = 'ARCHIVED' WHERE id = $1", [suspensa.tenantId]);
    });
  }, 240_000);

  afterAll(async () => {
    await appPool?.end();
    await h?.close();
  });

  const listar = (query = '') => request(h.app).get(`/api/public/marketplace/draws${query}`);

  it('lista rifas de VARIAS comunidades, sem sessao e sem cabecalho de comunidade', async () => {
    const res = await listar('?limit=48');
    expect(res.status).toBe(200);
    const titulos = (res.body.draws as { title: string }[]).map((d) => d.title);
    expect(titulos).toEqual(expect.arrayContaining(['Moto Azul', 'Casa Azul', 'Carro Verde', 'Viagem Verde']));
    const slugs = new Set((res.body.draws as { tenantSlug: string }[]).map((d) => d.tenantSlug));
    expect(slugs.has(a.slug) && slugs.has(b.slug)).toBe(true);
    // Cada item diz de quem e.
    const moto = (res.body.draws as { title: string; tenantName: string }[]).find((d) => d.title === 'Moto Azul')!;
    expect(moto.tenantName).toBe('Rifas do Azul');
  });

  it('so entra o que e publico: rascunho, revisao e comunidade suspensa ficam de fora', async () => {
    const titulos = ((await listar('?limit=48')).body.draws as { title: string }[]).map((d) => d.title);
    expect(titulos).not.toContain('Rascunho Azul');
    expect(titulos).not.toContain('Em Revisao Azul');
    expect(titulos).not.toContain('Rifa da Suspensa');
  });

  it('nenhum dado de comprador, pedido ou pagamento aparece (so o resumo publico + a comunidade)', async () => {
    await h.owner.query(
      `INSERT INTO buyers (tenant_id, name, phone, email) VALUES ($1, 'Fulano Vazador', '+55 11 90000-0000', 'vazamento@example.com')`,
      [a.tenantId],
    );
    const corpo = JSON.stringify((await listar('?limit=48')).body);
    expect(corpo).not.toContain('vazamento@example.com');
    expect(corpo).not.toContain('Fulano');
    expect(corpo).not.toContain('90000-0000');
    expect(corpo).not.toMatch(/token|password|secret|email|phone/i);
  });

  it('busca por titulo, por premio e por nome do criador; curinga do LIKE e literal', async () => {
    const t = async (q: string) => ((await listar(`?search=${encodeURIComponent(q)}&limit=48`)).body.draws as { title: string }[]).map((d) => d.title);
    expect(await t('moto')).toEqual(['Moto Azul']);
    expect(await t('Prêmio Carro')).toEqual(['Carro Verde']);
    expect(new Set(await t('Sorteios do Verde'))).toEqual(new Set(['Carro Verde', 'Viagem Verde']));
    expect(await t('%')).toEqual([]);
    expect(await t('_oto')).toEqual([]);
  });

  it('paginacao real por cursor: sem repetir nem pular rifa', async () => {
    const vistos: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i += 1) {
      const res = await listar(`?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.status).toBe(200);
      vistos.push(...(res.body.draws as { id: string }[]).map((d) => d.id));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(vistos).size).toBe(vistos.length);
    for (const chave of ['a1', 'a2', 'b1', 'b2']) expect(vistos).toContain(sorteios[chave]!.id);
    // Vendendo agora (ATIVA) vem antes do que ja encerrou.
    const ordem = (await listar('?limit=48')).body.draws as { status: string }[];
    const primeiroNaoAtiva = ordem.findIndex((d) => d.status !== 'ATIVA');
    expect(ordem.slice(primeiroNaoAtiva).every((d) => d.status !== 'ATIVA')).toBe(true);
  });

  it('cursor adulterado e recusado', async () => {
    expect((await listar('?cursor=lixo')).status).toBe(400);
  });

  it('perfil do criador: marca e SO as rifas dele; criador suspenso ou inexistente = 404', async () => {
    const res = await request(h.app).get(`/api/public/marketplace/creators/${a.slug}`);
    expect(res.status).toBe(200);
    expect(res.body.creator.slug).toBe(a.slug);
    const titulos = (res.body.draws as { title: string }[]).map((d) => d.title).sort();
    expect(titulos).toEqual(['Casa Azul', 'Moto Azul']);

    expect((await request(h.app).get(`/api/public/marketplace/creators/${suspensa.slug}`)).status).toBe(404);
    expect((await request(h.app).get('/api/public/marketplace/creators/nao-existe-xyz')).status).toBe(404);
  });

  it('lista de criadores: so ativos com rifa publica', async () => {
    const res = await request(h.app).get('/api/public/marketplace/creators?limit=48');
    expect(res.status).toBe(200);
    const slugs = (res.body.creators as { slug: string }[]).map((c) => c.slug);
    expect(slugs).toEqual(expect.arrayContaining([a.slug, b.slug]));
    expect(slugs).not.toContain(suspensa.slug);
  });

  describe('jornada de compra pelo caminho (comunidade no path)', () => {
    const base = (c: Comunidade) => `/api/public/marketplace/t/${c.slug}`;

    it('detalhe, grade e reserva funcionam na comunidade do caminho', async () => {
      const d = sorteios['b1']!;
      const detalhe = await request(h.app).get(`${base(b)}/draws/${d.slug}`);
      expect(detalhe.status).toBe(200);
      expect(detalhe.body.title).toBe('Carro Verde');

      const grade = await request(h.app).get(`${base(b)}/draws/${d.id}/numbers`);
      expect(grade.status).toBe(200);

      const reserva = await request(h.app).post(`${base(b)}/draws/${d.id}/reservations`).send({ numbers: [3, 4] });
      expect(reserva.status, JSON.stringify(reserva.body)).toBe(201);
    });

    it('NAO atravessa comunidade: rifa de B pelo caminho de A = 404; reserva de B nao vira pedido em A', async () => {
      const d = sorteios['b1']!;
      expect((await request(h.app).get(`${base(a)}/draws/${d.slug}`)).status).toBe(404);
      expect((await request(h.app).get(`${base(a)}/draws/${d.id}/numbers`)).status).toBeGreaterThanOrEqual(404);
      expect((await request(h.app).post(`${base(a)}/draws/${d.id}/reservations`).send({ numbers: [9] })).status).toBe(404);

      const reserva = await request(h.app).post(`${base(b)}/draws/${d.id}/reservations`).send({ numbers: [20] });
      expect(reserva.status).toBe(201);
      const pedidoEmA = await request(h.app)
        .post(`${base(a)}/orders`)
        .send({
          reservationId: reserva.body.reservationId,
          acceptedTerms: true,
          buyer: { name: 'Pessoa Teste', phone: '+55 11 91234-5678' },
        });
      expect(pedidoEmA.status).toBeGreaterThanOrEqual(400);
      expect(pedidoEmA.status).toBeLessThan(500);
    });

    it('comunidade suspensa ou inexistente no caminho = 404; slug malformado = 404', async () => {
      expect((await request(h.app).get(`${base(suspensa)}/draws/${sorteios['s1']!.slug}`)).status).toBe(404);
      expect((await request(h.app).get('/api/public/marketplace/t/nao-existe-xyz/draws/x')).status).toBe(404);
      expect((await request(h.app).get('/api/public/marketplace/t/..%2Fadmin/draws/x')).status).toBeGreaterThanOrEqual(404);
    });

    it('o cabecalho x-tenant-slug NAO escolhe comunidade em rota publica (nem na do caminho, nem na da vitrine)', async () => {
      const d = sorteios['a1']!;
      // Caminho manda: o cabecalho de B e ignorado.
      const res = await request(h.app).get(`${base(a)}/draws/${d.slug}`).set('x-tenant-slug', b.slug);
      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Moto Azul');
      // Rota publica por dominio: sem dominio conhecido, cabecalho nao resolve nada.
      const publica = await request(h.app).get('/api/public/tenant').set('x-tenant-slug', a.slug);
      expect(publica.status).toBe(404);
    });
  });

  describe('selecao EXPLICITA de comunidade em rota privada (Organizer central)', () => {
    it('quem tem vinculo escolhe pela comunidade; sem vinculo = 404; slug nao concede acesso', async () => {
      // Uma conta global com vinculo nas duas comunidades.
      const conta = await seedAccount(h.owner);
      await grantMembership(h.owner, { tenantId: a.tenantId, userId: conta.userId, role: 'OWNER' });
      await grantMembership(h.owner, { tenantId: b.tenantId, userId: conta.userId, role: 'MARKETING' });
      const secret = await seedConfirmedTotp(h.owner, conta.userId);
      const cookie = (await verifyMfa(h, (await loginAs(h, conta)).cookie, await currentCode(secret))).cookie;

      const emA = await request(h.app).get('/api/tenant/context').set('Cookie', cookie).set('x-tenant-slug', a.slug);
      const emB = await request(h.app).get('/api/tenant/context').set('Cookie', cookie).set('x-tenant-slug', b.slug);
      expect(emA.status).toBe(200);
      expect(emA.body.slug).toBe(a.slug);
      expect(emA.body.roles).toEqual(['OWNER']);
      expect(emB.status).toBe(200);
      expect(emB.body.slug).toBe(b.slug);
      expect(emB.body.roles).toEqual(['MARKETING']);

      // Sem vinculo na comunidade da outra pessoa: 404, igual a inexistente.
      const alheia = await request(h.app).get('/api/tenant/context').set('Cookie', cookie).set('x-tenant-slug', suspensa.slug);
      const inexistente = await request(h.app).get('/api/tenant/context').set('Cookie', cookie).set('x-tenant-slug', 'nao-existe-xyz');
      expect(alheia.status).toBe(404);
      expect(inexistente.status).toBe(404);
    });

    it('um dono de A nao opera em B por trocar o cabecalho', async () => {
      const res = await request(h.app).get('/api/tenant/draws').set('Cookie', a.cookie).set('x-tenant-slug', b.slug);
      expect(res.status).toBe(404);
      const propria = await request(h.app).get('/api/tenant/draws').set('Cookie', a.cookie).set('x-tenant-slug', a.slug);
      expect(propria.status).toBe(200);
      expect((propria.body.draws as { title: string }[]).map((d) => d.title)).not.toContain('Carro Verde');
    });

    it('sem sessao o cabecalho continua sendo ignorado', async () => {
      const res = await request(h.app).get('/api/tenant/context').set('x-tenant-slug', a.slug);
      expect(res.status).toBe(401);
    });
  });

  it('RLS intacta: o papel da aplicacao NAO le rifas fora do contexto, mas a funcao devolve a projecao publica', async () => {
    const direto = await appPool.query('SELECT count(*)::int AS n FROM draws');
    expect(direto.rows[0].n).toBe(0);
    const viaFuncao = await appPool.query('SELECT count(*)::int AS n FROM app.marketplace_page(NULL, NULL, NULL, NULL, NULL, 48)');
    expect(viaFuncao.rows[0].n).toBeGreaterThan(0);
    // A projecao nao tem colunas de comprador, pedido ou pagamento.
    const colunas = await appPool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'marketplace_page' AND table_schema = 'app'",
    );
    void colunas;
    const amostra = await appPool.query('SELECT * FROM app.marketplace_page(NULL, NULL, NULL, NULL, NULL, 1)');
    expect(Object.keys(amostra.rows[0]).sort()).toEqual(['band', 'cursor_t', 'draw_id', 'logo_url', 'tenant_id', 'tenant_name', 'tenant_slug']);
  });
});
