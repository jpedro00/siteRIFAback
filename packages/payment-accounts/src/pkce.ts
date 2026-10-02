import { createHash, randomBytes } from 'node:crypto';

/**
 * `state` e PKCE (RFC 7636) do fluxo OAuth.
 *
 *  - `state`: 32 bytes aleatorios. Sem tenant, usuario ou qualquer dado dentro: e so uma chave
 *    de busca. Vai ao banco como HASH.
 *  - `code_verifier`: 32 bytes aleatorios em base64url (43 caracteres). Fica cifrado no banco
 *    e so o backend o usa, na troca do codigo.
 *  - `code_challenge`: SHA-256 do verifier, em base64url (metodo S256).
 */
export function generateState(): string {
  return randomBytes(32).toString('base64url');
}

export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function codeChallengeFor(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

/** O que o banco guarda do `state`: o hash, nunca o valor. */
export function hashState(state: string): Buffer {
  return createHash('sha256').update(state, 'utf8').digest();
}
