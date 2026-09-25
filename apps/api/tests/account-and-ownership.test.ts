import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  cleanup,
  createHarness,
  currentCode,
  grantPlatformRole,
  hasTestDatabase,
  loginAs,
  seedAccount,
  seedConfirmedTotp,
  seedTenantWithSlug,
  sessionCookieFrom,
  skipReason,
  unique,
  verifyMfa,
  type Harness,
} from './helpers/apiHarness.js';

/**
 * Conta do participante, propriedade do pedido e dono da comunidade.
 *
 * O fio condutor destes testes e uma pergunta so: QUEM decide de quem e o
 * dado. A resposta tem de ser sempre a sessao — nunca um e-mail digitado,
 * nunca um id na consulta, nunca um corpo de requisicao.
 */
describe.skipIf(!hasTestDatabase)(`conta e propriedade${skipReason}`, () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await cleanup(h.owner);
    await h.pool.end();
  });

  // -------------------------------------------------------------- cadastro

  describe('cadastro', () => {
    it('cria a conta e devolve o perfil, sem token no corpo', async () => {
      const email = `${unique('novo-')}@example.com`;
      const res = await request(h.app).post('/api/auth/register').send({
        displayName: 'Participante Novo',
        email,
        password: 'Senha-Muito-Boa-2026!',
        passwordConfirmation: 'Senha-Muito-Boa-2026!',
      });

      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe(email);
      expect(res.body.user.displayName).toBe('Participante Novo');
      expect(JSON.stringify(res.body)).not.toMatch(/senha|password|token/i);
    });

    it('normaliza o e-mail: maiusculas e espacos nao criam segunda conta', async () => {
      const base = `${unique('caixa-')}@example.com`;
      const primeiro = await request(h.app).post('/api/auth/register').send({
        displayName: 'Primeira',
        email: `  ${base.toUpperCase()}  `,
        password: 'Senha-Muito-Boa-2026!',
        passwordConfirmation: 'Senha-Muito-Boa-2026!',
      });
      expect(primeiro.status).toBe(201);
      expect(primeiro.body.user.email).toBe(base);

      const segundo = await request(h.app).post('/api/auth/register').send({
        displayName: 'Segunda',
        email: base,
        password: 'Senha-Muito-Boa-2026!',
        passwordConfirmation: 'Senha-Muito-Boa-2026!',
      });
      expect(segundo.status).toBe(409);
    });

    it('recusa e-mail ja cadastrado', async () => {
      const conta = await seedAccount(h.owner);
      const res = await request(h.app).post('/api/auth/register').send({
        displayName: 'Impostora',
        email: conta.email,
        password: 'Senha-Muito-Boa-2026!',
        passwordConfirmation: 'Senha-Muito-Boa-2026!',
      });
      expect(res.status).toBe(409);
    });

    it('recusa confirmacao divergente e payload invalido', async () => {
      const divergente = await request(h.app).post('/api/auth/register').send({
        displayName: 'Alguem',
        email: `${unique('div-')}@example.com`,
        password: 'Senha-Muito-Boa-2026!',
        passwordConfirmation: 'Outra-Senha-Diferente-2026!',
      });
      expect(divergente.status).toBe(400);

      const vazio = await request(h.app).post('/api/auth/register').send({});
      expect(vazio.status).toBe(400);
    });

    /**
     * O teste que importa de verdade: a senha nao pode estar recuperavel em
     * lugar nenhum. Le a linha crua com o papel dono, sem passar pela API.
     */
    it('nunca armazena a senha em texto claro', async () => {
      const email = `${unique('hash-')}@example.com`;
      const senha = 'Senha-Muito-Boa-2026!';
      await request(h.app)
        .post('/api/auth/register')
        .send({ displayName: 'Hash', email, password: senha, passwordConfirmation: senha });

      const { rows } = await h.owner.query<{ password_hash: string }>(
        `SELECT c.password_hash FROM user_credentials c
           JOIN users u ON u.id = c.user_id WHERE u.email = $1`,
        [email],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.password_hash).toMatch(/^scrypt\$/);
      expect(rows[0]!.password_hash).not.toContain(senha);
    });

    it('a conta nasce sem vinculo de comunidade e sem papel de plataforma', async () => {
      const email = `${unique('semvinculo-')}@example.com`;
      const senha = 'Senha-Muito-Boa-2026!';
      const criado = await request(h.app)
        .post('/api/auth/register')
        .send({ displayName: 'Sem Vinculo', email, password: senha, passwordConfirmation: senha });

      const userId = criado.body.user.id as string;
      const vinculos = await h.owner.query('SELECT 1 FROM memberships WHERE user_id = $1', [userId]);
      const plataforma = await h.owner.query('SELECT 1 FROM platform_admins WHERE user_id = $1', [
        userId,
      ]);
      expect(vinculos.rowCount ?? 0).toBe(0);
      expect(plataforma.rowCount ?? 0).toBe(0);
    });

    it('a conta cadastrada consegue entrar pelo login existente', async () => {
      const email = `${unique('entra-')}@example.com`;
      const senha = 'Senha-Muito-Boa-2026!';
      await request(h.app)
        .post('/api/auth/register')
        .send({ displayName: 'Entra', email, password: senha, passwordConfirmation: senha });

      const login = await request(h.app).post('/api/auth/login').send({ email, password: senha });
      expect(login.status).toBe(200);
      // Participante sem papel administrativo nao cai em RN12.
      expect(login.body.status).toBe('authenticated');

      const cookie = sessionCookieFrom(login, h.config.SESSION_COOKIE_NAME);
      const sessao = await request(h.app).get('/api/auth/session').set('Cookie', cookie);
      expect(sessao.status).toBe(200);
      expect(sessao.body.user.email).toBe(email);
    });
  });

  // ---------------------------------------------------------------- conta

  describe('pedidos da conta', () => {
    it('sem sessao, a rota da conta e negada', async () => {
      const res = await request(h.app).get('/api/account/orders');
      expect(res.status).toBe(401);
    });

    it('mostra o proprio pedido e ignora o de outra pessoa', async () => {
      const a = await seedAccount(h.owner);
      const b = await seedAccount(h.owner);
      const tenantId = await seedTenantWithSlug(h.owner, unique('com-'));

      const pedidoA = await criarPedido(h, { tenantId, userId: a.userId, numero: 1 });
      const pedidoB = await criarPedido(h, { tenantId, userId: b.userId, numero: 2 });

      const { cookie } = await loginAs(h, a);
      const res = await request(h.app).get('/api/account/orders').set('Cookie', cookie);

      expect(res.status).toBe(200);
      const ids = res.body.orders.map((o: { orderId: string }) => o.orderId);
      expect(ids).toContain(pedidoA);
      expect(ids).not.toContain(pedidoB);
    });

    it('pedido guest nao entra na conta por coincidencia de e-mail', async () => {
      const conta = await seedAccount(h.owner);
      const tenantId = await seedTenantWithSlug(h.owner, unique('guest-'));

      // Guest com o MESMO e-mail da conta: user_id fica nulo.
      const guest = await criarPedido(h, {
        tenantId,
        userId: null,
        numero: 3,
        buyerEmail: conta.email,
      });

      const { cookie } = await loginAs(h, conta);
      const res = await request(h.app).get('/api/account/orders').set('Cookie', cookie);
      const ids = res.body.orders.map((o: { orderId: string }) => o.orderId);
      expect(ids).not.toContain(guest);
    });

    it('reune pedidos de comunidades diferentes na mesma conta', async () => {
      const conta = await seedAccount(h.owner);
      const comunidadeA = await seedTenantWithSlug(h.owner, unique('multi-a-'));
      const comunidadeB = await seedTenantWithSlug(h.owner, unique('multi-b-'));

      const pa = await criarPedido(h, { tenantId: comunidadeA, userId: conta.userId, numero: 4 });
      const pb = await criarPedido(h, { tenantId: comunidadeB, userId: conta.userId, numero: 5 });

      const { cookie } = await loginAs(h, conta);
      const res = await request(h.app).get('/api/account/orders').set('Cookie', cookie);
      const ids = res.body.orders.map((o: { orderId: string }) => o.orderId);
      expect(ids).toContain(pa);
      expect(ids).toContain(pb);
      // A conta atravessa comunidades sem precisar de uma comunidade corrente.
      const tenants = res.body.orders.map((o: { tenantSlug: string }) => o.tenantSlug);
      expect(new Set(tenants).size).toBeGreaterThanOrEqual(2);
    });

    it('nao expoe dado pessoal nem identificador interno na listagem', async () => {
      const conta = await seedAccount(h.owner);
      const tenantId = await seedTenantWithSlug(h.owner, unique('priv-'));
      await criarPedido(h, { tenantId, userId: conta.userId, numero: 6 });

      const { cookie } = await loginAs(h, conta);
      const res = await request(h.app).get('/api/account/orders').set('Cookie', cookie);
      const corpo = JSON.stringify(res.body);

      expect(corpo).not.toContain(conta.userId);
      expect(corpo).not.toMatch(/buyerId|buyer_id|tenantId|reservationId|password|token/);
    });

    it('pagina por cursor sem repetir nem pular', async () => {
      const conta = await seedAccount(h.owner);
      const tenantId = await seedTenantWithSlug(h.owner, unique('pag-'));
      for (let n = 10; n < 15; n += 1) {
        await criarPedido(h, { tenantId, userId: conta.userId, numero: n });
      }

      const { cookie } = await loginAs(h, conta);
      const p1 = await request(h.app).get('/api/account/orders?limit=2').set('Cookie', cookie);
      expect(p1.body.orders).toHaveLength(2);
      expect(p1.body.nextCursor).not.toBeNull();

      const p2 = await request(h.app)
        .get(`/api/account/orders?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`)
        .set('Cookie', cookie);
      expect(p2.body.orders).toHaveLength(2);

      const idsP1 = p1.body.orders.map((o: { orderId: string }) => o.orderId);
      const idsP2 = p2.body.orders.map((o: { orderId: string }) => o.orderId);
      expect(idsP1.some((id: string) => idsP2.includes(id))).toBe(false);
    });

    it('recusa cursor malformado em vez de ignora-lo', async () => {
      const conta = await seedAccount(h.owner);
      const { cookie } = await loginAs(h, conta);
      const res = await request(h.app)
        .get('/api/account/orders?cursor=nao-e-cursor')
        .set('Cookie', cookie);
      expect(res.status).toBe(400);
    });
  });

  // ------------------------------------------------- dono da comunidade

  describe('criacao de comunidade com dono', () => {
    async function superAdmin(): Promise<{ cookie: string; conta: Awaited<ReturnType<typeof seedAccount>> }> {
      const conta = await seedAccount(h.owner);
      await grantPlatformRole(h.owner, { userId: conta.userId, role: 'PLATFORM_OPERATIONS' });
      const segredo = await seedConfirmedTotp(h.owner, conta.userId);
      const { cookie } = await loginAs(h, conta);
      // Perfil de plataforma cai em RN12: a sessao so serve depois de elevada,
      // e a elevacao ROTACIONA o token — vale o cookie devolvido, nao o antigo.
      const elevado = await verifyMfa(h, cookie, await currentCode(segredo));
      if (elevado.status !== 200) {
        throw new Error(`elevacao de MFA falhou: ${elevado.status} ${JSON.stringify(elevado.body)}`);
      }
      return { cookie: elevado.cookie, conta };
    }

    it('cria a comunidade e o vinculo de dono na mesma operacao', async () => {
      const { cookie } = await superAdmin();
      const dono = await seedAccount(h.owner);
      const slug = unique('dono-');

      const res = await request(h.app)
        .post('/api/platform/tenants')
        .set('Cookie', cookie)
        .send({ slug, name: 'Comunidade Com Dono', ownerEmail: dono.email });

      expect(res.status).toBe(201);
      expect(res.body.owner.userId).toBe(dono.userId);

      const vinculo = await h.owner.query<{ role: string }>(
        `SELECT role::text AS role FROM memberships
          WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [res.body.id, dono.userId],
      );
      expect(vinculo.rows.map((r) => r.role)).toEqual(['OWNER']);
    });

    it('registra a concessao de dono na trilha, separada da criacao', async () => {
      const { cookie } = await superAdmin();
      const dono = await seedAccount(h.owner);
      const res = await request(h.app)
        .post('/api/platform/tenants')
        .set('Cookie', cookie)
        .send({ slug: unique('trilha-'), name: 'Com Trilha', ownerEmail: dono.email });

      const { rows } = await h.owner.query<{ action: string }>(
        `SELECT action FROM audit_events
          WHERE target_id IN ($1, $2) ORDER BY occurred_at`,
        [res.body.id, dono.userId],
      );
      const acoes = rows.map((r) => r.action);
      expect(acoes).toContain('tenant.created');
      expect(acoes).toContain('membership.owner_provisioned');
    });

    /**
     * O caso que o "tudo ou nada" existe para cobrir: e-mail sem conta. A
     * comunidade NAO pode sobrar criada e sem dono.
     */
    it('desfaz tudo quando o e-mail do dono nao corresponde a conta nenhuma', async () => {
      const { cookie } = await superAdmin();
      const slug = unique('rollback-');

      const res = await request(h.app)
        .post('/api/platform/tenants')
        .set('Cookie', cookie)
        .send({ slug, name: 'Nao Deve Existir', ownerEmail: 'ninguem@example.com' });

      expect(res.status).toBe(400);
      const orfa = await h.owner.query('SELECT 1 FROM tenants WHERE slug = $1', [slug]);
      expect(orfa.rowCount ?? 0).toBe(0);
    });

    it('recusa criacao sem e-mail de dono', async () => {
      const { cookie } = await superAdmin();
      const res = await request(h.app)
        .post('/api/platform/tenants')
        .set('Cookie', cookie)
        .send({ slug: unique('semdono-'), name: 'Sem Dono' });
      expect(res.status).toBe(400);
    });

    it('o dono provisionado alcanca a propria comunidade e nenhuma outra', async () => {
      const { cookie: admin } = await superAdmin();
      const donoA = await seedAccount(h.owner);
      const criada = await request(h.app)
        .post('/api/platform/tenants')
        .set('Cookie', admin)
        .send({ slug: unique('acesso-'), name: 'Comunidade A', ownerEmail: donoA.email });

      const outra = await seedTenantWithSlug(h.owner, unique('alheia-'));
      const { rows: outraSlug } = await h.owner.query<{ slug: string }>(
        'SELECT slug FROM tenants WHERE id = $1',
        [outra],
      );

      const segredo = await seedConfirmedTotp(h.owner, donoA.userId);
      const { cookie: bruto } = await loginAs(h, donoA);
      const { cookie: cookieDono } = await verifyMfa(h, bruto, await currentCode(segredo));

      const propria = await request(h.app)
        .get('/api/tenant/context')
        .set('Cookie', cookieDono)
        .set('x-tenant-slug', criada.body.slug);
      expect(propria.status).toBe(200);

      // 404, e nao 403: um 403 confirmaria que a comunidade existe a quem nao
      // tem vinculo com ela. A recusa e indistinguivel de "nao existe", que e
      // o que o `tenantResolver` decide de proposito (DOC-01 §21).
      const alheia = await request(h.app)
        .get('/api/tenant/context')
        .set('Cookie', cookieDono)
        .set('x-tenant-slug', outraSlug[0]!.slug);
      expect(alheia.status).toBe(404);
      expect(JSON.stringify(alheia.body)).not.toContain(outraSlug[0]!.slug);
    });
  });
});

/**
 * Cria um pedido direto no banco com o papel dono.
 *
 * Pelo HTTP seria preciso sorteio ATIVA, reserva no prazo e checkout completo
 * a cada caso — muito caminho para exercitar uma pergunta que e sobre
 * PROPRIEDADE, nao sobre compra. O fluxo de compra tem testes proprios em
 * `draws-reservations`.
 */
async function criarPedido(
  h: Harness,
  input: { tenantId: string; userId: string | null; numero: number; buyerEmail?: string },
): Promise<string> {
  const { rows: sorteio } = await h.owner.query<{ id: string }>(
    `INSERT INTO draws (tenant_id, slug, title, prize_name, unit_price_cents, total_numbers, status)
     VALUES ($1, $2, $3, 'Premio', 1000, 100, 'ATIVA') RETURNING id`,
    [input.tenantId, unique('s-'), `Sorteio ${input.numero}`],
  );
  const { rows: comprador } = await h.owner.query<{ id: string }>(
    `INSERT INTO buyers (tenant_id, name, phone, email) VALUES ($1, 'Comprador', '11999998888', $2)
     RETURNING id`,
    [input.tenantId, input.buyerEmail ?? null],
  );
  const { rows: pedido } = await h.owner.query<{ id: string }>(
    `INSERT INTO orders
       (tenant_id, draw_id, buyer_id, unit_price_cents, quantity, total_cents,
        accepted_terms_at, user_id)
     VALUES ($1, $2, $3, 1000, 1, 1000, now(), $4)
     RETURNING id`,
    [input.tenantId, sorteio[0]!.id, comprador[0]!.id, input.userId],
  );
  await h.owner.query(
    `INSERT INTO order_items (tenant_id, order_id, number, unit_price_cents)
     VALUES ($1, $2, $3, 1000)`,
    [input.tenantId, pedido[0]!.id, input.numero],
  );
  return pedido[0]!.id;
}
