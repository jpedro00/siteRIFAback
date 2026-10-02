import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createBillingDeps } from '../src/modules/billing/billingSetup.js';
import type { DbPool } from '@clubedarifa/db';

/**
 * Configuracao da cobranca da PLATAFORMA (Stripe). Independente do PSP dos sorteios:
 * ligar uma nao liga a outra, e ligar pela metade e recusado na subida.
 */

const base = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://app_user:x@localhost:5432/qualquer',
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  APP_BASE_DOMAIN: 'clubedarifa.local',
};
const stripe = {
  BILLING_PROVIDER: 'stripe',
  STRIPE_SECRET_KEY: 'sk_test_abc',
  STRIPE_WEBHOOK_SECRET: 'whsec_abc',
  BILLING_RETURN_URL: 'http://localhost:5174/',
};

describe('Cobranca da plataforma · configuracao', () => {
  it('padrao: desligada, e nenhum gateway e criado', () => {
    const config = loadConfig(base);
    expect(config.BILLING_PROVIDER).toBe('none');
    expect(createBillingDeps(config, {} as DbPool)).toBeNull();
  });

  it('e independente do PSP dos sorteios', () => {
    const config = loadConfig({ ...base, ...stripe });
    expect(config.PSP_PROVIDER).toBe('none');
    expect(createBillingDeps(config, {} as DbPool)).not.toBeNull();
  });

  it('stripe sem chave, sem segredo do webhook ou sem URL de retorno e recusado', () => {
    expect(() => loadConfig({ ...base, BILLING_PROVIDER: 'stripe' })).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => loadConfig({ ...base, ...stripe, STRIPE_WEBHOOK_SECRET: '  ' })).toThrow(/STRIPE_WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...base, ...stripe, BILLING_RETURN_URL: '' })).toThrow(/BILLING_RETURN_URL/);
  });

  it('chave LIVE so em producao: teste, dev e staging a recusam', () => {
    for (const NODE_ENV of ['test', 'development', 'staging']) {
      expect(() => loadConfig({ ...base, ...stripe, NODE_ENV, STRIPE_SECRET_KEY: 'sk_live_abc', BILLING_RETURN_URL: 'https://painel.exemplo.com' }), NODE_ENV).toThrow(
        /LIVE/i,
      );
    }
  });

  it('em staging e producao a URL de retorno precisa ser https', () => {
    expect(() => loadConfig({ ...base, ...stripe, NODE_ENV: 'staging', CORS_ORIGINS: 'https://a.example', SESSION_COOKIE_SECURE: 'true' })).toThrow(/BILLING_RETURN_URL precisa ser https/);
  });

  it('o gateway recusa evento de producao numa instalacao de teste', async () => {
    const config = loadConfig({ ...base, ...stripe });
    const deps = createBillingDeps(config, {} as DbPool)!;
    expect(deps.gateway.livemode).toBe(false);
  });
});
