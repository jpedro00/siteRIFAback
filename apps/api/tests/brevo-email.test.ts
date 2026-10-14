import { describe, expect, it, vi } from 'vitest';
import { buildPasswordResetEmail, createBrevoPasswordResetNotifier } from '../src/lib/brevoEmail.js';
import { loadConfig } from '../src/config.js';

const TOKEN = 'tok_' + 'a'.repeat(40);
const mensagem = {
  email: 'pessoa@exemplo.com',
  displayName: 'Maria <script>',
  token: TOKEN,
  expiresAt: new Date(Date.now() + 30 * 60_000),
  resetUrl: `https://rifas.test/redefinir-senha#token=${TOKEN}`,
};

function criar(fetchImpl: typeof fetch) {
  return createBrevoPasswordResetNotifier({
    apiKey: 'chave-de-teste',
    fromAddress: 'no-reply@exemplo.com',
    fromName: 'Clube da Rifa',
    fetchImpl,
  });
}

describe('e-mail de recuperacao (Brevo)', () => {
  it('envia o link por HTTPS com a chave no cabecalho e o conteudo escapado', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 201 }));
    await criar(fetchImpl as unknown as typeof fetch).send(mensagem);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect((init.headers)['api-key']).toBe('chave-de-teste');
    const corpo = JSON.parse(init.body);
    expect(corpo.to).toEqual([{ email: 'pessoa@exemplo.com', name: 'Maria <script>' }]);
    expect(corpo.sender).toEqual({ name: 'Clube da Rifa', email: 'no-reply@exemplo.com' });
    expect(corpo.textContent).toContain(mensagem.resetUrl);
    expect(corpo.htmlContent).toContain('Maria &lt;script&gt;');
    expect(corpo.htmlContent).not.toContain('<script>');
    expect(corpo.textContent).not.toMatch(/senha\s*:/i);
  });

  it('recusa do provedor ou queda de rede NAO derruba o pedido e nao vaza token nem e-mail no log', async () => {
    const linhas: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array) => {
      linhas.push(String(c));
      return true;
    }) as typeof process.stdout.write);
    try {
      await criar((async () => new Response('erro', { status: 401 })) as unknown as typeof fetch).send(mensagem);
      await criar((async () => {
        throw new Error(`falha com ${TOKEN} e pessoa@exemplo.com`);
      }) as unknown as typeof fetch).send(mensagem);
    } finally {
      spy.mockRestore();
    }
    const saida = linhas.join('');
    expect(saida).not.toContain(TOKEN);
    expect(saida).not.toContain('pessoa@exemplo.com');
  });

  it('sem PASSWORD_RESET_URL nao envia e-mail vazio', async () => {
    const fetchImpl = vi.fn();
    await criar(fetchImpl as unknown as typeof fetch).send({ ...mensagem, resetUrl: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('o texto informa a validade e nao contem senha', () => {
    const { assunto, texto } = buildPasswordResetEmail(mensagem, 'Clube da Rifa');
    expect(assunto).toContain('Clube da Rifa');
    expect(texto).toMatch(/30 minutos/);
    expect(texto).toContain('Nunca enviamos a sua senha');
  });

  it('configuracao: brevo exige chave e remetente', () => {
    const base = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x',
      MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      APP_BASE_DOMAIN: 'clubedarifa.local',
      CORS_ORIGINS: 'https://admin.test',
    };
    expect(() => loadConfig({ ...base, EMAIL_PROVIDER: 'brevo' })).toThrow(/BREVO_API_KEY/);
    const ok = loadConfig({ ...base, EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'k', EMAIL_FROM_ADDRESS: 'a@b.com' });
    expect(ok.EMAIL_PROVIDER).toBe('brevo');
    expect(loadConfig(base).EMAIL_PROVIDER).toBe('none');
  });
});
