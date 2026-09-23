import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Token de sessao opaco.
 *
 * O cliente recebe 32 bytes aleatorios em base64url, dentro de um cookie
 * httpOnly. O banco guarda somente o SHA-256 do token.
 *
 * Por que token opaco e nao JWT: a fase exige logout e REVOGACAO. Um JWT
 * autocontido continua valendo ate expirar — revogar exigiria uma lista de
 * bloqueio, ou seja, exatamente a consulta ao banco que o JWT pretendia
 * evitar. Com sessao no banco, revogar tem efeito na requisicao seguinte.
 *
 * Por que guardar o hash e nao o token: um vazamento da tabela `sessions` nao
 * entrega sessoes utilizaveis. SHA-256 sem salt basta aqui porque o token ja e
 * aleatorio de 256 bits — nao ha espaco de busca para ataque de dicionario.
 */
export const SESSION_TOKEN_BYTES = 32;

export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Comparacao em tempo constante, para os pontos que comparam em memoria. */
export function sessionTokenMatches(token: string, expectedHash: Buffer): boolean {
  const actual = hashSessionToken(token);
  if (actual.length !== expectedHash.length) return false;
  return timingSafeEqual(actual, expectedHash);
}
