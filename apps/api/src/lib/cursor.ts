import { ApiError } from './apiError.js';

/**
 * Cursor de paginacao por CHAVE (keyset), opaco para quem o recebe.
 *
 * Por que keyset e nao OFFSET: com `OFFSET`, um registro novo no topo empurra a
 * lista e a pagina seguinte repete (ou pula) linhas; e o custo cresce com a
 * pagina. Keyset pergunta "o que vem DEPOIS desta chave", e a resposta e estavel
 * e usa o indice.
 *
 * O instante viaja como TEXTO do PostgreSQL (`created_at::text`), nao como `Date`
 * do JavaScript: o banco guarda microssegundos e o `Date` so tem milissegundos —
 * dois registros no mesmo milissegundo seriam confundidos e um deles sumiria da
 * lista.
 */

/** "2026-09-29 16:30:00.123456-03", que o proprio PostgreSQL le de volta. */
const INSTANTE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:[+-]\d{2}(?::\d{2})?|Z)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Keyset {
  /** Instante, em texto do PostgreSQL. */
  readonly t: string;
  readonly id: string;
  /** Faixa de ordenacao opcional (a vitrine poe as vendas abertas primeiro). */
  readonly b?: number;
}

export function encodeCursor(k: Keyset): string {
  const partes = k.b === undefined ? [k.t, k.id] : [String(k.b), k.t, k.id];
  return Buffer.from(partes.join('|'), 'utf8').toString('base64url');
}

/** Devolve `null` para "primeira pagina"; lanca 400 para cursor adulterado. */
export function decodeCursor(cursor: unknown, options: { banded?: boolean } = {}): Keyset | null {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  if (typeof cursor !== 'string' || cursor.length > 200) throw ApiError.badRequest('Cursor inválido.');

  let texto: string;
  try {
    texto = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw ApiError.badRequest('Cursor inválido.');
  }
  const partes = texto.split('|');
  const esperado = options.banded ? 3 : 2;
  if (partes.length !== esperado) throw ApiError.badRequest('Cursor inválido.');

  const id = partes[partes.length - 1]!;
  const t = partes[partes.length - 2]!;
  if (!UUID_RE.test(id) || !INSTANTE_RE.test(t)) throw ApiError.badRequest('Cursor inválido.');

  if (!options.banded) return { t, id };
  const b = Number(partes[0]);
  if (!Number.isInteger(b) || b < 0 || b > 9) throw ApiError.badRequest('Cursor inválido.');
  return { t, id, b };
}

/** `?limit=`: inteiro entre 1 e `max`; ausente ou invalido cai no padrao. */
export function parseLimit(raw: unknown, padrao = 50, max = 100): number {
  const n = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(n)) return padrao;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

/**
 * Corta a pagina: consultas pedem `limite + 1`; se o extra veio, ha proxima pagina
 * e o cursor e a chave da ULTIMA linha que cabe.
 */
export function paginate<T>(
  linhas: readonly T[],
  limite: number,
  chave: (linha: T) => Keyset,
): { pagina: T[]; nextCursor: string | null } {
  const temMais = linhas.length > limite;
  const pagina = temMais ? linhas.slice(0, limite) : [...linhas];
  const ultima = pagina[pagina.length - 1];
  return { pagina, nextCursor: temMais && ultima ? encodeCursor(chave(ultima)) : null };
}
