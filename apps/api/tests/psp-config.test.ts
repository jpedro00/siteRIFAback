import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createPspGateway } from '@clubedarifa/psp';

/**
 * Configuracao do provedor de pagamento. As credenciais vem de variavel de
 * ambiente, e ligar o provedor pela metade e recusado na subida — um processo
 * que sobe com o PIX "quase" configurado so revelaria o erro no primeiro cliente.
 */

const base = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://app_user:x@localhost:5432/qualquer',
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  APP_BASE_DOMAIN: 'clubedarifa.local',
};

describe('PSP · configuracao', () => {
  it('padrao: nenhum provedor, e nenhum gateway e criado', () => {
    const config = loadConfig(base);
    expect(config.PSP_PROVIDER).toBe('none');
    expect(createPspGateway(config)).toBeNull();
  });

  it('mercadopago sem credenciais ou sem URL publica e recusado na carga', () => {
    expect(() => loadConfig({ ...base, PSP_PROVIDER: 'mercadopago' })).toThrow(/MERCADOPAGO_ACCESS_TOKEN/);
    expect(() =>
      loadConfig({
        ...base,
        PSP_PROVIDER: 'mercadopago',
        MERCADOPAGO_ACCESS_TOKEN: 'tok',
        MERCADOPAGO_WEBHOOK_SECRET: 'sec',
      }),
    ).toThrow(/PUBLIC_API_BASE_URL/);
  });

  it('valor vazio conta como ausente (variavel declarada no Render sem valor)', () => {
    expect(() =>
      loadConfig({
        ...base,
        PSP_PROVIDER: 'mercadopago',
        MERCADOPAGO_ACCESS_TOKEN: '   ',
        MERCADOPAGO_WEBHOOK_SECRET: '',
        PUBLIC_API_BASE_URL: 'https://api.exemplo.com',
      }),
    ).toThrow(/MERCADOPAGO_ACCESS_TOKEN/);
  });

  it('mercadopago completo cria o gateway real', () => {
    const config = loadConfig({
      ...base,
      PSP_PROVIDER: 'mercadopago',
      MERCADOPAGO_ACCESS_TOKEN: 'tok',
      MERCADOPAGO_WEBHOOK_SECRET: 'sec',
      PUBLIC_API_BASE_URL: 'https://api.exemplo.com/',
    });
    expect(config.PUBLIC_API_BASE_URL).toBe('https://api.exemplo.com');
    expect(createPspGateway(config)?.provider).toBe('MERCADO_PAGO');
  });

  it('nao existe valor de configuracao que ligue o provedor FALSO', () => {
    expect(() => loadConfig({ ...base, PSP_PROVIDER: 'fake' })).toThrow();
    expect(() => loadConfig({ ...base, PSP_PROVIDER: 'FAKE' })).toThrow();
  });

  it('em staging e producao a URL publica precisa ser https', () => {
    const staging = {
      ...base,
      NODE_ENV: 'staging',
      SESSION_COOKIE_SECURE: 'true',
      CORS_ORIGINS: 'https://painel.exemplo.com',
      PUBLIC_API_BASE_URL: 'http://api.exemplo.com',
    };
    expect(() => loadConfig(staging)).toThrow(/https/);
    expect(() => loadConfig({ ...staging, PUBLIC_API_BASE_URL: 'https://api.exemplo.com' })).not.toThrow();
  });
});
