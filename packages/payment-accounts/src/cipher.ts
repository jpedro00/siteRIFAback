import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Cifragem das credenciais de pagamento (access token, refresh token, `code_verifier`).
 *
 * A chave e `PAYMENT_CREDENTIALS_KEY`, propria destas credenciais: nao e a chave do MFA.
 * O `aad` e autenticado junto com o texto: um segredo cifrado para a conta X nao decifra
 * quando copiado para a conta Y (ou para outro uso).
 *
 * Formato do resultado: [nonce 12 B][tag 16 B][texto cifrado].
 */
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class PaymentCredentialCipher {
  readonly #key: Buffer;
  readonly keyVersion: number;

  constructor(base64Key: string, keyVersion = 1) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== 32) {
      throw new Error('PAYMENT_CREDENTIALS_KEY precisa ter 32 bytes (AES-256) em base64.');
    }
    this.#key = key;
    this.keyVersion = keyVersion;
  }

  encrypt(plaintext: string, aad: string): Buffer {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
  }

  decrypt(payload: Buffer, aad: string): string {
    if (payload.length < NONCE_BYTES + TAG_BYTES) {
      throw new Error('Segredo cifrado com tamanho invalido.');
    }
    const nonce = payload.subarray(0, NONCE_BYTES);
    const tag = payload.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
    const ciphertext = payload.subarray(NONCE_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.#key, nonce);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}

/** AAD dos tokens: amarra o segredo a conta do vendedor a que ele pertence. */
export function tokenAad(provider: string, environment: string, providerAccountId: string): string {
  return `ppa:${provider}:${environment}:${providerAccountId}`;
}

/** AAD do `code_verifier` do PKCE. */
export const VERIFIER_AAD = 'oauth-state:code-verifier';
