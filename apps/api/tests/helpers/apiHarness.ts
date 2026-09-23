import type { Express } from 'express';
import request from 'supertest';
import pg from 'pg';
import { createPool, migrate, pgConnectionConfig, type DbPool } from '@campaigns/db';
import { createApp } from '../../src/app.js';
import { loadConfig, type AppConfig } from '../../src/config.js';
import { LoginThrottle } from '../../src/lib/loginThrottle.js';
import { SecretBox } from '../../src/lib/secretBox.js';
import { hashPassword } from '../../src/lib/password.js';

const { Client } = pg;

/**
 * Bancada dos testes de integracao da API.
 *
 * A API sobe com o pool apontando para o papel REAL da aplicacao (app_user).
 * Semeadura e feita por uma conexao separada, de dono. Assim o que os testes
 * exercitam e o mesmo caminho de producao, com RLS valendo.
 */

export const TEST_OWNER_URL = process.env['TEST_MIGRATION_DATABASE_URL'] ?? '';
export const TEST_APP_URL = process.env['TEST_APP_DATABASE_URL'] ?? '';

export const hasTestDatabase = TEST_OWNER_URL !== '' && TEST_APP_URL !== '';

export const skipReason =
  'PULADO: defina TEST_MIGRATION_DATABASE_URL e TEST_APP_DATABASE_URL para os testes de API com banco.';

export const TEST_BASE_DOMAIN = 'plataforma.local';
export const TEST_MFA_KEY = Buffer.alloc(32, 3).toString('base64');

/**
 * Allowlist de origens da bancada.
 *
 * Precisa ser declarada: `loadConfig` recebe um ambiente EXPLICITO, e sem esta
 * chave `config.corsOrigins` nasce vazio — o ramo positivo do `originGuard`
 * (painel interno numa origem declarada) ficaria sem cobertura, e o teste que o
 * exercita falharia por construcao, em qualquer maquina e no CI.
 *
 * Sao dominios `.test` (RFC 2606): nao resolvem, nao existem e nao podem ser
 * registrados por ninguem.
 */
export const TEST_CORS_ORIGINS = ['https://organizer.test', 'https://admin.test'] as const;

export interface Harness {
  readonly app: Express;
  readonly pool: DbPool;
  readonly owner: DbPool;
  readonly config: AppConfig;
  /** Exposto para que o teste do limite inspecione e zere o estado. */
  readonly loginThrottle: LoginThrottle;
  close(): Promise<void>;
}

let migrated = false;

export interface HarnessOptions {
  /**
   * Aceitar `x-tenant-slug`. PADRAO true na bancada, porque os testes rodam
   * sem subdominio por comunidade — mesma razao do desenvolvimento local.
   *
   * Passe `false` para exercitar o comportamento de PRODUCAO, em que a
   * comunidade sai exclusivamente do dominio.
   */
  readonly tenantHeaderEnabled?: boolean;
  /**
   * Allowlist de origens. PADRAO `TEST_CORS_ORIGINS`.
   *
   * Passe `[]` para exercitar o comportamento de uma instalacao que nao
   * declarou nenhum painel interno — o guard continua estrito, e o unico
   * caminho de origem valida passa a ser o dominio de comunidade verificado.
   */
  readonly corsOrigins?: readonly string[];
  /**
   * Limite por origem.
   *
   * PADRAO praticamente ilimitado, de proposito: as outras suites disparam
   * dezenas de tentativas falhas para exercitar o bloqueio POR CONTA, e um
   * limite por origem realista as cortaria pela metade — o teste passaria a
   * medir o limitador em vez do que ele quer medir.
   *
   * A suite do proprio limite passa valores pequenos e explicitos.
   */
  readonly originLimits?: {
    readonly windowMinutes?: number;
    readonly maxFailures?: number;
    readonly maxAccounts?: number;
  };
  /**
   * Ambiente da aplicacao. PADRAO 'test'.
   *
   * Existe para que a recusa do endpoint de pagamento de desenvolvimento seja
   * exercitada com um `NODE_ENV` REAL de producao, e nao com um dublê. Um
   * teste que apenas invoca a funcao guarda nao provaria que a rota montada
   * recusa — e e a rota que precisa recusar.
   */
  readonly nodeEnv?: 'development' | 'test' | 'staging' | 'production';
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  if (!migrated) {
    await migrate(TEST_OWNER_URL);
    migrated = true;
  }

  const config = loadConfig({
    NODE_ENV: options.nodeEnv ?? 'test',
    DATABASE_URL: TEST_APP_URL,
    MFA_ENCRYPTION_KEY: TEST_MFA_KEY,
    APP_BASE_DOMAIN: TEST_BASE_DOMAIN,
    TENANT_HEADER_ENABLED:
      options.nodeEnv === 'production' ? 'false' : (options.tenantHeaderEnabled ?? true) ? 'true' : 'false',
    CORS_ORIGINS: (options.corsOrigins ?? TEST_CORS_ORIGINS).join(','),
    // producao e staging recusam cookie sem Secure; a bancada respeita a regra
    SESSION_COOKIE_SECURE:
      options.nodeEnv === 'production' || options.nodeEnv === 'staging' ? 'true' : 'false',
    LOGIN_MAX_ATTEMPTS: '5',
    LOGIN_LOCK_MINUTES: '15',
    LOGIN_ORIGIN_WINDOW_MINUTES: String(options.originLimits?.windowMinutes ?? 15),
    LOGIN_ORIGIN_MAX_FAILURES: String(options.originLimits?.maxFailures ?? 1_000_000),
    LOGIN_ORIGIN_MAX_ACCOUNTS: String(options.originLimits?.maxAccounts ?? 1_000_000),
  });

  const pool = createPool({ connectionString: TEST_APP_URL, applicationName: 'test-api', max: 5 });
  const owner = createPool({
    connectionString: TEST_OWNER_URL,
    applicationName: 'test-api-owner',
    max: 5,
  });

  const loginThrottle = new LoginThrottle({
    windowMs: config.LOGIN_ORIGIN_WINDOW_MINUTES * 60_000,
    maxFailures: config.LOGIN_ORIGIN_MAX_FAILURES,
    maxDistinctAccounts: config.LOGIN_ORIGIN_MAX_ACCOUNTS,
  });

  const app = createApp({ config, pool, secretBox: new SecretBox(TEST_MFA_KEY), loginThrottle });

  return {
    app,
    pool,
    owner,
    config,
    loginThrottle,
    async close() {
      await pool.end();
      await owner.end();
    },
  };
}

export function unique(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export interface SeededAccount {
  readonly userId: string;
  readonly email: string;
  readonly password: string;
}

/** Cria usuario com credencial utilizavel no login real. */
export async function seedAccount(
  owner: DbPool,
  input: { email?: string; displayName?: string; password?: string } = {},
): Promise<SeededAccount> {
  const email = (input.email ?? `${unique('user-')}@example.com`).toLowerCase();
  const password = input.password ?? 'Senha-De-Teste-2026!';
  const displayName = input.displayName ?? 'Pessoa de Teste';

  const { rows } = await owner.query<{ id: string }>(
    'INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id',
    [email, displayName],
  );
  const userId = rows[0]!.id;

  await owner.query('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [
    userId,
    await hashPassword(password),
  ]);

  return { userId, email, password };
}

export async function seedTenantWithSlug(
  owner: DbPool,
  slug: string,
  name = 'Comunidade de Teste',
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
    [slug, name],
  );
  const tenantId = rows[0]!.id;
  await owner.query('INSERT INTO tenant_branding (tenant_id, public_name) VALUES ($1, $2)', [
    tenantId,
    name,
  ]);
  return tenantId;
}

export async function grantMembership(
  owner: DbPool,
  input: { tenantId: string; userId: string; role: string },
): Promise<void> {
  await owner.query(
    `INSERT INTO memberships (tenant_id, user_id, role, accepted_at)
     VALUES ($1, $2, $3::membership_role, now())`,
    [input.tenantId, input.userId, input.role],
  );
}

export async function grantPlatformRole(
  owner: DbPool,
  input: { userId: string; role: string },
): Promise<void> {
  await owner.query(
    'INSERT INTO platform_admins (user_id, role) VALUES ($1, $2::platform_role)',
    [input.userId, input.role],
  );
}

/** Cadastra um fator TOTP JA confirmado, devolvendo o segredo em claro. */
export async function seedConfirmedTotp(owner: DbPool, userId: string): Promise<string> {
  const { generateTotpSecret } = await import('../../src/lib/totp.js');
  const secret = generateTotpSecret();
  const box = new SecretBox(TEST_MFA_KEY);
  await owner.query(
    `INSERT INTO user_mfa_factors (user_id, factor_type, secret_encrypted, confirmed_at)
     VALUES ($1, 'TOTP', $2, now())`,
    [userId, box.encrypt(secret)],
  );
  return secret;
}

/** Codigo TOTP corrente para um segredo. */
export async function currentCode(secret: string): Promise<string> {
  const { generateSync } = await import('otplib');
  return generateSync({ strategy: 'totp', secret, digits: 6, period: 30 });
}

/** Extrai o cookie de sessao da resposta de login. */
export function sessionCookieFrom(res: request.Response, cookieName: string): string {
  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const found = cookies.find((cookie) => cookie.startsWith(`${cookieName}=`));
  if (!found) throw new Error('Resposta nao trouxe cookie de sessao.');
  return found.split(';')[0]!;
}

/** Faz login e devolve o cookie de sessao e o status retornado. */
export async function loginAs(
  harness: Harness,
  account: { email: string; password: string },
): Promise<{ cookie: string; status: string }> {
  const res = await request(harness.app)
    .post('/api/auth/login')
    .send({ email: account.email, password: account.password });

  if (res.status !== 200) {
    throw new Error(`login falhou: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    cookie: sessionCookieFrom(res, harness.config.SESSION_COOKIE_NAME),
    status: res.body.status as string,
  };
}

/**
 * Satisfaz o segundo fator e devolve o cookie ROTACIONADO.
 *
 * A elevacao troca o segredo portador da sessao (ver `rotateSessionToken`), de
 * modo que o cookie usado para chamar `/mfa/verify` morre nessa mesma chamada.
 * Reaproveitar o cookie antigo depois daqui e justamente o que o teste de
 * rotacao prova que nao funciona.
 */
export async function verifyMfa(
  harness: Harness,
  cookie: string,
  code: string,
): Promise<{ status: number; cookie: string; body: unknown }> {
  const res = await request(harness.app)
    .post('/api/auth/mfa/verify')
    .set('Cookie', cookie)
    .send({ code });

  return {
    status: res.status,
    body: res.body,
    cookie:
      res.status === 200 ? sessionCookieFrom(res, harness.config.SESSION_COOKIE_NAME) : cookie,
  };
}

/** Confirma o cadastro do segundo fator e devolve o cookie ROTACIONADO. */
export async function confirmMfaEnrollment(
  harness: Harness,
  cookie: string,
  code: string,
): Promise<{ status: number; cookie: string; body: unknown }> {
  const res = await request(harness.app)
    .post('/api/auth/mfa/enroll/confirm')
    .set('Cookie', cookie)
    .send({ code });

  return {
    status: res.status,
    body: res.body,
    cookie:
      res.status === 200 ? sessionCookieFrom(res, harness.config.SESSION_COOKIE_NAME) : cookie,
  };
}

/** Eventos `auth.*` de um usuario, lidos pela conexao de dono (RN11). */
export async function identityAuditActions(owner: DbPool, userId: string): Promise<string[]> {
  const { rows } = await owner.query<{ action: string }>(
    `SELECT action FROM audit_events
      WHERE actor_user_id = $1 AND tenant_id IS NULL AND action LIKE 'auth.%'
      ORDER BY occurred_at, action`,
    [userId],
  );
  return rows.map((row) => row.action);
}

/** Limpa dados entre suites, respeitando a imutabilidade da trilha (RN11). */
export async function cleanup(owner: DbPool): Promise<void> {
  const client = new Client(pgConnectionConfig(TEST_OWNER_URL));
  await client.connect();
  try {
    await client.query('DELETE FROM event_consumptions');
    await client.query('DELETE FROM outbox');
    await client.query('DELETE FROM sessions');
    await client.query('DELETE FROM user_mfa_factors');
    await client.query('DELETE FROM user_credentials');
    await client.query('DELETE FROM platform_admins');
    await client.query('DELETE FROM memberships');
    // ---------------------------------------------------------------------
    // Fase 2 · sorteios, reservas e pedidos.
    //
    // Precisa vir ANTES da limpeza de comunidades: `orders` e `draws`
    // referenciam a comunidade, e a remocao falharia na chave estrangeira.
    //
    // O gatilho `draw_numbers_protect_paid` (RN18) recusa DELETE de numero
    // PAGO — inclusive para o dono da tabela. E o comportamento correto: um
    // numero vendido nao some. Aqui ele e SUSPENSO por um instante, porque
    // limpar a base entre suites nao e a operacao que a regra protege.
    //
    // Isto nao enfraquece a RN18 em producao: desligar gatilho exige ser dono
    // da tabela, e nem `app_user` nem `app_worker` sao. A regra continua de pe
    // para todo caminho que a aplicacao percorre.
    // ---------------------------------------------------------------------
    await client.query('ALTER TABLE draw_numbers DISABLE TRIGGER draw_numbers_protect_paid');
    try {
      await client.query('DELETE FROM order_items');
      await client.query('DELETE FROM draw_numbers');
      await client.query('DELETE FROM orders');
      await client.query('DELETE FROM reservations');
      await client.query('DELETE FROM buyers');
      await client.query('DELETE FROM draws');
    } finally {
      await client.query('ALTER TABLE draw_numbers ENABLE TRIGGER draw_numbers_protect_paid');
    }
  } finally {
    await client.end();
  }
  void owner;
}
