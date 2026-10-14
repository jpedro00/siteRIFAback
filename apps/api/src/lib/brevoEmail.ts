import { log } from './log.js';
import type { PasswordResetMessage, PasswordResetNotifier } from './passwordResetNotifier.js';

/**
 * Entrega por e-mail via API HTTPS da Brevo.
 *
 * POR QUE API E NAO SMTP: o Render gratuito bloqueia saida SMTP; HTTPS passa. Nenhuma
 * dependencia nova: usa o `fetch` do Node.
 *
 * O QUE NUNCA SAI DAQUI: o token completo e o e-mail do destinatario nao vao para log. Em
 * falha registra-se so o status HTTP e a duracao, para a lacuna ser observavel.
 */
export interface BrevoEmailOptions {
  readonly apiKey: string;
  readonly fromAddress: string;
  readonly fromName: string;
  readonly platformName?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

function escapeHtml(valor: string): string {
  return valor.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function buildPasswordResetEmail(message: PasswordResetMessage, platformName: string) {
  const minutos = Math.max(1, Math.round((message.expiresAt.getTime() - Date.now()) / 60_000));
  const nome = message.displayName.trim() || 'olá';
  const assunto = `${platformName}: redefina a sua senha`;
  const texto = [
    `Olá, ${nome}.`,
    '',
    `Recebemos um pedido para redefinir a senha da sua conta no ${platformName}.`,
    `Use o link abaixo (vale por ${minutos} minutos e só pode ser usado uma vez):`,
    '',
    message.resetUrl ?? '',
    '',
    'Se você não pediu isso, ignore este e-mail: a sua senha continua a mesma.',
    'Nunca enviamos a sua senha por e-mail.',
  ].join('\n');
  const html =
    `<p>Olá, ${escapeHtml(nome)}.</p>` +
    `<p>Recebemos um pedido para redefinir a senha da sua conta no ${escapeHtml(platformName)}.</p>` +
    `<p><a href="${escapeHtml(message.resetUrl ?? '')}">Redefinir minha senha</a></p>` +
    `<p>O link vale por ${minutos} minutos e só pode ser usado uma vez.</p>` +
    `<p>Se você não pediu isso, ignore este e-mail: a sua senha continua a mesma. Nunca enviamos a sua senha por e-mail.</p>`;
  return { assunto, texto, html };
}

export function createBrevoPasswordResetNotifier(options: BrevoEmailOptions): PasswordResetNotifier {
  const doFetch = options.fetchImpl ?? fetch;
  const platformName = options.platformName ?? 'Clube da Rifa';

  return {
    async send(message) {
      if (!message.resetUrl) {
        // Sem PASSWORD_RESET_URL nao ha link a entregar: melhor registrar do que enviar e-mail vazio.
        log.warn('recuperacao de senha sem PASSWORD_RESET_URL: e-mail nao enviado');
        return;
      }
      const { assunto, texto, html } = buildPasswordResetEmail(message, platformName);
      const inicio = Date.now();
      try {
        const res = await doFetch(ENDPOINT, {
          method: 'POST',
          headers: { 'api-key': options.apiKey, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            sender: { name: options.fromName, email: options.fromAddress },
            to: [{ email: message.email, name: message.displayName }],
            subject: assunto,
            textContent: texto,
            htmlContent: html,
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
        });
        if (!res.ok) {
          log.warn('recuperacao de senha: provedor de e-mail recusou o envio', {
            status: res.status,
            duration_ms: Date.now() - inicio,
          });
        }
      } catch (error) {
        log.warn('recuperacao de senha: falha ao falar com o provedor de e-mail', {
          reason: error instanceof Error ? error.name : 'desconhecido',
          duration_ms: Date.now() - inicio,
        });
      }
    },
  };
}
