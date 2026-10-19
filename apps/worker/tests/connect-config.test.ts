import { describe, expect, it } from 'vitest';
import type { DbPool } from '@clubedarifa/db';
import { loadWorkerConfig } from '../src/config.js';
import { createWorkerConnect } from '../src/connectSetup.js';

/**
 * Stripe Connect no WORKER · configuracao. Mesmo estilo da API: desligado por padrao; ligado
 * exige a chave da plataforma; chave live (sk_live_ ou rk_live_) so em producao, e producao com
 * Connect so com chave live. O worker NAO precisa do segredo do webhook (nao recebe avisos).
 *
 * Nenhuma chave real: so valores obviamente falsos.
 */

const base = {
  NODE_ENV: 'test',
  WORKER_DATABASE_URL: 'postgres://app_worker:x@localhost:5432/qualquer',
  QUEUE_DATABASE_URL: 'postgres://app_worker:x@localhost:5432/qualquer',
};
const connect = { CONNECT_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_fake_for_unit_tests' };

describe('worker · Stripe Connect · configuracao', () => {
  it('padrao: desligado, e nenhum runtime e criado', () => {
    const config = loadWorkerConfig(base);
    expect(config.CONNECT_ENABLED).toBe(false);
    expect(createWorkerConnect(config, {} as DbPool)).toBeNull();
  });

  it('CONNECT_ENABLED=true sem chave e recusado; sem segredo de webhook e aceito', () => {
    expect(() => loadWorkerConfig({ ...base, CONNECT_ENABLED: 'true' })).toThrow(/CONNECT_ENABLED=true exige STRIPE_SECRET_KEY/);
    const config = loadWorkerConfig({ ...base, ...connect });
    expect(config.CONNECT_ENABLED).toBe(true);
    expect(config.STRIPE_WEBHOOK_SECRET).toBeUndefined();
    expect(createWorkerConnect(config, {} as DbPool)?.environment).toBe('SANDBOX');
  });

  it('independente do Mercado Pago e da cobranca da plataforma', () => {
    const config = loadWorkerConfig({ ...base, ...connect });
    expect(config.PSP_PROVIDER).toBe('none');
    expect(config.BILLING_PROVIDER).toBe('none');
  });

  it('chave LIVE (sk_live_ ou rk_live_) fora de producao e recusada, com ou sem Connect', () => {
    for (const NODE_ENV of ['test', 'development', 'staging']) {
      for (const key of ['sk_live_fake', 'rk_live_fake']) {
        expect(() => loadWorkerConfig({ ...base, NODE_ENV, STRIPE_SECRET_KEY: key }), `${NODE_ENV} ${key}`).toThrow(/LIVE/);
        expect(() => loadWorkerConfig({ ...base, ...connect, NODE_ENV, STRIPE_SECRET_KEY: key }), `${NODE_ENV} ${key} connect`).toThrow(
          /LIVE/,
        );
      }
    }
  });

  it('chave restrita de TESTE (rk_test_) e aceita fora de producao', () => {
    const config = loadWorkerConfig({ ...base, ...connect, STRIPE_SECRET_KEY: 'rk_test_fake_for_unit_tests' });
    expect(createWorkerConnect(config, {} as DbPool)?.environment).toBe('SANDBOX');
  });

  it('em producao o Connect exige chave LIVE; com ela, ambiente PRODUCTION', () => {
    expect(() => loadWorkerConfig({ ...base, ...connect, NODE_ENV: 'production' })).toThrow(/CONNECT_ENABLED.*LIVE/s);
    const config = loadWorkerConfig({ ...base, ...connect, NODE_ENV: 'production', STRIPE_SECRET_KEY: 'rk_live_fake' });
    expect(createWorkerConnect(config, {} as DbPool)?.environment).toBe('PRODUCTION');
  });

  it('o runtime do worker nao faz cadastro (sem URL de retorno): recusa antes de chamar a Stripe', async () => {
    const config = loadWorkerConfig({ ...base, ...connect });
    const runtime = createWorkerConnect(config, {} as DbPool)!;
    await expect(runtime.beginOnboarding({ tenantId: 't', userId: 'u' })).rejects.toThrow(/cadastro/i);
  });
});
