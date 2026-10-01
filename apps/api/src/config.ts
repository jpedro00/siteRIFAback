import { z } from 'zod';

/**
 * Configuracao da API.
 *
 * Toda variavel e validada na subida. Um segredo ausente derruba o processo em
 * vez de o sistema subir com um padrao inseguro.
 *
 * Nenhum segredo tem valor padrao embutido: credencial de banco e chave de
 * cifragem existem no ambiente ou o processo nao sobe (PROMPT_ASTRA, principio 9).
 */
const configSchema = z.object({
  /**
   * `staging` e um ambiente de primeira classe, nao um apelido de producao.
   *
   * Ele roda exposto na internet, com TLS e dados descartaveis. Separa-lo de
   * `production` permite afrouxar o que so faz sentido afrouxar num ambiente
   * sem dado real — hoje, apenas o seletor de comunidade por cabecalho — sem
   * abrir a mesma porta em producao.
   */
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  /** Conexao da API: papel RESTRITO app_user, nunca o dono do schema. */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL e obrigatoria.'),
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /**
   * Chave de cifragem dos segredos TOTP, 32 bytes em base64.
   * Gerar com: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   */
  MFA_ENCRYPTION_KEY: z
    .string()
    .min(1, 'MFA_ENCRYPTION_KEY e obrigatoria.')
    .refine((value) => {
      try {
        return Buffer.from(value, 'base64').length === 32;
      } catch {
        return false;
      }
    }, 'MFA_ENCRYPTION_KEY deve ser 32 bytes em base64.'),

  /** Dominio base das vitrines: {slug}.{APP_BASE_DOMAIN}. */
  APP_BASE_DOMAIN: z.string().min(1).default('clubedarifa.local'),

  /**
   * Aceitar o cabecalho `x-tenant-slug` para escolher a comunidade.
   *
   * PADRAO: DESLIGADO. O cabecalho e um seletor de comunidade controlado pelo
   * CLIENTE. Com ele ligado, qualquer requisicao, vinda de qualquer host,
   * escolhe a comunidade que quiser — e a promessa de que "dominio
   * desconhecido devolve 404" deixa de valer, porque o host passa a ser
   * irrelevante.
   *
   * Existe apenas para o desenvolvimento em localhost, onde os tres frontends
   * rodam sem subdominio por comunidade. Em producao fica desligado e a
   * comunidade sai exclusivamente do dominio.
   *
   * Ligar em producao e recusado na carga da configuracao (refine abaixo).
   */
  TENANT_HEADER_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /** Origens permitidas para os tres frontends, separadas por virgula. */
  CORS_ORIGINS: z.string().default(''),

  SESSION_COOKIE_NAME: z.string().default('clubedarifa_session'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  SESSION_COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /**
   * `SameSite` do cookie de sessao. PADRAO `lax`.
   *
   * POR QUE ISTO E CONFIGURAVEL, E NAO FIXO
   *
   * `lax` e o valor correto quando a vitrine e a API vivem no MESMO site — o
   * navegador manda o cookie e ainda barra POST vindo de outro site.
   *
   * Quando os frontends ficam num site e a API noutro (Vercel + Render, por
   * exemplo), TODA chamada e cross-site: com `lax`, o navegador simplesmente
   * NAO envia o cookie no `fetch`. O login pareceria funcionar — o `Set-Cookie`
   * chega — e toda requisicao seguinte voltaria 401. `none` e o unico valor que
   * descreve honestamente essa topologia.
   *
   * O QUE SUBSTITUI A PROTECAO QUE `lax` DAVA
   *
   * `SameSite` nunca foi a unica defesa aqui. O `originGuard` recusa com 403,
   * ANTES do handler, qualquer requisicao com `Origin` fora da allowlist — e
   * `Origin` e posto pelo navegador e nao pode ser forjado por pagina. Essa
   * verificacao vale para toda rota, inclusive as de escrita, e nao depende de
   * `SameSite` nenhum. Trocar para `none` troca um mecanismo por outro que ja
   * estava de pe, e nao remove a defesa.
   *
   * `none` SEM `Secure` e recusado na carga da configuracao: o proprio
   * navegador descarta esse cookie, entao aceitar a combinacao produziria um
   * sistema que nao autentica e nao diz por que.
   */
  SESSION_COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  /** Bloqueio por tentativas de login, POR CONTA. */
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),

  /**
   * Limite por ORIGEM, aplicado antes da autenticacao.
   *
   * Defende a plataforma de uma origem que ataca MUITAS contas — o bloqueio por
   * conta, sozinho, torna barato trancar contas alheias. Ver
   * `lib/loginThrottle.ts`.
   */
  LOGIN_ORIGIN_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  LOGIN_ORIGIN_MAX_FAILURES: z.coerce.number().int().positive().default(20),
  LOGIN_ORIGIN_MAX_ACCOUNTS: z.coerce.number().int().positive().default(5),

  /** Emissor exibido no aplicativo autenticador. */
  MFA_ISSUER: z.string().default('Clube da Rifa'),

  /**
   * Provedor de pagamento (PIX). `none` = nenhum: o pedido e criado, mas nao ha
   * como gerar a cobranca. E o padrao — e o estado de STAGING enquanto as
   * credenciais sandbox nao existirem.
   *
   * O provedor FALSO dos testes nao e uma opcao aqui: nenhuma variavel de
   * ambiente o liga em ambiente real.
   *
   * As credenciais moram em variavel de ambiente (ou no cofre do Render), nunca
   * no codigo nem no banco. Valor vazio conta como ausente: um Render com a
   * variavel declarada e sem valor nao pode ligar o provedor pela metade.
   */
  PSP_PROVIDER: z.enum(['none', 'mercadopago']).default('none'),
  MERCADOPAGO_WEBHOOK_SECRET: z.string().optional().transform((v) => (v?.trim() ? v.trim() : undefined)),
  /**
   * NAO existe access token global do Mercado Pago. Cada comunidade conecta a PROPRIA conta por
   * OAuth; o que a plataforma tem e a APLICACAO (client id + secret, para o OAuth) e o segredo
   * de ASSINATURA do webhook (`MERCADOPAGO_WEBHOOK_SECRET`, da aplicacao, um so para todas).
   */
  MERCADOPAGO_OAUTH_CLIENT_ID: z.string().optional().transform((v) => (v?.trim() ? v.trim() : undefined)),
  MERCADOPAGO_OAUTH_CLIENT_SECRET: z.string().optional().transform((v) => (v?.trim() ? v.trim() : undefined)),
  /**
   * Chave (base64, 32 bytes) que cifra as credenciais de pagamento no banco. PROPRIA: nao e a do
   * MFA (`MFA_ENCRYPTION_KEY`) — vazar uma nao abre a outra.
   */
  PAYMENT_CREDENTIALS_KEY: z.string().optional().transform((v) => (v?.trim() ? v.trim() : undefined)),
  /** URL do painel do organizador (sem barra final): para onde o retorno do OAuth redireciona. */
  ORGANIZER_PANEL_URL: z.string().optional().transform((v) => (v?.trim() ? v.trim().replace(/\/+$/, '') : undefined)),
  /** E-mail usado quando o comprador nao informou o dele; o Mercado Pago exige um. */
  MERCADOPAGO_FALLBACK_PAYER_EMAIL: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : undefined)),
  /** URL publica da API, para montar o endereco do webhook entregue ao PSP. */
  PUBLIC_API_BASE_URL: z.string().optional().transform((v) => (v?.trim() ? v.trim().replace(/\/+$/, '') : undefined)),

  /**
   * Cobranca da PLATAFORMA (assinaturas SaaS, Stripe). Fase 7 · FLUXO A.
   * Independente do PSP dos sorteios (`PSP_PROVIDER`): sao contas, credenciais e
   * webhooks diferentes, e nunca se misturam.
   *
   * `none` = desligado (padrao): o webhook nao existe (404), contratar e abrir o portal
   * respondem `BILLING_UNAVAILABLE`, e a leitura da assinatura local segue funcionando.
   *
   * Chave `sk_live_` so em producao. Em desenvolvimento e staging, sempre `sk_test_`.
   */
  BILLING_PROVIDER: z.enum(['none', 'stripe']).default('none'),
  STRIPE_SECRET_KEY: z.string().optional().transform((v) => (v?.trim() ? v.trim() : undefined)),
  STRIPE_WEBHOOK_SECRET: z.string().optional().transform((v) => (v?.trim() ? v.trim() : undefined)),
  /** URL do painel do organizador: para onde a Stripe devolve a pessoa (sem barra final). */
  BILLING_RETURN_URL: z.string().optional().transform((v) => (v?.trim() ? v.trim().replace(/\/+$/, '') : undefined)),
});

export type AppConfig = Readonly<z.infer<typeof configSchema>> & {
  readonly corsOrigins: readonly string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema
    .refine(
      (value) => !(value.NODE_ENV === 'production' && value.TENANT_HEADER_ENABLED),
      {
        message:
          'TENANT_HEADER_ENABLED nao pode ser true em producao: o cabecalho deixaria o cliente escolher a comunidade, ignorando o dominio.',
        path: ['TENANT_HEADER_ENABLED'],
      },
    )
    .refine((value) => !(value.SESSION_COOKIE_SAMESITE === 'none' && !value.SESSION_COOKIE_SECURE), {
      message:
        'SESSION_COOKIE_SAMESITE=none exige SESSION_COOKIE_SECURE=true: o navegador DESCARTA um cookie SameSite=None sem Secure, e a sessao nunca chegaria a existir.',
      path: ['SESSION_COOKIE_SAMESITE'],
    })
    .refine(
      (value) =>
        !(
          (value.NODE_ENV === 'production' || value.NODE_ENV === 'staging') &&
          !value.SESSION_COOKIE_SECURE
        ),
      {
        message:
          'SESSION_COOKIE_SECURE precisa ser true em staging e em producao: sem Secure o cookie de sessao viaja em texto claro.',
        path: ['SESSION_COOKIE_SECURE'],
      },
    )
    .refine(
      (value) =>
        value.PSP_PROVIDER !== 'mercadopago' ||
        (value.MERCADOPAGO_WEBHOOK_SECRET !== undefined &&
          value.PUBLIC_API_BASE_URL !== undefined &&
          value.MERCADOPAGO_OAUTH_CLIENT_ID !== undefined &&
          value.MERCADOPAGO_OAUTH_CLIENT_SECRET !== undefined &&
          value.PAYMENT_CREDENTIALS_KEY !== undefined &&
          value.ORGANIZER_PANEL_URL !== undefined),
      {
        message:
          'PSP_PROVIDER=mercadopago exige MERCADOPAGO_WEBHOOK_SECRET, PUBLIC_API_BASE_URL, MERCADOPAGO_OAUTH_CLIENT_ID, MERCADOPAGO_OAUTH_CLIENT_SECRET, PAYMENT_CREDENTIALS_KEY e ORGANIZER_PANEL_URL: sem o segredo do webhook nao ha como validar o aviso; sem o aplicativo OAuth e a chave de cifragem nao ha como conectar (nem guardar) a conta de ninguem. Nao existe token global.',
        path: ['PSP_PROVIDER'],
      },
    )
    .refine(
      (value) =>
        value.BILLING_PROVIDER !== 'stripe' ||
        (value.STRIPE_SECRET_KEY !== undefined &&
          value.STRIPE_WEBHOOK_SECRET !== undefined &&
          value.BILLING_RETURN_URL !== undefined),
      {
        message:
          'BILLING_PROVIDER=stripe exige STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET e BILLING_RETURN_URL: sem o segredo do webhook nao ha como validar os eventos, e sem a URL de retorno a Stripe nao sabe para onde devolver a pessoa.',
        path: ['BILLING_PROVIDER'],
      },
    )
    .refine(
      (value) => !(value.STRIPE_SECRET_KEY?.startsWith('sk_live_') && value.NODE_ENV !== 'production'),
      {
        message: 'Chave LIVE da Stripe (sk_live_...) so e aceita com NODE_ENV=production. Use sk_test_... aqui.',
        path: ['STRIPE_SECRET_KEY'],
      },
    )
    .refine(
      (value) =>
        !(
          (value.NODE_ENV === 'production' || value.NODE_ENV === 'staging') &&
          value.BILLING_RETURN_URL !== undefined &&
          !value.BILLING_RETURN_URL.startsWith('https://')
        ),
      {
        message: 'BILLING_RETURN_URL precisa ser https:// em staging e em producao.',
        path: ['BILLING_RETURN_URL'],
      },
    )
    .refine(
      (value) =>
        value.PAYMENT_CREDENTIALS_KEY === undefined ||
        Buffer.from(value.PAYMENT_CREDENTIALS_KEY, 'base64').length === 32,
      { message: 'PAYMENT_CREDENTIALS_KEY precisa ser uma chave de 32 bytes em base64.', path: ['PAYMENT_CREDENTIALS_KEY'] },
    )
    .refine(
      (value) =>
        value.PAYMENT_CREDENTIALS_KEY === undefined ||
        value.PAYMENT_CREDENTIALS_KEY !== value.MFA_ENCRYPTION_KEY,
      { message: 'PAYMENT_CREDENTIALS_KEY nao pode ser igual a MFA_ENCRYPTION_KEY: cada segredo tem a sua chave.', path: ['PAYMENT_CREDENTIALS_KEY'] },
    )
    .refine(
      (value) =>
        !(
          (value.NODE_ENV === 'production' || value.NODE_ENV === 'staging') &&
          value.ORGANIZER_PANEL_URL !== undefined &&
          !value.ORGANIZER_PANEL_URL.startsWith('https://')
        ),
      { message: 'ORGANIZER_PANEL_URL precisa ser https:// em staging e em producao.', path: ['ORGANIZER_PANEL_URL'] },
    )
    .refine(
      (value) =>
        !(
          (value.NODE_ENV === 'production' || value.NODE_ENV === 'staging') &&
          value.PUBLIC_API_BASE_URL !== undefined &&
          !value.PUBLIC_API_BASE_URL.startsWith('https://')
        ),
      {
        message: 'PUBLIC_API_BASE_URL precisa ser https:// em staging e em producao.',
        path: ['PUBLIC_API_BASE_URL'],
      },
    )
    .refine(
      (value) =>
        !(
          (value.NODE_ENV === 'production' || value.NODE_ENV === 'staging') &&
          value.CORS_ORIGINS.trim() === ''
        ),
      {
        message:
          'CORS_ORIGINS nao pode ficar vazio em staging nem em producao: sem allowlist, nenhum painel interno consegue falar com a API.',
        path: ['CORS_ORIGINS'],
      },
    )
    .safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuracao invalida:\n${issues}`);
  }

  const corsOrigins = parsed.data.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');

  return Object.freeze({ ...parsed.data, corsOrigins: Object.freeze(corsOrigins) });
}
