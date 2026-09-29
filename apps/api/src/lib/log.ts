import { createLogger } from '@clubedarifa/logging';

/**
 * Logger da API: JSON, uma linha por evento, sem dado pessoal (o proprio logger
 * mascara e-mail, telefone e nome pelo nome do campo e omite segredos).
 *
 * Campos de correlacao: `request_id`, `tenant_id`, `event_id`. O `request_id` e o
 * mesmo devolvido no cabecalho `x-request-id`, entao uma linha de erro liga a
 * resposta que o cliente recebeu.
 */
export const log = createLogger({ base: { service: 'api' } });
