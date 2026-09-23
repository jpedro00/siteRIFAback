import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Cifragem dos segredos TOTP guardados em `user_mfa_factors.secret_encrypted`.
 *
 * AES-256-GCM com nonce aleatorio de 12 bytes. GCM e autenticado: um registro
 * adulterado falha na decifragem em vez de devolver lixo que passaria por
 * segredo valido.
 *
 * A chave vem do ambiente (MFA_ENCRYPTION_KEY) e nunca e gravada no banco.
 * Quem obtiver um dump do banco NAO consegue gerar codigos TOTP validos.
 *
 * Formato do bytea: [nonce 12B][tag 16B][ciphertext].
 */
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class SecretBox {
  readonly #key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== 32) {
      throw new Error('A chave de cifragem deve ter 32 bytes (AES-256).');
    }
    this.#key = key;
  }

  encrypt(plaintext: string): Buffer {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
  }

  decrypt(payload: Buffer): string {
    if (payload.length < NONCE_BYTES + TAG_BYTES) {
      throw new Error('Segredo cifrado com tamanho invalido.');
    }
    const nonce = payload.subarray(0, NONCE_BYTES);
    const tag = payload.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
    const ciphertext = payload.subarray(NONCE_BYTES + TAG_BYTES);

    const decipher = createDecipheriv('aes-256-gcm', this.#key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
