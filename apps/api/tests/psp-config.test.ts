import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

/**
 * Configuracao dos recebimentos (Fase 7). NAO existe token global do Mercado Pago: a API so
 * carrega o aplicativo OAuth da plataforma, a chave de cifragem das credenciais e o segredo do
 * webhook. Ligar o provedor pela metade e recusado na subida.
 */

const base = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://app_user:x@localhost:5432/qualquer',
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  APP_BASE_DOMAIN: 'clubedarifa.local',
};

const completo = {
  ...base,
  PSP_PROVIDER: 'mercadopago',
  MERCADOPAGO_WEBHOOK_SECRET: 'sec',
  MERCADOPAGO_OAUTH_CLIENT_ID: 'app-id',
  MERCADOPAGO_OAUTH_CLIENT_SECRET: 'app-secret',
  PAYMENT_CREDENTIALS_KEY: Buffer.alloc(32, 9).toString('base64'),
  PUBLIC_API_BASE_URL: 'https://api.exemplo.com/',
  ORGANIZER_PANEL_URL: 'https://painel.exemplo.com/',
};

describe('Recebimentos · configuracao', () => {
  it('padrao: nenhum provedor e nenhuma credencial exigida', () => {
    const config = loadConfig(base);
    expect(config.PSP_PROVIDER).toBe('none');
    expect(config.MERCADOPAGO_OAUTH_CLIENT_ID).toBeUndefined();
    expect(config.PAYMENT_CREDENTIALS_KEY).toBeUndefined();
  });

  it('mercadopago incompleto e recusado na carga, campo a campo', () => {
    expect(() => loadConfig({ ...base, PSP_PROVIDER: 'mercadopago' })).toThrow(/PSP_PROVIDER=mercadopago exige/);
    for (const faltando of [
      'MERCADOPAGO_WEBHOOK_SECRET',
      'MERCADOPAGO_OAUTH_CLIENT_ID',
      'MERCADOPAGO_OAUTH_CLIENT_SECRET',
      'PAYMENT_CREDENTIALS_KEY',
      'PUBLIC_API_BASE_URL',
      'ORGANIZER_PANEL_URL',
    ]) {
      const resto: Record<string, string> = { ...completo };
      delete resto[faltando];
      expect(() => loadConfig(resto), faltando).toThrow(/PSP_PROVIDER=mercadopago exige/);
    }
  });

  it('valor vazio conta como ausente (variavel declarada no Render sem valor)', () => {
    expect(() => loadConfig({ ...completo, MERCADOPAGO_OAUTH_CLIENT_SECRET: '   ' })).toThrow(/exige/);
    expect(() => loadConfig({ ...completo, PAYMENT_CREDENTIALS_KEY: '' })).toThrow(/exige/);
  });

  it('completo: normaliza as URLs e nao tem nenhum campo de token global', () => {
    const config = loadConfig(completo);
    expect(config.PUBLIC_API_BASE_URL).toBe('https://api.exemplo.com');
    expect(config.ORGANIZER_PANEL_URL).toBe('https://painel.exemplo.com');
    expect('MERCADOPAGO_ACCESS_TOKEN' in config).toBe(false);
  });

  it('a chave das credenciais: 32 bytes e diferente da chave do MFA', () => {
    expect(() => loadConfig({ ...completo, PAYMENT_CREDENTIALS_KEY: Buffer.alloc(16, 1).toString('base64') })).toThrow(
      /32 bytes/,
    );
    expect(() => loadConfig({ ...completo, PAYMENT_CREDENTIALS_KEY: base.MFA_ENCRYPTION_KEY })).toThrow(
      /nao pode ser igual a MFA_ENCRYPTION_KEY/,
    );
  });

  it('um token de acesso global na configuracao e ignorado (nao vira credencial)', () => {
    const config = loadConfig({ ...completo, MERCADOPAGO_ACCESS_TOKEN: 'APP_USR-global' } as Record<string, string>);
    expect(JSON.stringify(config)).not.toContain('APP_USR-global');
  });

  it('nao existe valor de configuracao que ligue o provedor FALSO', () => {
    expect(() => loadConfig({ ...base, PSP_PROVIDER: 'fake' })).toThrow();
    expect(() => loadConfig({ ...base, PSP_PROVIDER: 'FAKE' })).toThrow();
  });

  it('em staging e producao as URLs publicas precisam ser https', () => {
    const staging = {
      ...base,
      NODE_ENV: 'staging',
      SESSION_COOKIE_SECURE: 'true',
      CORS_ORIGINS: 'https://painel.exemplo.com',
      PUBLIC_API_BASE_URL: 'http://api.exemplo.com',
    };
    expect(() => loadConfig(staging)).toThrow(/https/);
    expect(() => loadConfig({ ...staging, PUBLIC_API_BASE_URL: 'https://api.exemplo.com' })).not.toThrow();
    expect(() => loadConfig({ ...completo, NODE_ENV: 'staging', SESSION_COOKIE_SECURE: 'true', CORS_ORIGINS: 'https://painel.exemplo.com', ORGANIZER_PANEL_URL: 'http://painel.exemplo.com' })).toThrow(/ORGANIZER_PANEL_URL/);
  });
});
