import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Mercado Pago EM MEMORIA, no nivel do `fetch`, so para testes.
 *
 * Quem fala com ele e o codigo de PRODUCAO (o cliente OAuth e o adaptador real do Mercado
 * Pago): o que o teste substitui e a rede. O fake aplica as regras que importam:
 *   - o codigo de autorizacao vale UMA vez e so com o `code_verifier` do PKCE certo;
 *   - o refresh token e de uso UNICO e rotaciona (o antigo deixa de valer);
 *   - cada pagamento pertence ao vendedor do token que o criou: outro token NAO o enxerga (404);
 *   - token revogado ou vencido responde 401.
 */

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

interface Seller {
  id: string;
  live: boolean;
  revoked: boolean;
}
interface Code {
  sellerId: string;
  challenge: string;
  used: boolean;
}
interface Payment {
  id: string;
  sellerId: string;
  status: 'pending' | 'approved' | 'cancelled' | 'refunded';
  statusDetail: string;
  amount: number;
  externalReference: string | null;
  expiresAt: string | null;
  approvedAt: string | null;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export class FakeMercadoPago {
  readonly clientId = 'app-client-id-test';
  readonly clientSecret = 'app-client-secret-test';
  readonly redirectUri: string;
  readonly webhookSecret = 'segredo-webhook-da-aplicacao';

  readonly calls: string[] = [];
  readonly sellers = new Map<string, Seller>();
  readonly payments = new Map<string, Payment>();
  readonly #codes = new Map<string, Code>();
  readonly #access = new Map<string, { sellerId: string; expired: boolean }>();
  readonly #refresh = new Map<string, { sellerId: string; valid: boolean }>();
  readonly #idem = new Map<string, Payment>();
  readonly #failures: { match: string; status: number; times: number }[] = [];
  #seq = 0;
  #paymentSeq = 700_000_000 + Math.floor(Math.random() * 50_000_000);

  constructor(options: { redirectUri?: string } = {}) {
    this.redirectUri = options.redirectUri ?? 'https://api.clubedarifa.test/api/payment-accounts/oauth/callback';
  }

  /** Espera artificial (ms) na renovacao, para sobrepor chamadas concorrentes. */
  refreshDelayMs = 0;

  addSeller(id: string, options: { live?: boolean } = {}): void {
    this.sellers.set(id, { id, live: options.live ?? false, revoked: false });
  }

  /** O vendedor clica em "autorizar" no Mercado Pago: nasce um codigo ligado ao desafio PKCE. */
  authorize(sellerId: string, codeChallenge: string): string {
    const code = `TG-CODE-${randomBytes(9).toString('hex')}`;
    this.#codes.set(code, { sellerId, challenge: codeChallenge, used: false });
    return code;
  }

  /** O vendedor revoga o acesso do aplicativo no painel do Mercado Pago. */
  revokeSeller(sellerId: string): void {
    const s = this.sellers.get(sellerId);
    if (s) s.revoked = true;
    for (const t of this.#access.values()) if (t.sellerId === sellerId) t.expired = true;
    for (const r of this.#refresh.values()) if (r.sellerId === sellerId) r.valid = false;
  }

  /** O access token vence (o refresh token continua valendo). */
  expireAccessTokens(sellerId: string): void {
    for (const t of this.#access.values()) if (t.sellerId === sellerId) t.expired = true;
  }

  /** As proximas `times` chamadas cujo caminho contem `match` respondem `status` (ex.: 503). */
  failNext(match: string, status = 503, times = 1): void {
    this.#failures.push({ match, status, times });
  }

  callsTo(match: string): number {
    return this.calls.filter((c) => c.includes(match)).length;
  }

  /** O par vigente de um vendedor (o ultimo emitido). */
  currentTokens(sellerId: string): { access: string; refresh: string } | null {
    let access: string | null = null;
    let refresh: string | null = null;
    for (const [t, v] of this.#access) if (v.sellerId === sellerId && !v.expired) access = t;
    for (const [t, v] of this.#refresh) if (v.sellerId === sellerId && v.valid) refresh = t;
    return access && refresh ? { access, refresh } : null;
  }

  approvePayment(id: string): void {
    const p = this.payments.get(id);
    if (!p) throw new Error(`pagamento ${id} inexistente`);
    p.status = 'approved';
    p.approvedAt = new Date().toISOString();
  }

  /** Aviso de pagamento ASSINADO como o Mercado Pago faz (segredo da aplicacao). */
  signedWebhook(
    paymentId: string,
    options: { secret?: string; userId?: string; requestId?: string } = {},
  ): { headers: Record<string, string>; query: Record<string, string>; body: unknown } {
    const ts = String(Math.floor(Date.now() / 1000));
    const requestId = options.requestId ?? `req-${paymentId}-${ts}`;
    const manifesto = `id:${paymentId};request-id:${requestId};ts:${ts};`;
    const v1 = createHmac('sha256', options.secret ?? this.webhookSecret).update(manifesto).digest('hex');
    return {
      headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId },
      query: { 'data.id': paymentId, type: 'payment' },
      body: {
        type: 'payment',
        action: 'payment.updated',
        data: { id: paymentId },
        ...(options.userId ? { user_id: options.userId } : {}),
      },
    };
  }

  /** O `fetch` que os clientes recebem no lugar da rede. */
  readonly fetch = async (input: string, init: FetchInit = {}): Promise<Response> => {
    const url = new URL(input);
    const path = url.pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    this.calls.push(`${method} ${path}`);

    const falha = this.#failures.find((f) => f.times > 0 && path.includes(f.match));
    if (falha) {
      falha.times -= 1;
      return json(falha.status, { message: 'erro injetado' });
    }

    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === 'string' && init.body !== '' ? (JSON.parse(init.body) as Record<string, unknown>) : {};

    if (method === 'POST' && path === '/oauth/token') return this.#token(body);
    if (method === 'GET' && path === '/users/me') {
      const seller = this.#sellerOfToken(headers['Authorization']);
      return seller ? json(200, { id: Number(seller.id) || seller.id }) : json(401, { message: 'invalid access token' });
    }
    if (method === 'POST' && path === '/v1/payments') return this.#createPayment(headers, body);
    const m = /^\/v1\/payments\/(\d+)$/.exec(path);
    if (method === 'GET' && m) return this.#getPayment(headers, m[1]!);
    return json(404, { message: 'rota desconhecida' });
  };

  #sellerOfToken(authorization: string | undefined): Seller | null {
    const token = authorization?.replace(/^Bearer\s+/i, '');
    const t = token ? this.#access.get(token) : undefined;
    if (!t || t.expired) return null;
    const seller = this.sellers.get(t.sellerId);
    return seller && !seller.revoked ? seller : null;
  }

  #issue(sellerId: string): Record<string, unknown> {
    const seller = this.sellers.get(sellerId)!;
    this.#seq += 1;
    const access = `APP_USR-${sellerId}-${this.#seq}-${randomBytes(6).toString('hex')}`;
    const refresh = `TG-${sellerId}-${this.#seq}-${randomBytes(6).toString('hex')}`;
    this.#access.set(access, { sellerId, expired: false });
    this.#refresh.set(refresh, { sellerId, valid: true });
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: 15_552_000,
      scope: 'offline_access read write',
      user_id: Number(sellerId) || sellerId,
      live_mode: seller.live,
    };
  }

  async #token(body: Record<string, unknown>): Promise<Response> {
    if (body['client_id'] !== this.clientId || body['client_secret'] !== this.clientSecret) {
      return json(401, { error: 'unauthorized_client' });
    }
    if (body['grant_type'] === 'authorization_code') {
      const code = this.#codes.get(String(body['code']));
      if (!code || code.used || body['redirect_uri'] !== this.redirectUri) return json(400, { error: 'invalid_grant' });
      code.used = true; // uso unico, mesmo que o PKCE falhe depois
      const challenge = createHash('sha256').update(String(body['code_verifier'] ?? ''), 'utf8').digest('base64url');
      if (challenge !== code.challenge) return json(400, { error: 'invalid_grant' });
      const seller = this.sellers.get(code.sellerId);
      if (!seller || seller.revoked) return json(400, { error: 'invalid_grant' });
      return json(200, this.#issue(code.sellerId));
    }
    if (body['grant_type'] === 'refresh_token') {
      if (this.refreshDelayMs > 0) await new Promise((r) => setTimeout(r, this.refreshDelayMs));
      const r = this.#refresh.get(String(body['refresh_token']));
      const seller = r ? this.sellers.get(r.sellerId) : undefined;
      if (!r || !r.valid || !seller || seller.revoked) return json(400, { error: 'invalid_grant' });
      r.valid = false; // rotacao: o refresh token usado morre
      return json(200, this.#issue(r.sellerId));
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  #createPayment(headers: Record<string, string>, body: Record<string, unknown>): Response {
    const seller = this.#sellerOfToken(headers['Authorization']);
    if (!seller) return json(401, { message: 'invalid access token' });
    const key = headers['X-Idempotency-Key'];
    const idem = key ? `${seller.id}:${key}` : null;
    const existing = idem ? this.#idem.get(idem) : undefined;
    if (existing) return json(201, this.#paymentBody(existing));

    const payment: Payment = {
      id: String(this.#paymentSeq++),
      sellerId: seller.id,
      status: 'pending',
      statusDetail: 'pending_waiting_transfer',
      amount: Number(body['transaction_amount']),
      externalReference: typeof body['external_reference'] === 'string' ? body['external_reference'] : null,
      expiresAt: typeof body['date_of_expiration'] === 'string' ? body['date_of_expiration'] : null,
      approvedAt: null,
    };
    this.payments.set(payment.id, payment);
    if (idem) this.#idem.set(idem, payment);
    return json(201, this.#paymentBody(payment));
  }

  #getPayment(headers: Record<string, string>, id: string): Response {
    const seller = this.#sellerOfToken(headers['Authorization']);
    if (!seller) return json(401, { message: 'invalid access token' });
    const payment = this.payments.get(id);
    // Pagamento de OUTRO vendedor nao existe para este token.
    if (!payment || payment.sellerId !== seller.id) return json(404, { message: 'Payment not found' });
    return json(200, this.#paymentBody(payment));
  }

  #paymentBody(p: Payment): Record<string, unknown> {
    return {
      id: Number(p.id),
      status: p.status,
      status_detail: p.statusDetail,
      transaction_amount: p.amount,
      external_reference: p.externalReference,
      date_of_expiration: p.expiresAt,
      date_approved: p.approvedAt,
      point_of_interaction: { transaction_data: { qr_code: `00020126FAKEMP${p.id}`, qr_code_base64: 'ZmFrZS1tcC1xcg==' } },
    };
  }
}
