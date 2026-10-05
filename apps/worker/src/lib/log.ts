import { createLogger } from '@clubedarifa/logging';

/**
 * Logger do worker: JSON, uma linha por evento, sem dado pessoal.
 *
 * Campos de correlacao esperados: `job`, `event_id`, `tenant_id`, `draw_id`. O
 * `service` distingue a linha do worker da da API no mesmo agregador de logs.
 */
export const log = createLogger({ base: { service: 'worker' } });
