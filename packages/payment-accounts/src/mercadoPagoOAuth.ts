/**
 * Cliente OAuth do Mercado Pago (fluxo `authorization_code` + PKCE, e renovacao por
 * `refresh_token`).
 *
 *  - `fetch` e injetavel: os testes falam com um Mercado Pago em memoria.
 *  - Nenhuma mensagem de erro carrega o corpo da resposta do provedor nem qualquer credencial:
 *    so um tipo (`kind`) e um texto fixo. O que o provedor devolveu nao vai para log.
 */

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;
type FetchLike = (input: string, init?: FetchInit) => Promise<Response>;

export interface MercadoPagoOAuthOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  /** URL de retorno CADASTRADA no aplicativo do Mercado Pago. */
  readonly redirectUri: string;
  readonly fetchImpl?: FetchLike | undefined;
  readonly authBase?: string | undefined;
  readonly apiBase?: string | undefined;
}

export interface OAuthTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: Date;
  readonly scopes: readonly string[];
  /** Conta do vendedor no provedor. */
  readonly userId: string;
  /** `true` producao, `false` teste, `null` se o provedor nao disse. */
  readonly liveMode: boolean | null;
}

/**
 *  invalid_grant  o codigo/refresh token foi recusado (usado, vencido, revogado);
 *  rejected       outra recusa definitiva do provedor;
 *  transient      rede, 5xx, limite: pode tentar de novo, nada mudou.
 */
export type OAuthErrorKind = 'invalid_grant' | 'rejected' | 'transient';

export class OAuthError extends Error {
  readonly kind: OAuthErrorKind;
  constructor(kind: OAuthErrorKind, message: string) {
    super(message);
    this.name = 'OAuthError';
    this.kind = kind;
  }
}

/** Escopos pedidos: `offline_access` e o que permite RENOVAR o token sem o vendedor. */
export const MERCADOPAGO_OAUTH_SCOPES = ['offline_access', 'read', 'write'] as const;

const TIMEOUT_MS = 10_000;

export class MercadoPagoOAuthClient {
  readonly #options: MercadoPagoOAuthOptions;
  readonly #fetch: FetchLike;
  readonly #authBase: string;
  readonly #apiBase: string;

  constructor(options: MercadoPagoOAuthOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#authBase = options.authBase ?? 'https://auth.mercadopago.com';
    this.#apiBase = options.apiBase ?? 'https://api.mercadopago.com';
  }

  /** URL para onde o vendedor e enviado. `state` e o desafio PKCE ja vem prontos. */
  buildAuthorizationUrl(input: { state: string; codeChallenge: string }): string {
    const params = new URLSearchParams({
      client_id: this.#options.clientId,
      response_type: 'code',
      platform_id: 'mp',
      state: input.state,
      scope: MERCADOPAGO_OAUTH_SCOPES.join(' '),
      redirect_uri: this.#options.redirectUri,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${this.#authBase}/authorization?${params.toString()}`;
  }

  exchangeCode(input: { code: string; codeVerifier: string }): Promise<OAuthTokenSet> {
    return this.#token({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: this.#options.redirectUri,
      code_verifier: input.codeVerifier,
    });
  }

  refresh(refreshToken: string): Promise<OAuthTokenSet> {
    return this.#token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  /** Quem e o dono do token: confere a identidade da conta que autorizou. */
  async whoAmI(accessToken: string): Promise<{ id: string }> {
    const res = await this.#call('/users/me', { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } });
    const id = (res as { id?: unknown }).id;
    if (id === undefined || id === null || String(id) === '') {
      throw new OAuthError('rejected', 'O provedor nao informou a identidade da conta.');
    }
    return { id: String(id) };
  }

  async #token(body: Record<string, string>): Promise<OAuthTokenSet> {
    const raw = (await this.#call('/oauth/token', {
      method: 'POST',
      body: JSON.stringify({
        client_id: this.#options.clientId,
        client_secret: this.#options.clientSecret,
        ...body,
      }),
    })) as Record<string, unknown>;

    const accessToken = raw['access_token'];
    const refreshToken = raw['refresh_token'];
    const expiresIn = Number(raw['expires_in']);
    const userId = raw['user_id'];
    if (
      typeof accessToken !== 'string' || accessToken === '' ||
      typeof refreshToken !== 'string' || refreshToken === '' ||
      !Number.isFinite(expiresIn) || expiresIn <= 0 ||
      userId === undefined || userId === null || String(userId) === ''
    ) {
      // Sem refresh token nao ha como renovar: a conexao nao serve.
      throw new OAuthError('rejected', 'Resposta do provedor incompleta (falta token, renovacao, validade ou conta).');
    }
    const scope = typeof raw['scope'] === 'string' ? (raw['scope'] as string).split(/[\s,]+/).filter(Boolean) : [];
    return {
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      scopes: scope,
      userId: String(userId),
      liveMode: typeof raw['live_mode'] === 'boolean' ? (raw['live_mode'] as boolean) : null,
    };
  }

  async #call(path: string, init: FetchInit): Promise<unknown> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#apiBase}${path}`, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers as Record<string, string> | undefined) },
      });
    } catch {
      throw new OAuthError('transient', 'Mercado Pago indisponivel.');
    }
    if (res.status >= 500 || res.status === 429) {
      throw new OAuthError('transient', `Mercado Pago respondeu ${res.status}.`);
    }
    let json: unknown = null;
    try {
      const text = await res.text();
      json = text === '' ? null : JSON.parse(text);
    } catch {
      throw new OAuthError('transient', 'Resposta do Mercado Pago nao e JSON.');
    }
    if (!res.ok) {
      const code = String((json as { error?: unknown } | null)?.error ?? '');
      if (code === 'invalid_grant' || code === 'invalid_request') {
        throw new OAuthError('invalid_grant', 'O provedor recusou o codigo ou a renovacao.');
      }
      if (res.status === 401) {
        throw new OAuthError('invalid_grant', 'O provedor recusou a credencial.');
      }
      throw new OAuthError('rejected', `Mercado Pago recusou o pedido (${res.status}).`);
    }
    return json;
  }
}
