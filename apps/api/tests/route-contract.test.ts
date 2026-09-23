import { describe, expect, it } from 'vitest';
import {
  ROUTE_CONTRACTS,
  ROUTE_KEYS,
  ROUTE_NAMES,
  TENANT_PERMISSIONS,
  PLATFORM_PERMISSIONS,
  routeKey,
  type RouteContract,
} from '@campaigns/shared';
import { createApp } from '../src/app.js';
import { listRegisteredRoutes } from '../src/http/registerRoutes.js';
import { loadConfig } from '../src/config.js';
import { LoginThrottle } from '../src/lib/loginThrottle.js';
import { SecretBox } from '../src/lib/secretBox.js';
import { createPool } from '@campaigns/db';

/**
 * E4 · contrato frontend/backend. Este teste falha nos dois sentidos:
 *   - contrato declarado sem rota registrada;
 *   - rota registrada fora do contrato.
 *
 * Roda SEM banco: o pool nao e consultado durante o registro das rotas.
 *
 * Secao 8 do pedido, item 12.
 */

function buildTestApp() {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://app_user:x@localhost:5432/nao-usado-neste-teste',
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    APP_BASE_DOMAIN: 'plataforma.local',
  });
  const pool = createPool({ connectionString: config.DATABASE_URL, max: 1 });
  const app = createApp({
    config,
    pool,
    secretBox: new SecretBox(config.MFA_ENCRYPTION_KEY),
    loginThrottle: new LoginThrottle({
      windowMs: config.LOGIN_ORIGIN_WINDOW_MINUTES * 60_000,
      maxFailures: config.LOGIN_ORIGIN_MAX_FAILURES,
      maxDistinctAccounts: config.LOGIN_ORIGIN_MAX_ACCOUNTS,
    }),
  });
  return { app, pool };
}

describe('contrato de rotas (E4)', () => {
  it('toda rota declarada no contrato esta registrada na API', async () => {
    const { app, pool } = buildTestApp();
    try {
      const registered = new Set(listRegisteredRoutes(app));
      const missing = ROUTE_KEYS.filter((key) => !registered.has(key));
      expect(missing, `contratos sem rota: ${missing.join(', ')}`).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it('nenhuma rota registrada esta fora do contrato', async () => {
    const { app, pool } = buildTestApp();
    try {
      const declared = new Set(ROUTE_KEYS);
      const extra = listRegisteredRoutes(app).filter((key) => !declared.has(key));
      expect(extra, `rotas nao declaradas: ${extra.join(', ')}`).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it('a API nao sobe se faltar handler para um contrato', () => {
    // Garantia estrutural: registerRoutes lanca antes de servir a primeira
    // requisicao, em vez de devolver 404 em producao.
    const { app, pool } = buildTestApp();
    expect(listRegisteredRoutes(app).length).toBe(ROUTE_NAMES.length);
    void pool.end();
  });
});

describe('coerencia do contrato', () => {
  it('nao ha dois contratos com o mesmo metodo e caminho', () => {
    const seen = new Set<string>();
    for (const name of ROUTE_NAMES) {
      const key = routeKey(ROUTE_CONTRACTS[name]);
      expect(seen.has(key), `rota duplicada: ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('todo caminho comeca com /api/', () => {
    for (const name of ROUTE_NAMES) {
      expect(ROUTE_CONTRACTS[name].path.startsWith('/api/')).toBe(true);
    }
  });

  it('permissao citada no contrato existe no catalogo', () => {
    for (const name of ROUTE_NAMES) {
      const contract: RouteContract = ROUTE_CONTRACTS[name];
      if (contract.tenantPermission) {
        expect(TENANT_PERMISSIONS).toContain(contract.tenantPermission);
      }
      if (contract.platformPermission) {
        expect(PLATFORM_PERMISSIONS).toContain(contract.platformPermission);
      }
    }
  });

  it('rota com permissao de comunidade exige comunidade resolvida', () => {
    for (const name of ROUTE_NAMES) {
      const contract: RouteContract = ROUTE_CONTRACTS[name];
      if (contract.tenantPermission) {
        expect(contract.tenantScope, `${name} exige tenantScope resolved`).toBe('resolved');
        expect(contract.auth, `${name} exige sessao`).toBe(true);
      }
    }
  });

  it('rota com permissao de plataforma exige sessao e MFA (RN12)', () => {
    for (const name of ROUTE_NAMES) {
      const contract: RouteContract = ROUTE_CONTRACTS[name];
      if (contract.platformPermission) {
        expect(contract.auth, `${name} exige sessao`).toBe(true);
        expect(contract.mfa, `${name} exige MFA`).toBe(true);
      }
    }
  });

  it('rota que exige MFA tambem exige sessao', () => {
    for (const name of ROUTE_NAMES) {
      const contract: RouteContract = ROUTE_CONTRACTS[name];
      if (contract.mfa) expect(contract.auth).toBe(true);
    }
  });

  it('nenhuma rota de fase futura foi declarada por engano', () => {
    /*
     * A lista encolheu quando a PRIMEIRA FATIA DA FASE 2 entrou.
     *
     * `/draws` e `/reservations` estavam proibidos porque a fundacao nao
     * tinha sorteio nem reserva — declarar a rota antes da implementacao
     * produziria um contrato que promete o que o servidor nao entrega. Agora
     * as duas existem, com servico, migration e teste de concorrencia; manter
     * a proibicao seria proibir o que acabou de ser construido.
     *
     * A GUARDA CONTINUA VALENDO para o que ainda nao existe. Pagamento com
     * provedor, webhook e premio pertencem as fases seguintes, e o teste
     * segue barrando cada um deles.
     *
     * `/checkout` fica na lista: o fluxo de compra termina em `/api/public/
     * orders`, e nao ha — nem deve haver — uma rota de checkout paralela.
     */
    const proibidos = ['/checkout', '/payments', '/webhooks', '/prizes'];
    for (const name of ROUTE_NAMES) {
      const path = ROUTE_CONTRACTS[name].path;
      for (const proibido of proibidos) {
        expect(path.includes(proibido), `${path} pertence a uma fase futura`).toBe(false);
      }
    }
  });
});
