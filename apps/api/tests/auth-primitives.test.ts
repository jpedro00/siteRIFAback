import { describe, expect, it } from 'vitest';
import { generateSync } from 'otplib';
import { hashPassword, verifyPassword } from '../src/lib/password.js';
import { SecretBox } from '../src/lib/secretBox.js';
import {
  buildOtpauthUri,
  generateTotpSecret,
  verifyTotp,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
} from '../src/lib/totp.js';
import {
  generateSessionToken,
  hashSessionToken,
  sessionTokenMatches,
} from '../src/lib/sessionToken.js';

/**
 * Primitivas de autenticacao. RN12.
 *
 * Rodam sem banco: provam que a autenticacao e real, nao simulada.
 */

describe('senha · scrypt', () => {
  it('aceita a senha correta', async () => {
    const hash = await hashPassword('Senha-Muito-Forte-2026');
    expect(await verifyPassword('Senha-Muito-Forte-2026', hash)).toBe(true);
  });

  it('recusa a senha errada', async () => {
    const hash = await hashPassword('Senha-Muito-Forte-2026');
    expect(await verifyPassword('senha-muito-forte-2026', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('o hash nao contem a senha em claro', async () => {
    const hash = await hashPassword('Senha-Muito-Forte-2026');
    expect(hash).not.toContain('Senha-Muito-Forte-2026');
    expect(hash.startsWith('scrypt$')).toBe(true);
  });

  it('dois hashes da mesma senha sao diferentes (salt por credencial)', async () => {
    const a = await hashPassword('mesma-senha');
    const b = await hashPassword('mesma-senha');
    expect(a).not.toBe(b);
    expect(await verifyPassword('mesma-senha', a)).toBe(true);
    expect(await verifyPassword('mesma-senha', b)).toBe(true);
  });

  it('hash malformado devolve false em vez de lancar', async () => {
    for (const malformado of ['', 'nao-e-hash', 'scrypt$1$2$3', 'bcrypt$a$b$c$d$e']) {
      expect(await verifyPassword('qualquer', malformado)).toBe(false);
    }
  });

  it('os parametros de custo ficam gravados no proprio hash', async () => {
    const hash = await hashPassword('x');
    const [algorithm, N, r, p] = hash.split('$');
    expect(algorithm).toBe('scrypt');
    expect(Number(N)).toBeGreaterThanOrEqual(2 ** 14);
    expect(Number(r)).toBeGreaterThan(0);
    expect(Number(p)).toBeGreaterThan(0);
  });
});

describe('segundo fator · TOTP (RN12)', () => {
  const secret = generateTotpSecret();

  function currentToken(s: string): string {
    return generateSync({
      strategy: 'totp',
      secret: s,
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
    });
  }

  it('gera segredo utilizavel e valida o codigo corrente', () => {
    const result = verifyTotp({ token: currentToken(secret), secret });
    expect(result.valid).toBe(true);
    expect(typeof result.timeStep).toBe('number');
  });

  it('recusa codigo de outro segredo', () => {
    const outro = generateTotpSecret();
    const result = verifyTotp({ token: currentToken(outro), secret });
    expect(result.valid).toBe(false);
  });

  it('recusa formato invalido sem lancar', () => {
    for (const token of ['', '12345', '1234567', 'abcdef', '12 34 56']) {
      expect(verifyTotp({ token, secret }).valid).toBe(false);
    }
  });

  it('recusa REPLAY do mesmo codigo (afterTimeStep)', () => {
    const token = currentToken(secret);
    const first = verifyTotp({ token, secret });
    expect(first.valid).toBe(true);

    const replay = verifyTotp({ token, secret, afterTimeStep: first.timeStep });
    expect(replay.valid).toBe(false);
  });

  it('segredo malformado devolve false em vez de lancar', () => {
    expect(verifyTotp({ token: '123456', secret: '!!! nao e base32 !!!' }).valid).toBe(false);
  });

  it('a URI otpauth traz emissor, conta e segredo', () => {
    const uri = buildOtpauthUri({
      issuer: 'Campanhas',
      accountName: 'pessoa@example.com',
      secret,
    });
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('issuer=Campanhas');
  });
});

describe('cifragem do segredo TOTP', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const box = new SecretBox(key);

  it('cifra e decifra de volta', () => {
    const secret = generateTotpSecret();
    const encrypted = box.encrypt(secret);
    expect(encrypted).toBeInstanceOf(Buffer);
    expect(encrypted.toString('utf8')).not.toContain(secret);
    expect(box.decrypt(encrypted)).toBe(secret);
  });

  it('duas cifragens do mesmo segredo diferem (nonce aleatorio)', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(box.encrypt(secret).equals(box.encrypt(secret))).toBe(false);
  });

  it('registro adulterado falha na decifragem (AES-GCM e autenticado)', () => {
    const encrypted = box.encrypt('JBSWY3DPEHPK3PXP');
    const last = encrypted.length - 1;
    encrypted.writeUInt8(encrypted.readUInt8(last) ^ 0xff, last);
    expect(() => box.decrypt(encrypted)).toThrow();
  });

  it('chave diferente nao decifra', () => {
    const encrypted = box.encrypt('JBSWY3DPEHPK3PXP');
    const outra = new SecretBox(Buffer.alloc(32, 9).toString('base64'));
    expect(() => outra.decrypt(encrypted)).toThrow();
  });

  it('chave fora de 32 bytes e recusada na construcao', () => {
    expect(() => new SecretBox(Buffer.alloc(16).toString('base64'))).toThrow();
  });
});

describe('token de sessao', () => {
  it('gera token de alta entropia e diferente a cada chamada', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
    // 32 bytes em base64url.
    expect(Buffer.from(a, 'base64url').length).toBe(32);
  });

  it('o banco guarda o hash, nunca o token', () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    expect(hash.length).toBe(32);
    expect(hash.toString('base64url')).not.toBe(token);
  });

  it('a comparacao aceita o token certo e recusa o errado', () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    expect(sessionTokenMatches(token, hash)).toBe(true);
    expect(sessionTokenMatches(generateSessionToken(), hash)).toBe(false);
  });
});
