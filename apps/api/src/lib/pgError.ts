/**
 * Reconhecimento de erros do PostgreSQL que sao, na verdade, respostas de
 * negocio.
 *
 * A CONSTRAINT E A AUTORIDADE. Verificar "ja existe?" com um SELECT antes do
 * INSERT nao impede a colisao: entre a leitura e a escrita cabe outra
 * transacao, e duas requisicoes simultaneas passam as duas pela verificacao.
 * Quem de fato garante a unicidade e o indice unico — e ele se manifesta como
 * um erro, no momento do INSERT.
 *
 * Por isso o SELECT previo continua existindo (responde o caso comum com uma
 * mensagem clara) e o erro do banco tambem e tratado (responde o caso raro, a
 * corrida). Traduzi-lo para 409 e o que impede que uma disputa legitima vire
 * 500 — um "erro interno" que nao houve.
 */

/** `unique_violation`, tabela 24 do manual do PostgreSQL. */
const UNIQUE_VIOLATION = '23505';

interface PgErrorShape {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

function asPgError(error: unknown): PgErrorShape | null {
  if (typeof error !== 'object' || error === null) return null;
  return error as PgErrorShape;
}

/**
 * O erro e violacao de unicidade?
 *
 * `constraintNames` restringe a verificacao as constraints esperadas. Sem esse
 * filtro, uma colisao em OUTRO indice — de uma coluna que o chamador nem sabia
 * estar envolvida — viraria a mesma mensagem de conflito, e o diagnostico real
 * se perderia atras de um 409 enganoso.
 */
export function isUniqueViolation(error: unknown, ...constraintNames: string[]): boolean {
  const pgError = asPgError(error);
  if (!pgError || pgError.code !== UNIQUE_VIOLATION) return false;
  if (constraintNames.length === 0) return true;
  return typeof pgError.constraint === 'string' && constraintNames.includes(pgError.constraint);
}
