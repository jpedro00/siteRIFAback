/**
 * Grade de numeros - constantes protegidas.
 * Regra de produto (DOC-01 secao 4 passo 3, secao 18 e RN13).
 *
 * Nomes de coluna fixos, preservados literalmente:
 * number_count, total_numbers, label_digits.
 */

/** Tamanhos de grade permitidos. RN13. */
export const ALLOWED_GRID_SIZES = [100, 500, 1000] as const;

export type GridSize = (typeof ALLOWED_GRID_SIZES)[number];

/** label_digits por tamanho de grade: 2 para 100; 3 para 500 e 1000. RN13. */
export const LABEL_DIGITS_BY_GRID_SIZE: Readonly<Record<GridSize, 2 | 3>> = Object.freeze({
  100: 2,
  500: 3,
  1000: 3,
});

export function isAllowedGridSize(value: number): value is GridSize {
  return (ALLOWED_GRID_SIZES as readonly number[]).includes(value);
}

/**
 * Resolve label_digits a partir do tamanho da grade.
 * Lanca em vez de assumir um padrao: um label_digits errado gera rotulos
 * errados na grade inteira.
 */
export function labelDigitsForGridSize(gridSize: number): 2 | 3 {
  if (!isAllowedGridSize(gridSize)) {
    throw new RangeError(
      `Tamanho de grade invalido: ${gridSize}. Permitidos: ${ALLOWED_GRID_SIZES.join(', ')} (RN13).`,
    );
  }
  return LABEL_DIGITS_BY_GRID_SIZE[gridSize];
}

/**
 * Rotulo de um numero com zeros a esquerda. Regra de produto (DOC-01).
 * 100 -> 00..99 | 500 -> 000..499 | 1000 -> 000..999
 */
export function formatNumberLabel(value: number, labelDigits: 2 | 3): string {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`Numero invalido para rotulo: ${value}.`);
  }
  return String(value).padStart(labelDigits, '0');
}

/** Primeiro e ultimo rotulo de uma grade. Usado em previews e testes RN13. */
export function gridLabelRange(gridSize: GridSize): { first: string; last: string } {
  const digits = labelDigitsForGridSize(gridSize);
  return {
    first: formatNumberLabel(0, digits),
    last: formatNumberLabel(gridSize - 1, digits),
  };
}
