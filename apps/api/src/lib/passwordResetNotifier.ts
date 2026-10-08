import { log } from './log.js';

/**
 * Entrega do token de recuperacao de senha.
 *
 * DESACOPLADA de proposito: o projeto ainda nao tem provedor de e-mail. O dominio (token,
 * hash, expiracao, uso unico, revogacao de sessoes) funciona sem ele; o que falta em
 * producao e uma implementacao desta interface ligada a um provedor real (SMTP, Resend,
 * SES...) e injetada em `createApp`.
 *
 * O token NUNCA vai para log, auditoria ou resposta da API. So esta interface o recebe.
 */
export interface PasswordResetMessage {
  readonly email: string;
  readonly displayName: string;
  /** Token em texto claro; so existe aqui e na mensagem entregue. */
  readonly token: string;
  readonly expiresAt: Date;
  /** Link pronto (`<PASSWORD_RESET_URL>#token=...`) ou nulo se a URL nao foi configurada. */
  readonly resetUrl: string | null;
}

export interface PasswordResetNotifier {
  send(message: PasswordResetMessage): Promise<void>;
}

/**
 * Padrao enquanto nao houver provedor: registra que o pedido existiu e que nao ha como
 * entregar, SEM o token e SEM o e-mail. Assim a lacuna aparece em log, em vez de uma
 * recuperacao que parece funcionar e nunca chega a ninguem.
 */
export const undeliverablePasswordResetNotifier: PasswordResetNotifier = {
  async send() {
    log.warn('recuperacao de senha sem provedor de e-mail configurado: token nao entregue');
  },
};
