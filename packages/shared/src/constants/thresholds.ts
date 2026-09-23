/**
 * Avisos de numeros restantes. Regra de produto (DOC-01 secao 11, RN18).
 *
 * "faltando X" = total_numbers - numeros PAGOS.
 * RESERVADO e CATIVO PENDENTE nunca contam como vendidos.
 */
export const DEFAULT_REMAINING_THRESHOLDS = [25, 10] as const;

export type DefaultThreshold = (typeof DEFAULT_REMAINING_THRESHOLDS)[number];
