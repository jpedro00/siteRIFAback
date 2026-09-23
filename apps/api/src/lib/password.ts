import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Hash de senha com scrypt (node:crypto).
 *
 * Por que scrypt e nao bcrypt/argon2: os dois exigem binario nativo, que quebra
 * com frequencia em Windows e em imagens de CI enxutas. scrypt e uma KDF com
 * custo de memoria, faz parte do proprio Node (mantido pelo runtime, sem
 * dependencia de terceiros) e e recomendada pelo OWASP para senha.
 *
 * Os parametros ficam gravados DENTRO do hash, de forma que aumentar o custo
 * mais tarde nao invalida as senhas ja existentes nem exige migration.
 *
 * Formato: scrypt$N$r$p$<salt base64>$<hash base64>
 */
export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, keylen: 32 } as const;

const MAXMEM_MULTIPLIER = 4;

function maxmemFor(N: number, r: number): number {
  return MAXMEM_MULTIPLIER * 128 * N * r;
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length === 0) {
    throw new Error('Senha vazia nao pode ser usada.');
  }
  const { N, r, p, keylen } = SCRYPT_PARAMS;
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, keylen, { N, r, p, maxmem: maxmemFor(N, r) });
  return [
    'scrypt',
    String(N),
    String(r),
    String(p),
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Compara a senha com o hash gravado.
 *
 * A comparacao final usa timingSafeEqual: comparar com `===` vaza, pelo tempo,
 * quantos bytes iniciais coincidem.
 *
 * Nunca lanca por hash malformado — devolve false. Um erro aqui distinguiria
 * "conta sem credencial valida" de "senha errada" para quem esta tentando.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N <= 1 || r <= 0 || p <= 0) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64');
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const derived = await scrypt(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: maxmemFor(N, r),
    });
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
