/**
 * Estados de cada numero da grade. Regra de produto (DOC-01 secao 8).
 *
 * Valores persistidos literalmente em portugues. "CATIVO PENDENTE" tem espaco:
 * `CATIVO_PENDENTE` no diagrama e apenas o identificador Mermaid.
 */
export const DRAW_NUMBER_STATUSES = [
  'LIVRE',
  'RESERVADO',
  'PENDENTE',
  'CATIVO PENDENTE',
  'PAGO',
  'ESTORNADO',
] as const;

export type DrawNumberStatus = (typeof DRAW_NUMBER_STATUSES)[number];

export function isDrawNumberStatus(value: unknown): value is DrawNumberStatus {
  return typeof value === 'string' && (DRAW_NUMBER_STATUSES as readonly string[]).includes(value);
}

/**
 * Transicoes permitidas. DOC-01 secao 8.
 *
 * ESTORNADO e terminal aqui. O DOC-01 registra, na mesma secao, uma nota de
 * que um numero estornado com sorteio ATIVA voltaria a LIVRE (S1). Essa volta
 * NAO e implementada como regra confirmada: e uma divergencia interna aberta
 * (C07 / S1) a resolver na fase de estornos.
 */
export const DRAW_NUMBER_STATUS_TRANSITIONS: Readonly<
  Record<DrawNumberStatus, readonly DrawNumberStatus[]>
> = Object.freeze({
  LIVRE: ['RESERVADO', 'CATIVO PENDENTE'],
  RESERVADO: ['LIVRE', 'PENDENTE'],
  PENDENTE: ['PAGO', 'LIVRE'],
  'CATIVO PENDENTE': ['PAGO', 'LIVRE'],
  PAGO: ['ESTORNADO'],
  ESTORNADO: [],
});

/**
 * Estados que contam como VENDIDO.
 * RN18 / DOC-01 secao 11: apenas PAGO. RESERVADO e CATIVO PENDENTE nunca
 * contam em progresso, thresholds ou relatorios.
 */
export const SOLD_NUMBER_STATUSES: readonly DrawNumberStatus[] = Object.freeze(['PAGO']);
