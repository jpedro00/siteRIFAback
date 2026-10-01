import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createPool, type DbPool } from '@clubedarifa/db';
import { createPaymentAccountsRuntime, type PaymentAccountsRuntime } from '@clubedarifa/payment-accounts';
import { FakeMercadoPago } from '@clubedarifa/payment-accounts/testing';
import { PaymentAccountUnavailableError } from '@clubedarifa/psp';
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
  type SeededAccount,
} from './helpers/apiHarness.js';

/**
 * Fase 7 · Etapa 4 · recebimentos por comunidade (FLUXO B: dinheiro do PARTICIPANTE).
 *
 * A API roda com o runtime REAL (OAuth + PKCE, cifragem, resolvedor, renovacao) sobre o
 * Mercado Pago EM MEMORIA (`FakeMercadoPago`, no nivel do `fetch`). O banco e o real, com os
 * papeis `app_user`/`app_worker`. Nenhuma credencial real, nenhuma cobranca real, nenhuma rede.
 */
const WORKER_URL = process.env['TEST_WORKER_DATABASE_URL'] ?? '';
const CREDENTIALS_KEY = Buffer.alloc(32, 7).toString('base64');

describe.skipIf(!hasTestDatabase || WORKER_URL === '')(`Recebimentos por comunidade ${hasTestDatabase ? '' : skipReason}`, () => {
  let harness: Harness;
  let appPool: DbPool;
  let workerPool: DbPool;
  let mp: FakeMercadoPago;
  let runtime: PaymentAccountsRuntime;
  let workerRuntime: PaymentAccountsRuntime;

  interface Comunidade {
    slug: string;
    tenantId: string;
    owner: SeededAccount;
    cookie: string;
  }
  let A: Comunidade;
  let B: Comunidade;

  const configDe = (pool: DbPool) =>
    createPaymentAccountsRuntime(pool, {
      clientId: mp.clientId,
      clientSecret: mp.clientSecret,
      credentialsKey: CREDENTIALS_KEY,
      redirectUri: mp.redirectUri,
      webhookSecret: mp.webhookSecret,
      environment: 'SANDBOX',
      fetchImpl: mp.fetch,
    });

  beforeAll(async () => {
    mp = new FakeMercadoPago();
    appPool = createPool({ connectionString: TEST_APP_URL, applicationName: 'test-pa-runtime', max: 5 });
    workerPool = createPool({ connectionString: WORKER_URL, applicationName: 'test-pa-worker', max: 5 });
    runtime = configDe(appPool);
    workerRuntime = configDe(workerPool);
    harness = await createHarness({ paymentAccounts: runtime });
    await cleanup(harness.owner);
    A = await novaComunidade('pa-a-');
    B = await novaComunidade('pa-b-');
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
    await appPool?.end();
    await workerPool?.end();
  });

  // ---- cenario ------------------------------------------------------------

  async function entrar(account: SeededAccount, comMfa = true): Promise<string> {
    const secret = comMfa ? await seedConfirmedTotp(harness.owner, account.userId) : null;
    const login = await loginAs(harness, account);
    return secret ? (await verifyMfa(harness, login.cookie, await currentCode(secret))).cookie : login.cookie;
  }

  async function novaComunidade(prefixo: string): Promise<Comunidade> {
    const slug = unique(prefixo);
    const tenantId = await seedTenantWithSlug(harness.owner, slug, `Comunidade ${prefixo}`);
    const owner = await seedAccount(harness.owner);
    await grantMembership(harness.owner, { tenantId, userId: owner.userId, role: 'OWNER' });
    return { slug, tenantId, owner, cookie: await entrar(owner) };
  }

  async function membro(c: Comunidade, role: string, comMfa = true) {
    const conta = await seedAccount(harness.owner);
    await grantMembership(harness.owner, { tenantId: c.tenantId, userId: conta.userId, role });
    return { conta, cookie: await entrar(conta, comMfa) };
  }

  const como = (cookie: string, slug: string) => ({
    get: (url: string) => request(harness.app).get(url).set('Cookie', cookie).set('x-tenant-slug', slug),
    post: (url: string, body: object = {}) =>
      request(harness.app).post(url).set('Cookie', cookie).set('x-tenant-slug', slug).send(body),
  });
  const donoDe = (c: Comunidade) => como(c.cookie, c.slug);

  /** Inicia a conexao e devolve o que o provedor recebe na URL. */
  async function iniciar(c: Comunidade, cookie = c.cookie) {
    const res = await como(cookie, c.slug).post('/api/tenant/payment-accounts/connect', { provider: 'MERCADO_PAGO' });
    return res;
  }
  const parametrosDa = (url: string) => {
    const u = new URL(url);
    return { state: u.searchParams.get('state')!, challenge: u.searchParams.get('code_challenge')!, url: u };
  };

  function retorno(cookie: string, query: Record<string, string>) {
    return request(harness.app).get('/api/payment-accounts/oauth/callback').query(query).set('Cookie', cookie);
  }

  /** Fluxo completo: inicia, o vendedor autoriza no MP, o MP devolve o navegador ao callback. */
  async function conectar(c: Comunidade, vendedor: string, opts: { cookie?: string } = {}) {
    if (!mp.sellers.has(vendedor)) mp.addSeller(vendedor);
    const ini = await iniciar(c, opts.cookie ?? c.cookie);
    expect(ini.status, JSON.stringify(ini.body)).toBe(200);
    const p = parametrosDa(ini.body.url);
    const code = mp.authorize(vendedor, p.challenge);
    const res = await retorno(opts.cookie ?? c.cookie, { state: p.state, code });
    return { ini, p, code, res };
  }

  const motivoDe = (res: request.Response) => new URL(res.headers['location'] as string).searchParams.get('motivo');
  const conexaoDe = (res: request.Response) => new URL(res.headers['location'] as string).searchParams.get('conexao');

  async function contas(c: Comunidade) {
    const res = await donoDe(c).get('/api/tenant/payment-accounts');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { enabled: boolean; checkoutAvailable: boolean; accounts: Array<Record<string, unknown>> };
  }

  async function sorteio(c: Comunidade, preco = 1500): Promise<string> {
    const { rows } = await harness.owner.query<{ id: string }>(
      `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers, status)
       VALUES ($1, $2, 'Sorteio', 'Moto', $3, 100, 'ATIVA') RETURNING id`,
      [c.tenantId, unique('s-'), preco],
    );
    return rows[0]!.id;
  }

  // Cada compra usa um sorteio novo: o numero pode se repetir entre sorteios.
  const numeros = () => [1];

  /** Reserva + pedido. Devolve a resposta do pedido (o PIX e gerado ali). */
  async function comprar(c: Comunidade, drawId?: string) {
    const d = drawId ?? (await sorteio(c));
    const reserva = await request(harness.app)
      .post(`/api/public/draws/${d}/reservations`)
      .set('x-tenant-slug', c.slug)
      .send({ numbers: numeros() });
    expect(reserva.status, JSON.stringify(reserva.body)).toBe(201);
    const pedido = await request(harness.app)
      .post('/api/public/orders')
      .set('x-tenant-slug', c.slug)
      .send({
        reservationId: reserva.body.reservationId,
        buyer: { name: 'Maria Souza', phone: '+55 11 91234-5678', email: 'maria@example.com' },
        acceptedTerms: true,
      });
    return pedido;
  }
  async function compraOk(c: Comunidade) {
    const pedido = await comprar(c);
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(201);
    const { rows } = await harness.owner.query<{
      id: string;
      provider_payment_id: string;
      payment_account_id: string;
    }>('SELECT id, provider_payment_id, payment_account_id FROM payments WHERE order_id = $1', [pedido.body.orderId]);
    return { orderId: pedido.body.orderId as string, pedido: pedido.body, pagamento: rows[0]! };
  }

  function avisar(slugNaUrl: string, paymentId: string, opts: { secret?: string; userId?: string; requestId?: string } = {}) {
    const w = mp.signedWebhook(paymentId, opts);
    return request(harness.app)
      .post(`/api/webhooks/mercadopago/${slugNaUrl}`)
      .query(w.query)
      .set(w.headers)
      .send(w.body as object);
  }

  const statusPedido = async (orderId: string) =>
    (await harness.owner.query<{ status: string }>('SELECT status::text AS status FROM orders WHERE id = $1', [orderId])).rows[0]!.status;

  const autorizacaoDe = async (c: Comunidade) =>
    (
      await harness.owner.query<{
        id: string;
        status: string;
        credential_version: number;
        provider_account_id: string;
        access_token_encrypted: Buffer | null;
        refresh_token_encrypted: Buffer | null;
        expires_at: Date | null;
        account_id: string;
        account_status: string;
      }>(
        `SELECT a.id, a.status::text AS status, a.credential_version, a.provider_account_id, a.access_token_encrypted,
                a.refresh_token_encrypted, a.expires_at, t.id AS account_id, t.status::text AS account_status
           FROM tenant_payment_accounts t JOIN payment_provider_authorizations a ON a.id = t.authorization_id
          WHERE t.tenant_id = $1 ORDER BY t.created_at DESC LIMIT 1`,
        [c.tenantId],
      )
    ).rows[0]!;

  const vencerEm = (autorizacaoId: string, intervalo: string) =>
    harness.owner.query(`UPDATE payment_provider_authorizations SET expires_at = now() + $2::interval WHERE id = $1`, [autorizacaoId, intervalo]);

  // -------------------------------------------------------------------------
  describe('iniciar a conexao (permissao, MFA e o que a URL carrega)', () => {
    it('proprietario com MFA: recebe a URL do Mercado Pago com state aleatorio e PKCE S256, sem segredo', async () => {
      const res = await iniciar(A);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(Object.keys(res.body)).toEqual(['url']);
      const { state, challenge, url } = parametrosDa(res.body.url);
      expect(url.origin).toBe('https://auth.mercadopago.com');
      expect(url.searchParams.get('client_id')).toBe(mp.clientId);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('redirect_uri')).toBe(mp.redirectUri);
      expect(url.searchParams.get('scope')).toContain('offline_access');
      // state aleatorio: sem comunidade, usuario ou slug dentro; e o desafio nao e o verifier.
      expect(state.length).toBeGreaterThanOrEqual(32);
      for (const pista of [A.tenantId, A.owner.userId, A.slug]) expect(state).not.toContain(pista);
      expect(challenge).toHaveLength(43);
      // nada de segredo na resposta nem na URL
      expect(res.text).not.toContain(mp.clientSecret);
      expect(url.searchParams.has('client_secret')).toBe(false);
      // so o HASH do state e guardado
      const { rows } = await harness.owner.query(`SELECT 1 FROM payment_account_oauth_states WHERE state_hash = decode($1, 'hex')`, [
        Buffer.from(state).toString('hex'),
      ]);
      expect(rows).toHaveLength(0);
    });

    it('sem sessao: 401; sem papel de gestao (SUPPORT): 403; financeiro so LE e nao conecta nem desconecta', async () => {
      const semSessao = await request(harness.app)
        .post('/api/tenant/payment-accounts/connect')
        .set('x-tenant-slug', A.slug)
        .send({ provider: 'MERCADO_PAGO' });
      expect(semSessao.status).toBe(401);

      const suporte = await membro(A, 'SUPPORT');
      expect((await iniciar(A, suporte.cookie)).status).toBe(403);
      expect((await como(suporte.cookie, A.slug).get('/api/tenant/payment-accounts')).status).toBe(403);

      const financeiro = await membro(A, 'FINANCE');
      expect((await como(financeiro.cookie, A.slug).get('/api/tenant/payment-accounts')).status).toBe(200);
      expect((await iniciar(A, financeiro.cookie)).status).toBe(403);
      const desconectar = await como(financeiro.cookie, A.slug).post(`/api/tenant/payment-accounts/${A.tenantId}/disconnect`);
      expect(desconectar.status).toBe(403);
    });

    it('proprietario SEM segundo fator nao inicia a conexao (MFA obrigatorio)', async () => {
      const dono = await seedAccount(harness.owner);
      const sl = unique('pa-mfa-');
      const t = await seedTenantWithSlug(harness.owner, sl);
      await grantMembership(harness.owner, { tenantId: t, userId: dono.userId, role: 'OWNER' });
      const cookie = await entrar(dono, false);
      const res = await como(cookie, sl).post('/api/tenant/payment-accounts/connect', { provider: 'MERCADO_PAGO' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toMatch(/MFA/);
      const { rows } = await harness.owner.query('SELECT 1 FROM payment_account_oauth_states WHERE tenant_id = $1', [t]);
      expect(rows).toHaveLength(0);
    });

    it('campo de token no corpo e recusado/ignorado: nao existe entrada manual de Access Token', async () => {
      const res = await como(A.cookie, A.slug).post('/api/tenant/payment-accounts/connect', {
        provider: 'MERCADO_PAGO',
        accessToken: 'APP_USR-manual',
      });
      expect(JSON.stringify(res.body)).not.toContain('APP_USR-manual');
      const { rows } = await harness.owner.query(`SELECT 1 FROM payment_provider_authorizations WHERE provider_account_id = 'APP_USR-manual'`);
      expect(rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('retorno do OAuth (state, PKCE, usuario, codigo)', () => {
    it('state inexistente, ausente ou inventado: recusado e nada e criado', async () => {
      const antes = (await harness.owner.query('SELECT 1 FROM tenant_payment_accounts')).rowCount;
      const inventado = await retorno(A.cookie, { state: 'inventado-'.repeat(5), code: 'TG-x' });
      expect(inventado.status).toBe(302);
      expect(conexaoDe(inventado)).toBe('erro');
      expect(motivoDe(inventado)).toBe('invalid_state');
      const semState = await retorno(A.cookie, { code: 'TG-x' });
      expect(motivoDe(semState)).toBe('missing_state');
      expect((await harness.owner.query('SELECT 1 FROM tenant_payment_accounts')).rowCount).toBe(antes);
    });

    it('state VENCIDO: recusado', async () => {
      mp.addSeller('9001');
      const ini = await iniciar(A);
      const p = parametrosDa(ini.body.url);
      await harness.owner.query(
        `UPDATE payment_account_oauth_states SET expires_at = now() - interval '1 minute' WHERE tenant_id = $1 AND used_at IS NULL`,
        [A.tenantId],
      );
      const res = await retorno(A.cookie, { state: p.state, code: mp.authorize('9001', p.challenge) });
      expect(motivoDe(res)).toBe('invalid_state');
    });

    it('state REUSADO: o primeiro retorno conecta, o segundo nao faz nada', async () => {
      const { p, code, res } = await conectar(A, '1001');
      expect(conexaoDe(res)).toBe('ok');
      const de = new URL(res.headers['location'] as string);
      expect(de.origin + de.pathname).toBe('https://organizer.test/recebimentos');
      expect(res.headers['cache-control']).toContain('no-store');
      // nem o codigo nem o state voltam para a pagina
      expect(res.headers['location']).not.toContain(code);
      expect(res.headers['location']).not.toContain(p.state);

      const de2 = await retorno(A.cookie, { state: p.state, code: mp.authorize('1001', p.challenge) });
      expect(conexaoDe(de2)).toBe('erro');
      expect(motivoDe(de2)).toBe('invalid_state');
      expect((await contas(A)).accounts).toHaveLength(1);
    });

    it('PKCE invalido (codigo emitido para OUTRO desafio): o Mercado Pago recusa a troca e nada e criado', async () => {
      mp.addSeller('9002');
      const ini = await iniciar(B);
      const p = parametrosDa(ini.body.url);
      const codigoDeOutroDesafio = mp.authorize('9002', 'desafio-de-outro-fluxo-que-nao-e-o-nosso-0000000');
      const res = await retorno(B.cookie, { state: p.state, code: codigoDeOutroDesafio });
      expect(conexaoDe(res)).toBe('erro');
      expect(motivoDe(res)).toBe('exchange_failed');
      expect((await harness.owner.query('SELECT 1 FROM tenant_payment_accounts WHERE tenant_id = $1', [B.tenantId])).rowCount).toBe(0);
      expect((await harness.owner.query(`SELECT 1 FROM payment_provider_authorizations WHERE provider_account_id = '9002'`)).rowCount).toBe(0);
    });

    it('codigo de autorizacao REUSADO (num novo state): recusado', async () => {
      mp.addSeller('9003');
      const ini1 = await iniciar(B);
      const p1 = parametrosDa(ini1.body.url);
      const code = mp.authorize('9003', p1.challenge);
      expect(conexaoDe(await retorno(B.cookie, { state: p1.state, code }))).toBe('ok');

      const ini2 = await iniciar(B);
      const p2 = parametrosDa(ini2.body.url);
      const res = await retorno(B.cookie, { state: p2.state, code });
      expect(conexaoDe(res)).toBe('erro');
      expect(motivoDe(res)).toBe('exchange_failed');
    });

    it('OUTRO usuario (mesmo logado e dono de outra comunidade) nao conclui a tentativa alheia', async () => {
      mp.addSeller('9004');
      const ini = await iniciar(A);
      const p = parametrosDa(ini.body.url);
      const res = await retorno(B.cookie, { state: p.state, code: mp.authorize('9004', p.challenge) });
      expect(conexaoDe(res)).toBe('erro');
      expect(motivoDe(res)).toBe('wrong_user');
      expect((await harness.owner.query(`SELECT 1 FROM payment_provider_authorizations WHERE provider_account_id = '9004'`)).rowCount).toBe(0);
    });

    it('iniciador que PERDEU a permissao antes do retorno: recusado', async () => {
      const gestor = await membro(B, 'OWNER');
      mp.addSeller('9005');
      const ini = await iniciar(B, gestor.cookie);
      expect(ini.status).toBe(200);
      const p = parametrosDa(ini.body.url);
      await harness.owner.query(`UPDATE memberships SET revoked_at = now() WHERE tenant_id = $1 AND user_id = $2`, [B.tenantId, gestor.conta.userId]);
      const res = await retorno(gestor.cookie, { state: p.state, code: mp.authorize('9005', p.challenge) });
      expect(conexaoDe(res)).toBe('erro');
      expect(['not_authorized', 'wrong_user', 'attempt_invalid']).toContain(motivoDe(res));
      expect((await harness.owner.query(`SELECT 1 FROM payment_provider_authorizations WHERE provider_account_id = '9005'`)).rowCount).toBe(0);
    });

    it('sem codigo (ou o vendedor recusou no Mercado Pago): falha sem criar conta, com auditoria sem segredo', async () => {
      const ini = await iniciar(B);
      const p = parametrosDa(ini.body.url);
      const res = await retorno(B.cookie, { state: p.state, error: 'access_denied' });
      expect(motivoDe(res)).toBe('provider_denied');
      const ini2 = await iniciar(B);
      const res2 = await retorno(B.cookie, { state: parametrosDa(ini2.body.url).state });
      expect(motivoDe(res2)).toBe('missing_code');
      const { rows } = await harness.owner.query<{ metadata: unknown }>(
        `SELECT after AS metadata FROM audit_events WHERE tenant_id = $1 AND action = 'payment_account.connection_failed'`,
        [B.tenantId],
      );
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(rows)).not.toMatch(/APP_USR|TG-|code_verifier|client_secret/);
    });

    it('sem sessao o retorno nao conclui nada (o callback exige o usuario logado)', async () => {
      const res = await request(harness.app).get('/api/payment-accounts/oauth/callback').query({ state: 'x'.repeat(40), code: 'TG-x' });
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  describe('conexao concluida', () => {
    it('a conta aparece CONECTADA, sem nenhum segredo na resposta, e o segredo fica cifrado no banco', async () => {
      const visao = await contas(A);
      expect(visao.enabled).toBe(true);
      expect(visao.checkoutAvailable).toBe(true);
      expect(visao.accounts).toHaveLength(1);
      expect(visao.accounts[0]).toMatchObject({
        provider: 'MERCADO_PAGO',
        environment: 'SANDBOX',
        status: 'CONNECTED',
        providerAccountId: '1001',
        authorizationStatus: 'ACTIVE',
        canReceivePayments: true,
      });
      const texto = JSON.stringify(visao);
      expect(texto).not.toMatch(/APP_USR|TG-|access|refresh|secret|token_encrypted/i);

      const auth = await autorizacaoDe(A);
      const tokens = mp.currentTokens('1001')!;
      expect(auth.access_token_encrypted!.toString('latin1')).not.toContain(tokens.access);
      expect(auth.refresh_token_encrypted!.toString('latin1')).not.toContain(tokens.refresh);
    });

    it('o papel da aplicacao NAO le credencial: nem a tabela, nem por funcao de outra comunidade', async () => {
      await expect(appPool.query('SELECT access_token_encrypted FROM payment_provider_authorizations')).rejects.toThrow(/permission denied/);
      await expect(appPool.query('SELECT * FROM payment_account_oauth_states')).rejects.toThrow(/permission denied/);
    });

    it('conectar DE NOVO a mesma conta na mesma comunidade nao duplica nada', async () => {
      const antes = await autorizacaoDe(A);
      const { res } = await conectar(A, '1001');
      expect(conexaoDe(res)).toBe('ok');
      const visao = await contas(A);
      expect(visao.accounts.filter((a) => a['status'] === 'CONNECTED')).toHaveLength(1);
      expect(visao.accounts).toHaveLength(1);
      const depois = await autorizacaoDe(A);
      expect(depois.id).toBe(antes.id);
      expect(depois.account_id).toBe(antes.account_id);
    });

    it('a MESMA conta do vendedor em duas comunidades: UMA autorizacao, dois vinculos, sem duplicar token', async () => {
      const { res } = await conectar(B, '1001');
      expect(conexaoDe(res)).toBe('ok');
      const { rows } = await harness.owner.query<{ n: number; vinculos: number }>(
        `SELECT count(DISTINCT a.id)::int AS n, count(t.id)::int AS vinculos
           FROM payment_provider_authorizations a JOIN tenant_payment_accounts t ON t.authorization_id = a.id
          WHERE a.provider_account_id = '1001'`,
      );
      expect(rows[0]).toEqual({ n: 1, vinculos: 2 });
      expect((await autorizacaoDe(A)).id).toBe((await autorizacaoDe(B)).id);
      // cada comunidade enxerga so o proprio vinculo
      const vA = (await contas(A)).accounts.filter((a) => a['providerAccountId'] === '1001');
      const vB = (await contas(B)).accounts.filter((a) => a['providerAccountId'] === '1001');
      expect(vA).toHaveLength(1);
      expect(vB).toHaveLength(1);
      expect(vA[0]!['id']).not.toBe(vB[0]!['id']);
    });
  });

  // -------------------------------------------------------------------------
  describe('pagamentos e a conta da comunidade', () => {
    it('o PIX e criado com a conta DA comunidade e o pagamento grava a conta usada', async () => {
      const { pagamento, pedido } = await compraOk(A);
      const { rows } = await harness.owner.query<{ id: string }>('SELECT id FROM tenant_payment_accounts WHERE tenant_id = $1', [A.tenantId]);
      expect(pagamento.payment_account_id).toBe(rows[0]!.id);
      expect(pedido.payment.copyPaste).toBeTruthy();
      // O pagamento pertence ao vendedor 1001 no Mercado Pago (criado com o token dele).
      expect(mp.payments.get(pagamento.provider_payment_id)!.sellerId).toBe('1001');
    });

    it('comunidade SEM conta: PAYMENTS_NOT_CONFIGURED, nenhuma cobranca, nenhuma chamada ao Mercado Pago', async () => {
      const vazia = await novaComunidade('pa-vazia-');
      const antes = mp.callsTo('/v1/payments');
      const pedido = await comprar(vazia);
      // O pedido nasce, mas a cobranca nao: o PIX so existe com conta conectada.
      const { rows } = await harness.owner.query('SELECT 1 FROM payments WHERE tenant_id = $1', [vazia.tenantId]);
      expect(rows).toHaveLength(0);
      expect(mp.callsTo('/v1/payments')).toBe(antes);
      if (pedido.status === 201) {
        const pix = await request(harness.app).post(`/api/public/orders/${pedido.body.orderId}/payment`).set('x-tenant-slug', vazia.slug);
        expect(pix.status).toBe(503);
        expect(pix.body.error.code).toBe('PAYMENTS_NOT_CONFIGURED');
      } else {
        expect(pedido.status).toBe(503);
        expect(pedido.body.error.code).toBe('PAYMENTS_NOT_CONFIGURED');
      }
      expect((await contas(vazia)).checkoutAvailable).toBe(false);
    });

    it('comunidade A nao usa a autorizacao da comunidade B (resolvedor recusa a conta alheia)', async () => {
      const contaB = (await contas(B)).accounts[0]!['id'] as string;
      await expect(runtime.resolver.forPayment({ tenantId: A.tenantId, paymentAccountId: contaB })).rejects.toBeInstanceOf(
        PaymentAccountUnavailableError,
      );
      // e no banco: uma cobranca de A apontando para a conta de B e barrada pelo guard
      const { pagamento } = await compraOk(A);
      await expect(
        harness.owner.query('UPDATE payments SET payment_account_id = $1 WHERE id = $2', [contaB, pagamento.id]),
      ).rejects.toThrow();
    });

    it('nao ha credencial global: sem a conta, o resolvedor nao inventa outra', async () => {
      const vazia = await novaComunidade('pa-global-');
      await expect(runtime.resolver.forTenant(vazia.tenantId)).rejects.toMatchObject({ name: 'PaymentsNotConfiguredError' });
    });
  });

  // -------------------------------------------------------------------------
  describe('renovacao do token', () => {
    it('renovacao normal: troca access E refresh de uma vez e sobe a versao', async () => {
      const auth = await autorizacaoDe(A);
      const antes = mp.currentTokens('1001')!;
      await vencerEm(auth.id, '2 minutes');
      await runtime.resolver.forTenant(A.tenantId);
      const depois = await autorizacaoDe(A);
      expect(depois.credential_version).toBe(auth.credential_version + 1);
      expect(Buffer.compare(depois.access_token_encrypted!, auth.access_token_encrypted!)).not.toBe(0);
      expect(Buffer.compare(depois.refresh_token_encrypted!, auth.refresh_token_encrypted!)).not.toBe(0);
      // refresh token ROTACIONADO: o que o Mercado Pago tem vigente e outro, e o antigo morreu
      const agora = mp.currentTokens('1001')!;
      expect(agora.refresh).not.toBe(antes.refresh);
      expect(new Date(depois.expires_at!).getTime()).toBeGreaterThan(Date.now() + 30 * 86_400_000);
    });

    it('duas renovacoes CONCORRENTES (API e worker): o Mercado Pago so e chamado UMA vez e o segredo nao se corrompe', async () => {
      const auth = await autorizacaoDe(A);
      await vencerEm(auth.id, '1 minute');
      const chamadasAntes = mp.callsTo('/oauth/token');
      mp.refreshDelayMs = 150;
      try {
        await Promise.all([
          runtime.resolver.forTenant(A.tenantId),
          workerRuntime.refreshDue(50),
          runtime.resolver.forTenant(B.tenantId), // mesma autorizacao, outra comunidade
        ]);
      } finally {
        mp.refreshDelayMs = 0;
      }
      expect(mp.callsTo('/oauth/token') - chamadasAntes).toBe(1);
      const depois = await autorizacaoDe(A);
      expect(depois.credential_version).toBe(auth.credential_version + 1);
      // a credencial que ficou e a VIGENTE no Mercado Pago (um refresh velho nao sobrescreveu o novo)
      const gw = await runtime.resolver.forTenant(A.tenantId);
      expect(gw.paymentAccountId).toBeTruthy();
      expect((await compraOk(A)).pagamento.payment_account_id).toBe(gw.paymentAccountId);
    });

    it('access token VENCIDO no provedor (401): renova e repete UMA vez, e o pagamento sai', async () => {
      mp.expireAccessTokens('1001');
      const v0 = (await autorizacaoDe(A)).credential_version;
      const { pedido } = await compraOk(A);
      expect(pedido.payment.copyPaste).toBeTruthy();
      expect((await autorizacaoDe(A)).credential_version).toBe(v0 + 1);
    });

    it('falha temporaria do Mercado Pago NA renovacao: a credencial vigente fica intacta e a proxima tentativa conclui', async () => {
      const auth = await autorizacaoDe(A);
      await vencerEm(auth.id, '1 minute');
      mp.failNext('/oauth/token', 503, 1);
      await expect(runtime.resolver.forTenant(A.tenantId)).rejects.toBeTruthy();
      const meio = await autorizacaoDe(A);
      expect(meio.credential_version).toBe(auth.credential_version);
      expect(Buffer.compare(meio.refresh_token_encrypted!, auth.refresh_token_encrypted!)).toBe(0);
      expect(meio.status).toBe('ACTIVE');
      expect(meio.account_status).toBe('CONNECTED');
      // o refresh token antigo segue valido no provedor: a renovacao seguinte funciona
      await runtime.resolver.forTenant(A.tenantId);
      expect((await autorizacaoDe(A)).credential_version).toBe(auth.credential_version + 1);
    });

    it('o job de renovacao (worker) renova as que vencem dentro da margem e deixa as outras em paz', async () => {
      const auth = await autorizacaoDe(A);
      await vencerEm(auth.id, '3 days');
      const r = await workerRuntime.refreshDue(50);
      expect(r.refreshed).toBeGreaterThanOrEqual(1);
      expect((await autorizacaoDe(A)).credential_version).toBe(auth.credential_version + 1);
      const chamadas = mp.callsTo('/oauth/token');
      const r2 = await workerRuntime.refreshDue(50);
      expect(r2.refreshed).toBe(0);
      expect(mp.callsTo('/oauth/token')).toBe(chamadas);
    });
  });

  // -------------------------------------------------------------------------
  describe('webhook (Mercado Pago, assinatura da aplicacao)', () => {
    it('valido: o aviso dispara a CONSULTA e so a consulta paga o pedido (RN06)', async () => {
      const { orderId, pagamento } = await compraOk(A);
      // O aviso chega "aprovado" no corpo, mas o Mercado Pago ainda diz pendente: nada muda.
      const sem = await avisar(A.slug, pagamento.provider_payment_id);
      expect(sem.status).toBe(200);
      expect(await statusPedido(orderId)).toBe('PENDENTE');
      mp.approvePayment(pagamento.provider_payment_id);
      const res = await avisar(A.slug, pagamento.provider_payment_id);
      expect(res.status).toBe(200);
      expect(await statusPedido(orderId)).toBe('PAGO');
    });

    it('duplicado: o mesmo aviso de novo nao vende de novo', async () => {
      const { orderId, pagamento } = await compraOk(A);
      mp.approvePayment(pagamento.provider_payment_id);
      const a = await avisar(A.slug, pagamento.provider_payment_id);
      const b = await avisar(A.slug, pagamento.provider_payment_id);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(await statusPedido(orderId)).toBe('PAGO');
      const { rows } = await harness.owner.query('SELECT 1 FROM payments WHERE order_id = $1 AND status = \'APROVADO\'', [orderId]);
      expect(rows).toHaveLength(1);
      const { rows: n } = await harness.owner.query(`SELECT 1 FROM draw_numbers WHERE order_id = $1 AND status = 'PAGO'`, [orderId]);
      expect(n).toHaveLength(1);
    });

    it('assinatura invalida (segredo errado, ou corpo sem assinatura): recusado e nada consultado', async () => {
      const { orderId, pagamento } = await compraOk(A);
      mp.approvePayment(pagamento.provider_payment_id);
      const consultasAntes = mp.callsTo(`/v1/payments/${pagamento.provider_payment_id}`);
      const errado = await avisar(A.slug, pagamento.provider_payment_id, { secret: 'outro-segredo' });
      expect([400, 401]).toContain(errado.status);
      const w = mp.signedWebhook(pagamento.provider_payment_id);
      const semAssinatura = await request(harness.app)
        .post(`/api/webhooks/mercadopago/${A.slug}`)
        .query(w.query)
        .send(w.body as object);
      expect([400, 401]).toContain(semAssinatura.status);
      expect(mp.callsTo(`/v1/payments/${pagamento.provider_payment_id}`)).toBe(consultasAntes);
      expect(await statusPedido(orderId)).toBe('PENDENTE');
    });

    it('CRUZADO: aviso na rota da comunidade B sobre pagamento da comunidade A nao altera nada de A', async () => {
      const { orderId, pagamento } = await compraOk(A);
      mp.approvePayment(pagamento.provider_payment_id);
      const res = await avisar(B.slug, pagamento.provider_payment_id); // assinatura valida, rota errada
      expect(res.status).toBe(200);
      expect(await statusPedido(orderId)).toBe('PENDENTE');
      const { rows } = await harness.owner.query<{ status: string }>('SELECT status::text AS status FROM payments WHERE id = $1', [pagamento.id]);
      expect(rows[0]!.status).toBe('PENDENTE');
      // na rota certa, o mesmo aviso aplica
      expect((await avisar(A.slug, pagamento.provider_payment_id)).status).toBe(200);
      expect(await statusPedido(orderId)).toBe('PAGO');
    });

    it('vendedor diferente no corpo (user_id) e uma conta incompativel: ignorado', async () => {
      const { orderId, pagamento } = await compraOk(A);
      mp.approvePayment(pagamento.provider_payment_id);
      const res = await avisar(A.slug, pagamento.provider_payment_id, { userId: '424242' });
      expect(res.status).toBe(200);
      expect(await statusPedido(orderId)).toBe('PENDENTE');
    });

    it('pagamento desconhecido: 200 sem efeito (nao vaza se existe)', async () => {
      const res = await avisar(A.slug, '123456789');
      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  describe('o MESMO vendedor em A e B (sem mistura de dados)', () => {
    it('pedidos, pagamentos e avisos ficam cada um na sua comunidade', async () => {
      const a = await compraOk(A);
      const b = await compraOk(B);
      expect(a.pagamento.payment_account_id).not.toBe(b.pagamento.payment_account_id);
      // mesma conta do vendedor por tras
      expect((await autorizacaoDe(A)).id).toBe((await autorizacaoDe(B)).id);

      mp.approvePayment(a.pagamento.provider_payment_id);
      expect((await avisar(B.slug, a.pagamento.provider_payment_id)).status).toBe(200);
      expect(await statusPedido(a.orderId)).toBe('PENDENTE');
      expect(await statusPedido(b.orderId)).toBe('PENDENTE');
      expect((await avisar(A.slug, a.pagamento.provider_payment_id)).status).toBe(200);
      expect(await statusPedido(a.orderId)).toBe('PAGO');
      expect(await statusPedido(b.orderId)).toBe('PENDENTE');

      // relatorios/pedidos listados por cada comunidade so trazem os seus
      const { rows } = await harness.owner.query<{ tenant_id: string }>(
        'SELECT DISTINCT tenant_id FROM payments WHERE id = ANY($1::uuid[])',
        [[a.pagamento.id, b.pagamento.id]],
      );
      expect(rows).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  describe('troca de conta e desconexao segura', () => {
    it('TROCA de conta: o pagamento antigo segue preso a conta antiga e quem paga depois continua aplicado; o novo usa a nova', async () => {
      const C = await novaComunidade('pa-troca-');
      expect(conexaoDe((await conectar(C, '2001')).res)).toBe('ok');
      const antigo = await compraOk(C);
      const contaAntiga = antigo.pagamento.payment_account_id;

      // O dono conecta OUTRO vendedor: a conta antiga passa a DISCONNECTING (ha PIX pendente).
      expect(conexaoDe((await conectar(C, '2002')).res)).toBe('ok');
      const visao = await contas(C);
      const porStatus = Object.fromEntries(visao.accounts.map((a) => [a['providerAccountId'], a['status']]));
      expect(porStatus).toEqual({ '2001': 'DISCONNECTING', '2002': 'CONNECTED' });

      const novo = await compraOk(C);
      expect(novo.pagamento.payment_account_id).not.toBe(contaAntiga);
      expect(mp.payments.get(novo.pagamento.provider_payment_id)!.sellerId).toBe('2002');
      // o antigo NAO foi alterado
      const { rows } = await harness.owner.query<{ payment_account_id: string }>('SELECT payment_account_id FROM payments WHERE id = $1', [antigo.pagamento.id]);
      expect(rows[0]!.payment_account_id).toBe(contaAntiga);

      // O cliente paga o PIX ANTIGO: a consulta usa a conta ORIGINAL (2001) e aplica.
      mp.approvePayment(antigo.pagamento.provider_payment_id);
      expect((await avisar(C.slug, antigo.pagamento.provider_payment_id)).status).toBe(200);
      expect(await statusPedido(antigo.orderId)).toBe('PAGO');
      expect(mp.payments.get(antigo.pagamento.provider_payment_id)!.sellerId).toBe('2001');

      // Sem mais nada pendente na conta antiga, o worker a conclui e apaga o segredo.
      const { rows: pend } = await harness.owner.query(`SELECT 1 FROM payments WHERE payment_account_id = $1 AND status = 'PENDENTE'`, [contaAntiga]);
      expect(pend).toHaveLength(0);
      expect(await workerRuntime.finalizeDisconnections()).toBeGreaterThanOrEqual(1);
      const { rows: fim } = await harness.owner.query<{ status: string }>('SELECT status::text AS status FROM tenant_payment_accounts WHERE id = $1', [contaAntiga]);
      expect(fim[0]!.status).toBe('DISCONNECTED');
    });

    it('desconectar COM pagamento pendente: DISCONNECTING, nada novo sai, o pendente ainda e resolvido; depois conclui e apaga o segredo', async () => {
      const C = await novaComunidade('pa-desc-');
      await conectar(C, '3001');
      const pend = await compraOk(C);
      const contaId = pend.pagamento.payment_account_id;

      const res = await donoDe(C).post(`/api/tenant/payment-accounts/${contaId}/disconnect`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ status: 'DISCONNECTING', canReceivePayments: false });
      expect(res.body.openObligations).toBeGreaterThanOrEqual(1);

      // Nada NOVO e cobrado.
      const nova = await comprar(C);
      expect(nova.status === 503 || nova.body?.payment == null).toBe(true);
      expect((await harness.owner.query(`SELECT 1 FROM payments WHERE tenant_id = $1`, [C.tenantId])).rowCount).toBe(1);
      expect((await contas(C)).checkoutAvailable).toBe(false);

      // O que existe ainda e resolvido com a credencial guardada.
      mp.approvePayment(pend.pagamento.provider_payment_id);
      expect((await avisar(C.slug, pend.pagamento.provider_payment_id)).status).toBe(200);
      expect(await statusPedido(pend.orderId)).toBe('PAGO');

      // Sem dependencias abertas (as reservas da compra recusada tambem ja nao contam): conclui.
      await harness.owner.query(`UPDATE payments SET created_at = now() - interval '10 days' WHERE tenant_id = $1`, [C.tenantId]);
      await workerRuntime.finalizeDisconnections();
      const fim = await autorizacaoDe(C);
      expect(fim.account_status).toBe('DISCONNECTED');
      // a autorizacao so e apagada se ninguem mais depende dela (aqui ninguem)
      expect(fim.access_token_encrypted).toBeNull();
      expect(fim.refresh_token_encrypted).toBeNull();
    });

    it('desconectar SEM pendencia: DISCONNECTED na hora, e nova cobranca volta a ser PAYMENTS_NOT_CONFIGURED', async () => {
      const C = await novaComunidade('pa-semp-');
      await conectar(C, '3002');
      const contaId = (await contas(C)).accounts[0]!['id'] as string;
      const res = await donoDe(C).post(`/api/tenant/payment-accounts/${contaId}/disconnect`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('DISCONNECTED');
      await expect(runtime.resolver.forTenant(C.tenantId)).rejects.toMatchObject({ name: 'PaymentsNotConfiguredError' });
      const pedido = await comprar(C);
      expect((await harness.owner.query('SELECT 1 FROM payments WHERE tenant_id = $1', [C.tenantId])).rowCount).toBe(0);
      expect(pedido.status === 503 ? pedido.body.error.code : 'PAYMENTS_NOT_CONFIGURED').toBe('PAYMENTS_NOT_CONFIGURED');
    });

    it('desconectar a conta de OUTRA comunidade: 404, e a dela segue conectada', async () => {
      const contaB = (await contas(B)).accounts[0]!['id'] as string;
      const res = await donoDe(A).post(`/api/tenant/payment-accounts/${contaB}/disconnect`);
      expect(res.status).toBe(404);
      expect((await contas(B)).accounts[0]!['status']).toBe('CONNECTED');
    });

    it('a mesma conta em duas comunidades: desconectar uma NAO apaga o segredo da outra', async () => {
      const X = await novaComunidade('pa-x-');
      const Y = await novaComunidade('pa-y-');
      await conectar(X, '3003');
      await conectar(Y, '3003');
      const contaX = (await contas(X)).accounts[0]!['id'] as string;
      expect((await donoDe(X).post(`/api/tenant/payment-accounts/${contaX}/disconnect`)).status).toBe(200);
      const y = await autorizacaoDe(Y);
      expect(y.status).toBe('ACTIVE');
      expect(y.access_token_encrypted).not.toBeNull();
      expect((await compraOk(Y)).pagamento.payment_account_id).toBe(y.account_id);
    });
  });

  // -------------------------------------------------------------------------
  describe('revogacao no Mercado Pago e falhas temporarias', () => {
    it('o vendedor REVOGA o acesso: a renovacao e recusada, a conta cai, nada novo e cobrado e nao finge que consulta', async () => {
      const C = await novaComunidade('pa-rev-');
      await conectar(C, '4001');
      const pend = await compraOk(C);
      const auth = await autorizacaoDe(C);
      await vencerEm(auth.id, '1 minute');
      mp.revokeSeller('4001');

      // Uma cobranca nova: renovar falha (invalid_grant) -> autorizacao REVOKED, conta REVOKED.
      await comprar(C);
      const depois = await autorizacaoDe(C);
      expect(depois.status).toBe('REVOKED');
      expect(depois.account_status).toBe('REVOKED');
      expect(depois.access_token_encrypted).toBeNull();
      expect(depois.refresh_token_encrypted).toBeNull();

      await expect(runtime.resolver.forTenant(C.tenantId)).rejects.toBeInstanceOf(PaymentAccountUnavailableError);
      const pix = await comprar(C);
      expect(pix.status === 503 ? pix.body.error.code : 'PAYMENT_ACCOUNT_UNAVAILABLE').toMatch(/PAYMENT_ACCOUNT_UNAVAILABLE|PAYMENTS_NOT_CONFIGURED/);

      // O PIX pendente nao pode ser consultado: fica sinalizado para acao manual e o aviso nao aplica.
      mp.approvePayment(pend.pagamento.provider_payment_id);
      expect((await avisar(C.slug, pend.pagamento.provider_payment_id)).status).toBe(200);
      expect(await statusPedido(pend.orderId)).toBe('PENDENTE');
      const { rows } = await harness.owner.query(
        `SELECT 1 FROM payment_reconciliation_issues WHERE tenant_id = $1 AND kind = 'PAYMENT_AUTHORIZATION_UNAVAILABLE'`,
        [C.tenantId],
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const visao = await contas(C);
      expect(visao.accounts[0]).toMatchObject({ status: 'REVOKED', canReceivePayments: false });
      expect(visao.checkoutAvailable).toBe(false);
    });

    it('Mercado Pago fora ao criar a cobranca: 503 do provedor, nenhuma cobranca gravada e a conta segue CONECTADA', async () => {
      mp.failNext('/v1/payments', 503, 1);
      const antes = (await harness.owner.query('SELECT 1 FROM payments WHERE tenant_id = $1', [A.tenantId])).rowCount;
      const pedido = await comprar(A);
      const depois = (await harness.owner.query('SELECT 1 FROM payments WHERE tenant_id = $1', [A.tenantId])).rowCount;
      expect(depois).toBe(antes);
      if (pedido.status !== 201) expect(pedido.status).toBe(503);
      expect((await autorizacaoDe(A)).account_status).toBe('CONNECTED');
      // recuperou: a proxima cobranca sai
      expect((await compraOk(A)).pagamento.payment_account_id).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  describe('auditoria e vazamento', () => {
    it('a trilha registra o ciclo de vida sem nenhum segredo', async () => {
      const { rows } = await harness.owner.query<{ action: string; metadata: unknown }>(
        `SELECT action, before, after FROM audit_events WHERE action LIKE 'payment_account.%' OR action LIKE 'payment_authorization.%'`,
      );
      const acoes = new Set(rows.map((r) => r.action));
      for (const esperada of ['payment_account.connection_started', 'payment_account.connected', 'payment_account.connection_failed']) {
        expect(acoes.has(esperada), esperada).toBe(true);
      }
      const texto = JSON.stringify(rows);
      expect(texto).not.toMatch(/APP_USR-|TG-CODE|TG-\d|code_verifier|client_secret|access_token|refresh_token/);
    });

    it('nenhuma resposta da API de recebimentos carrega token, segredo do aplicativo, code ou verifier', async () => {
      const respostas = [await contas(A), await contas(B)].map((r) => JSON.stringify(r)).join('');
      expect(respostas).not.toMatch(/APP_USR-|TG-|secret|verifier|code/i);
    });
  });
});
