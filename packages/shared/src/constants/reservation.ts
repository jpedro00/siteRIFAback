/**
 * Constantes protegidas de reserva.
 *
 * Regra de produto (DOC-01, introducao e RN05).
 *
 * O valor NAO e configuravel por ambiente: e uma constante de negocio,
 * protegida por teste (packages/shared/tests/protected-constants.test.ts).
 * Deixar o prazo de reserva atras de uma variavel de ambiente permitiria que
 * dois ambientes vendessem com regras diferentes, e o contador exibido ao
 * participante deixaria de corresponder ao prazo real.
 *
 * O D01 e o prompt geral supunham 10 minutos; o DOC-01 corrige explicitamente
 * para 30 (conflito C01, resolvido).
 */
export const RESERVATION_TTL_MINUTES = 30 as const;

/** DOC-01: reserva com preco promocional usa o mesmo prazo da reserva comum. */
export const PROMOTIONAL_RESERVATION_TTL_MINUTES = 30 as const;

/**
 * Retencao maxima de pre-autorizacao de cliente cativo, em horas.
 * Regra de produto (DOC-01 secoes 8 e 10, RN16).
 */
export const PREAUTHORIZATION_MAX_RETENTION_HOURS = 12 as const;
