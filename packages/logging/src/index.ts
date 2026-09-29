/**
 * Logs estruturados em JSON, uma linha por evento.
 *
 * DUAS REGRAS:
 *
 *  1. O log e correlacionavel: `request_id`, `tenant_id`, `event_id` e `job`
 *     entram como campos, para ligar a linha da requisicao a do worker e a do
 *     evento que a originou.
 *
 *  2. O log NAO carrega dado pessoal nem segredo. Campos com nome de e-mail,
 *     telefone, nome ou credencial sao MASCARADOS ou omitidos AQUI, na saida — nao
 *     dependem de cada chamador lembrar. E um cinto de seguranca: a disciplina
 *     de nao passar dado pessoal ao log continua sendo de quem escreve a linha.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDEM: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** "maria@example.com" -> "m***@example.com". */
export function maskEmail(valor: string): string {
  const arroba = valor.lastIndexOf('@');
  if (arroba < 1) return '***';
  return `${valor.slice(0, 1)}***${valor.slice(arroba)}`;
}

/** "+55 11 91234-5678" -> "***5678". Guarda so os 4 ultimos digitos. */
export function maskPhone(valor: string): string {
  const digitos = valor.replace(/\D/g, '');
  return digitos.length < 4 ? '***' : `***${digitos.slice(-4)}`;
}

/** "Maria Souza" -> "M*** S***". */
export function maskName(valor: string): string {
  return (
    valor
      .trim()
      .split(/\s+/)
      .filter((p) => p !== '')
      .map((p) => `${p.slice(0, 1)}***`)
      .join(' ') || '***'
  );
}

const SEGREDO = /pass(word)?|senha|secret|token|authorization|cookie|api[_-]?key|credential|signature/i;
const EMAIL = /e-?mail/i;
const TELEFONE = /phone|telefone|celular|whatsapp/i;
const NOME = /(^|_)(full_?)?name$|^nome$|buyer_?name|display_?name/i;

const PROFUNDIDADE_MAXIMA = 4;

/** Mascara/omite o que nao pode ir para o log. Devolve uma copia; nao altera a entrada. */
export function sanitize(valor: unknown, chave = '', profundidade = 0): unknown {
  if (valor === null || valor === undefined) return valor;

  if (SEGREDO.test(chave)) return '[redacted]';

  if (typeof valor === 'string') {
    if (EMAIL.test(chave)) return maskEmail(valor);
    if (TELEFONE.test(chave)) return maskPhone(valor);
    if (NOME.test(chave)) return maskName(valor);
    return valor;
  }

  if (typeof valor === 'bigint') return valor.toString();
  if (typeof valor === 'function' || typeof valor === 'symbol') return String(valor);
  if (typeof valor !== 'object') return valor;

  if (valor instanceof Error) {
    // So nome e mensagem: a pilha pode carregar valores de variaveis e o `cause`
    // pode ser um objeto de resposta de terceiro.
    return { name: valor.name, message: valor.message };
  }
  if (profundidade >= PROFUNDIDADE_MAXIMA) return '[profundo]';

  if (Array.isArray(valor)) return valor.map((item) => sanitize(item, chave, profundidade + 1));

  return Object.fromEntries(
    Object.entries(valor as Record<string, unknown>).map(([k, v]) => [
      k,
      sanitize(v, k, profundidade + 1),
    ]),
  );
}

export interface Logger {
  debug(msg: string, campos?: Record<string, unknown>): void;
  info(msg: string, campos?: Record<string, unknown>): void;
  warn(msg: string, campos?: Record<string, unknown>): void;
  error(msg: string, campos?: Record<string, unknown>): void;
  /** Novo logger com campos fixos adicionais (por exemplo `request_id`). */
  child(campos: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  /** Campos presentes em toda linha, como `service`. */
  readonly base?: Record<string, unknown>;
  /** Destino da linha. Padrao: stdout (info/debug) e stderr (warn/error). */
  readonly write?: (linha: string, nivel: LogLevel) => void;
  readonly level?: LogLevel;
}

function escreverPadrao(linha: string, nivel: LogLevel): void {
  if (nivel === 'error' || nivel === 'warn') console.error(linha);
  else console.log(linha);
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const minimo = ORDEM[options.level ?? 'info'];
  const escrever = options.write ?? escreverPadrao;

  function build(base: Record<string, unknown>): Logger {
    const emitir = (nivel: LogLevel, msg: string, campos?: Record<string, unknown>): void => {
      if (ORDEM[nivel] < minimo) return;
      const limpos = sanitize({ ...base, ...campos }) as Record<string, unknown>;
      // `ts`, `level` e `msg` sao do logger: um campo do chamador com esses nomes
      // nao os sobrescreve.
      delete limpos['ts'];
      delete limpos['level'];
      delete limpos['msg'];
      let linha: string;
      try {
        linha = JSON.stringify({ ts: new Date().toISOString(), level: nivel, msg, ...limpos });
      } catch {
        // Um campo impossivel de serializar nao pode derrubar quem esta logando.
        linha = JSON.stringify({ ts: new Date().toISOString(), level: nivel, msg, log_erro: 'campos nao serializaveis' });
      }
      escrever(linha, nivel);
    };
    return {
      debug: (m, c) => emitir('debug', m, c),
      info: (m, c) => emitir('info', m, c),
      warn: (m, c) => emitir('warn', m, c),
      error: (m, c) => emitir('error', m, c),
      child: (campos) => build({ ...base, ...campos }),
    };
  }

  return build(options.base ?? {});
}
