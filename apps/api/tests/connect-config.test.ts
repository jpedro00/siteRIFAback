import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { connectWebhookSecrets, createConnect } from '../src/modules/paymentAccounts/connectSetup.js';
import type { DbPool } from '@clubedarifa/db';

/**
 * Stripe Connect · configuracao. Desligado por padrao; ligar pela metade, com chave live fora de
 * producao ou com chave de modo diferente do ambiente e recusado na SUBIDA.
 *
 * Nenhuma chave real: so valores obviamente falsos.
 */

const base = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://app_user:x@localhost:5432/qualquer',
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  APP_BASE_DOMAIN: 'clubedarifa.local',
};
const connect = {
  CONNECT_ENABLED: 'true',
  STRIPE_SECRET_KEY: 'sk_test_fake_for_unit_tests',
  STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_test_fake_for_unit_tests',
  ORGANIZER_PANEL_URL: 'http://localhost:5174/',
};
const producao = {
  NODE_ENV: 'production',
  CORS_ORIGINS: 'https://painel.exemplo.test',
  SESSION_COOKIE_SECURE: 'true',
  ORGANIZER_PANEL_URL: 'https://painel.exemplo.test',
};

describe('Stripe Connect · configuracao', () => {
  it('padrao: desligado, e nenhum runtime e criado', () => {
    const config = loadConfig(base);
    expect(config.CONNECT_ENABLED).toBe(false);
    expect(config.STRIPE_CONNECT_WEBHOOK_SECRET).toBeUndefined();
    expect(createConnect(config, {} as DbPool)).toBeNull();
  });

  it('CONNECT_ENABLED=true sem chave, sem segredo do webhook ou sem URL do painel e recusado', () => {
    expect(() => loadConfig({ ...base, CONNECT_ENABLED: 'true' })).toThrow(/CONNECT_ENABLED=true exige/);
    expect(() => loadConfig({ ...base, ...connect, STRIPE_SECRET_KEY: '' })).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => loadConfig({ ...base, ...connect, STRIPE_CONNECT_WEBHOOK_SECRET: '   ' })).toThrow(
      /STRIPE_CONNECT_WEBHOOK_SECRET/,
    );
    expect(() => loadConfig({ ...base, ...connect, ORGANIZER_PANEL_URL: '' })).toThrow(/ORGANIZER_PANEL_URL/);
  });

  it('a URL de retorno do cadastro cai para BILLING_RETURN_URL quando nao ha ORGANIZER_PANEL_URL', () => {
    const config = loadConfig({ ...base, ...connect, ORGANIZER_PANEL_URL: '', BILLING_RETURN_URL: 'http://localhost:5174' });
    expect(createConnect(config, {} as DbPool)).not.toBeNull();
  });

  it('configuracao valida em modo teste sobe com ambiente SANDBOX, independente do Mercado Pago e da cobranca', () => {
    const config = loadConfig({ ...base, ...connect });
    expect(config.CONNECT_ENABLED).toBe(true);
    expect(config.PSP_PROVIDER).toBe('none');
    expect(config.BILLING_PROVIDER).toBe('none');
    const runtime = createConnect(config, {} as DbPool);
    expect(runtime?.environment).toBe('SANDBOX');
  });

  it('chave LIVE (sk_live_ ou rk_live_) fora de producao e recusada, com ou sem Connect', () => {
    for (const NODE_ENV of ['test', 'development', 'staging']) {
      for (const key of ['sk_live_fake', 'rk_live_fake']) {
        const extra = NODE_ENV === 'staging' ? { CORS_ORIGINS: 'https://a.example.test', SESSION_COOKIE_SECURE: 'true' } : {};
        expect(() => loadConfig({ ...base, ...extra, NODE_ENV, STRIPE_SECRET_KEY: key }), `${NODE_ENV} ${key}`).toThrow(
          /LIVE/i,
        );
        expect(
          () => loadConfig({ ...base, ...connect, ...extra, NODE_ENV, STRIPE_SECRET_KEY: key, ORGANIZER_PANEL_URL: 'https://p.example.test' }),
          `${NODE_ENV} ${key} connect`,
        ).toThrow(/LIVE/i);
      }
    }
  });

  it('chave restrita de TESTE (rk_test_) e aceita fora de producao', () => {
    const config = loadConfig({ ...base, ...connect, STRIPE_SECRET_KEY: 'rk_test_fake_for_unit_tests' });
    expect(createConnect(config, {} as DbPool)?.environment).toBe('SANDBOX');
  });

  it('em producao o Connect exige chave LIVE: chave de teste com NODE_ENV=production e recusada na subida', () => {
    expect(() => loadConfig({ ...base, ...connect, ...producao })).toThrow(/CONNECT_ENABLED.*LIVE|LIVE.*CONNECT_ENABLED/s);
  });

  it('em producao com chave live: ambiente PRODUCTION', () => {
    const config = loadConfig({ ...base, ...connect, ...producao, STRIPE_SECRET_KEY: 'rk_live_fake' });
    expect(createConnect(config, {} as DbPool)?.environment).toBe('PRODUCTION');
  });

  it('em staging e producao a URL do painel precisa ser https', () => {
    expect(() =>
      loadConfig({
        ...base,
        ...connect,
        NODE_ENV: 'staging',
        CORS_ORIGINS: 'https://a.example.test',
        SESSION_COOKIE_SECURE: 'true',
      }),
    ).toThrow(/ORGANIZER_PANEL_URL precisa ser https/);
  });

  it('segredo do webhook: um ou mais (endpoints "Sua conta" e "Contas conectadas"), separados por virgula', () => {
    const um = loadConfig({ ...base, ...connect });
    expect(connectWebhookSecrets(um)).toEqual(['whsec_test_fake_for_unit_tests']);
    const dois = loadConfig({
      ...base,
      ...connect,
      STRIPE_CONNECT_WEBHOOK_SECRET: ' whsec_test_fake_a , whsec_test_fake_b ,',
    });
    expect(connectWebhookSecrets(dois)).toEqual(['whsec_test_fake_a', 'whsec_test_fake_b']);
    expect(() => loadConfig({ ...base, ...connect, STRIPE_CONNECT_WEBHOOK_SECRET: ' , ' })).toThrow(
      /STRIPE_CONNECT_WEBHOOK_SECRET/,
    );
  });
});
