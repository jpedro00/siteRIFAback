import { generateSecret, generateURI, verifySync } from 'otplib';

/**
 * Segundo fator TOTP (RFC 6238). RN12.
 *
 * Biblioteca: `otplib` v13, mantida, TypeScript-first e sem binario nativo.
 * Compativel com Google Authenticator, Authy, 1Password e Microsoft
 * Authenticator.
 *
 * Tolerancia de relogio: 30 s para cada lado (uma janela), o bastante para
 * absorver relogio dessincronizado sem alargar o intervalo aceito.
 */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Em SEGUNDOS, conforme a API do otplib. 30 s = uma janela para cada lado. */
export const TOTP_EPOCH_TOLERANCE_SECONDS = 30;

export function generateTotpSecret(): string {
  return generateSecret();
}

/** URI `otpauth://` para o QR Code do aplicativo autenticador. */
export function buildOtpauthUri(input: {
  issuer: string;
  accountName: string;
  secret: string;
}): string {
  return generateURI({
    strategy: 'totp',
    issuer: input.issuer,
    label: input.accountName,
    secret: input.secret,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
  });
}

export interface TotpVerification {
  readonly valid: boolean;
  /**
   * Passo de tempo em que o codigo bateu. Gravado em
   * `user_mfa_factors.last_used_step` e devolvido na verificacao seguinte como
   * `afterTimeStep`, o que impede REPLAY: um codigo ja aceito nao vale de novo.
   */
  readonly timeStep: number | null;
}

/**
 * Verifica um codigo TOTP.
 *
 * `afterTimeStep` e a protecao de replay da propria biblioteca: passos menores
 * ou iguais ao ultimo aceito sao recusados. Sem isso, um codigo interceptado
 * poderia ser reapresentado dentro dos mesmos 30 s.
 */
export function verifyTotp(input: {
  token: string;
  secret: string;
  afterTimeStep?: number | null;
}): TotpVerification {
  if (!/^[0-9]{6}$/.test(input.token)) {
    return { valid: false, timeStep: null };
  }

  try {
    const result = verifySync({
      strategy: 'totp',
      secret: input.secret,
      token: input.token,
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
      epochTolerance: TOTP_EPOCH_TOLERANCE_SECONDS,
      ...(input.afterTimeStep != null && input.afterTimeStep >= 0
        ? { afterTimeStep: input.afterTimeStep }
        : {}),
    });

    if (!result.valid) return { valid: false, timeStep: null };

    // `verifySync` do pacote raiz devolve o resultado de TOTP ou de HOTP; so o
    // de TOTP tem `timeStep`. Passamos strategy 'totp', entao o campo existe —
    // mas a checagem abaixo evita depender disso pela tipagem da uniao.
    return {
      valid: true,
      timeStep: 'timeStep' in result ? result.timeStep : null,
    };
  } catch {
    // Segredo malformado, parametro invalido ou passo fora de faixa nao podem
    // virar "aceito".
    return { valid: false, timeStep: null };
  }
}
