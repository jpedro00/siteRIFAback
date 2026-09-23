import type { ConnectionOptions } from 'node:tls';

/**
 * TLS das conexoes com o banco, num lugar so.
 *
 * O PROBLEMA QUE ISTO RESOLVE. A aplicacao abre conexao de varios pontos: o
 * pool da API, o pool do worker, os CLIs de bootstrap e migration, o instalador
 * da fila e o proprio pg-boss. Se a politica de TLS ficar repetida em cada
 * ponto, basta um divergir — e o que divergir sera, por definicao, aquele em
 * que ninguem reparou.
 *
 * `rejectUnauthorized` e SEMPRE true. O que este modulo decide e QUAIS RAIZES
 * sao aceitas, nunca se a verificacao acontece.
 */

/** Parametros de TLS na URL. Tratados aqui, nunca repassados ao driver. */
const SSL_URL_PARAMS = ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat'];

const URL_PEDE_TLS = /[?&]sslmode=(require|prefer|verify-ca|verify-full)\b/;

/**
 * Conteudo PEM de `DATABASE_CA_CERT`, se houver.
 *
 * POR QUE UMA CA EXTRA E NECESSARIA. Provedores gerenciados costumam assinar o
 * certificado do banco com uma raiz PROPRIA, que nao vem na lista de CAs
 * publicas do Node — o Supabase usa a "Supabase Root 2021 CA". Sem informa-la,
 * a verificacao falha com `SELF_SIGNED_CERT_IN_CHAIN`.
 *
 * A tentacao, nesse ponto, e desligar a verificacao. Isso manteria a conexao
 * cifrada e jogaria fora a unica coisa que prova COM QUEM se esta falando — que
 * e precisamente o que um intermediario precisa. Num banco que carrega dados de
 * varias comunidades, nao e um detalhe de configuracao.
 *
 * O certificado da raiz e PUBLICO: nao e segredo, so nao e conhecido de
 * fabrica. Informa-lo custa uma variavel de ambiente e preserva a garantia.
 *
 * Aceita quebras de linha reais ou escapadas como `\n`: paineis de provedor
 * costumam achatar o valor numa unica linha, e um PEM achatado e invalido.
 */
function trustedCaCertificate(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pem = env['DATABASE_CA_CERT'];
  if (!pem || pem.trim() === '') return undefined;
  return pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
}

/** Opcoes de TLS para um cliente `pg`, ou `undefined` quando TLS nao se aplica. */
function sslOptions(
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): ConnectionOptions | undefined {
  if (!enabled) return undefined;
  const ca = trustedCaCertificate(env);
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
}

/**
 * Remove da URL os parametros de TLS.
 *
 * ESTA E A PARTE NAO OBVIA, e custou um diagnostico: ao receber
 * `connectionString` E `ssl`, o `pg` faz `Object.assign({}, config,
 * parse(connectionString))` — ou seja, o que vem da URL SOBRESCREVE o objeto
 * explicito. Um `?sslmode=require` na URL vira `ssl: {}` e APAGA a CA que
 * acabamos de passar. O sintoma e enganoso: a conexao falha com
 * `SELF_SIGNED_CERT_IN_CHAIN` mesmo com a CA correta configurada, como se ela
 * estivesse errada.
 *
 * Tirar o parametro da URL e deixar UMA fonte de verdade — o objeto `ssl` —
 * resolve de forma definitiva. A intencao da URL nao se perde: ela e lida
 * ANTES, por `wantsTls`.
 */
function stripSslParams(connectionString: string): string {
  const separador = connectionString.indexOf('?');
  if (separador === -1) return connectionString;

  const base = connectionString.slice(0, separador);
  const restantes = connectionString
    .slice(separador + 1)
    .split('&')
    .filter((par) => par !== '' && !SSL_URL_PARAMS.includes(par.split('=')[0]!.toLowerCase()));

  return restantes.length > 0 ? `${base}?${restantes.join('&')}` : base;
}

/** A URL pede TLS? */
function wantsTls(connectionString: string): boolean {
  return URL_PEDE_TLS.test(connectionString);
}

export interface PgConnectionConfig {
  readonly connectionString: string;
  readonly ssl?: ConnectionOptions;
}

/**
 * Configuracao de conexao pronta para o `pg`: URL sem parametros de TLS mais o
 * objeto `ssl` correspondente.
 *
 * TLS e ligado quando o chamador pede (`ssl: true`, vindo de `DATABASE_SSL`) OU
 * quando a propria URL pede. As duas fontes somam em vez de competir: uma URL
 * de provedor gerenciado ja traz `sslmode=require`, e esquecer `DATABASE_SSL`
 * nao pode virar conexao em texto claro.
 */
export function pgConnectionConfig(
  connectionString: string,
  options: { ssl?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): PgConnectionConfig {
  const enabled = (options.ssl ?? false) || wantsTls(connectionString);
  const ssl = sslOptions(enabled, env);
  return {
    connectionString: stripSslParams(connectionString),
    ...(ssl ? { ssl } : {}),
  };
}
