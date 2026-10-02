import { createHash, randomBytes } from 'node:crypto';

/**
 * Token de convite. Vai no link que quem convida entrega por fora (nao ha envio
 * de e-mail nesta fase). SO O HASH e gravado: quem ler a tabela `invitations` nao
 * consegue aceitar convite alheio.
 *
 * 32 bytes aleatorios = 256 bits: nao ha o que adivinhar, entao nao ha necessidade
 * de comparacao em tempo constante — a busca e por igualdade do hash inteiro.
 */
export function generateInviteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashInviteToken(token) };
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** "maria@exemplo.com" -> "m***@exemplo.com", para trilha e log. */
export function maskEmail(email: string): string {
  const arroba = email.lastIndexOf('@');
  return arroba < 1 ? '***' : `${email.slice(0, 1)}***${email.slice(arroba)}`;
}
