import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { LoginThrottle } from '../src/lib/loginThrottle.js';
import { SecretBox } from '../src/lib/secretBox.js';
import type { DbPool } from '@clubedarifa/db';
import {
  TEST_MFA_KEY,
  cleanup,
  createHarness,
  currentCode,
  grantMembership,
  grantPlatformRole,
  hasTestDatabase,
  loginAs,
  seedAccount,
  seedConfirmedTotp,
  seedTenantWithSlug,
  skipReason,
  unique,
  verifyMfa,
  type Harness,
} from './helpers/apiHarness.js';

/**
 * Etapa 5 · a API observavel e a comunidade resolvida pelo dominio.
 *
 *  - /api/health diz a verdade (banco fora = 503; worker atrasado = degraded);
 *  - a saude da plataforma so abre para quem tem `platform:health:read` e MFA;
 *  - o log e JSON, correlacionavel e SEM dado pessoal;
 *  - a comunidade sai do dominio (Host ou Origin) — dominio desconhecido e 404.
 */
describe.skipIf(!hasTestDatabase)(`Saude, logs e dominio ${hasTestDatabase ? '' : skipReason}`, () => {
  let harness: Harness;
  let producao: Harness;
  let slug: string;
  let tenantId: string;

  beforeAll(async () => {
    harness = await createHarness();
    // Comportamento de producao: a comunidade sai so do dominio.
    producao = await createHarness({ tenantHeaderEnabled: false });
    await cleanup(harness.owner);
    slug = unique('obs-');
    tenantId = await seedTenantWithSlug(harness.owner, slug, 'Comunidade Observada');
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
    await producao?.close();
  });

  // ---- /api/health --------------------------------------------------------

  describe('GET /api/health', () => {
    async function limparHeartbeats() {
      await harness.owner.query('DELETE FROM job_heartbeats');
    }
    async function heartbeat(nome: string, atrasoSegundos: number, intervalo = 60) {
      await harness.owner.query(
        `INSERT INTO job_heartbeats (job_name, interval_seconds, last_started_at, last_finished_at, last_success_at)
         VALUES ($1, $2, now() - make_interval(secs => $3), now() - make_interval(secs => $3), now() - make_interval(secs => $3))
         ON CONFLICT (job_name) DO UPDATE SET last_finished_at = EXCLUDED.last_finished_at, interval_seconds = EXCLUDED.interval_seconds`,
        [nome, intervalo, atrasoSegundos],
      );
    }

    it('banco no ar e nenhum heartbeat ainda: ok, worker "unknown"', async () => {
      await limparHeartbeats();
      const res = await request(harness.app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', database: 'up', worker: 'unknown' });
    });

    it('jobs em dia: worker "ok"', async () => {
      await limparHeartbeats();
      await heartbeat('expirar-reservas', 10);
      await heartbeat('expirar-pix', 100, 300);
      const res = await request(harness.app).get('/api/health');
      expect(res.body).toEqual({ status: 'ok', database: 'up', worker: 'ok' });
    });

    it('um job atrasado (mais de 3x o intervalo): "degraded", mas HTTP 200', async () => {
      await limparHeartbeats();
      await heartbeat('expirar-reservas', 10);
      await heartbeat('fechar-sorteios', 600); // 10x o intervalo de 60s
      const res = await request(harness.app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'degraded', database: 'up', worker: 'stale' });
    });

    it('nao exige sessao nem comunidade e nao vaza dado de negocio', async () => {
      const res = await request(harness.app).get('/api/health');
      expect(Object.keys(res.body).sort()).toEqual(['database', 'status', 'worker']);
    });

    it('banco FORA: 503 e status "down"', async () => {
      const h = await createHarness();
      await h.pool.end();
      try {
        const res = await request(h.app).get('/api/health');
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ status: 'down', database: 'down', worker: 'unknown' });
      } finally {
        await h.owner.end();
      }
    });

    it('banco que NAO RESPONDE: 503 dentro do prazo, sem pendurar a requisicao', async () => {
      const pendurado = { query: () => new Promise(() => undefined) } as unknown as DbPool;
      const app = createApp({
        config: harness.config,
        pool: pendurado,
        secretBox: new SecretBox(TEST_MFA_KEY),
        loginThrottle: new LoginThrottle({ windowMs: 60_000, maxFailures: 10, maxDistinctAccounts: 10 }),
        psp: null,
      });

      const inicio = Date.now();
      const res = await request(app).get('/api/health');

      expect(res.status).toBe(503);
      expect(res.body.database).toBe('down');
      expect(Date.now() - inicio).toBeLessThan(5_000);
    }, 15_000);
  });

  // ---- /api/platform/health ----------------------------------------------

  describe('GET /api/platform/health', () => {
    let adminCookie: string;
    let organizerCookie: string;

    beforeAll(async () => {
      const admin = await seedAccount(harness.owner);
      await grantPlatformRole(harness.owner, { userId: admin.userId, role: 'PLATFORM_OPERATIONS' });
      const secret = await seedConfirmedTotp(harness.owner, admin.userId);
      const login = await loginAs(harness, admin);
      adminCookie = (await verifyMfa(harness, login.cookie, await currentCode(secret))).cookie;

      // Sem `platform:health:read`: o sub-perfil de suporte.
      const organizer = await seedAccount(harness.owner);
      await grantMembership(harness.owner, { tenantId, userId: organizer.userId, role: 'OPERATOR' });
      organizerCookie = (await loginAs(harness, organizer)).cookie;
    });

    it('mostra o ultimo ciclo de cada job, a dead-letter e a conciliacao', async () => {
      await harness.owner.query('DELETE FROM job_heartbeats');
      await harness.owner.query(
        `INSERT INTO job_heartbeats (job_name, interval_seconds, last_started_at, last_finished_at,
                                     last_success_at, last_duration_ms, last_count, consecutive_failures, last_error)
         VALUES ('expirar-pix', 300, now() - interval '20 seconds', now() - interval '19 seconds',
                 now() - interval '19 seconds', 1000, 4, 0, NULL),
                ('conciliacao', 86400, now() - interval '5 days', now() - interval '5 days', NULL, 50, 0, 2, 'PSP fora')`,
      );
      await harness.owner.query(
        `INSERT INTO outbox (tenant_id, event_type, payload, dead_lettered_at)
         VALUES ($1, 'draw.paused', '{}'::jsonb, now())`,
        [tenantId],
      );

      const res = await request(harness.app).get('/api/platform/health').set('Cookie', adminCookie);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.worker).toBe('stale');
      const porNome = Object.fromEntries(res.body.jobs.map((j: { name: string }) => [j.name, j]));
      expect(porNome['expirar-pix']).toMatchObject({ intervalSeconds: 300, lastCount: 4, consecutiveFailures: 0, stale: false });
      expect(porNome['conciliacao']).toMatchObject({ lastError: 'PSP fora', consecutiveFailures: 2, stale: true });
      expect(res.body.deadLetter.count).toBeGreaterThanOrEqual(1);
      expect(res.body.deadLetter.oldestAt).not.toBeNull();
      expect(res.body.outboxPending).toMatchObject({ count: expect.any(Number) });
      expect(res.body.reconciliation).toMatchObject({ openIssues: expect.any(Number), manualRefunds: expect.any(Number) });
    });

    it('quem so tem vinculo com uma comunidade nao abre (403 ou 401)', async () => {
      const res = await request(harness.app).get('/api/platform/health').set('Cookie', organizerCookie);
      expect([401, 403]).toContain(res.status);
    });

    it('sem sessao: 401', async () => {
      expect((await request(harness.app).get('/api/platform/health')).status).toBe(401);
    });
  });

  // ---- logs ---------------------------------------------------------------

  describe('logs estruturados', () => {
    async function capturar<T>(fn: () => Promise<T>): Promise<{ resultado: T; linhas: Record<string, unknown>[] }> {
      const linhas: Record<string, unknown>[] = [];
      const coletar = (l: unknown) => {
        try {
          linhas.push(JSON.parse(String(l)));
        } catch {
          /* linha que nao e do logger */
        }
      };
      const a = vi.spyOn(console, 'log').mockImplementation(coletar);
      const b = vi.spyOn(console, 'error').mockImplementation(coletar);
      try {
        return { resultado: await fn(), linhas };
      } finally {
        a.mockRestore();
        b.mockRestore();
      }
    }

    it('uma linha JSON por requisicao, com request_id, tenant_id, metodo, caminho, status e duracao', async () => {
      const { resultado, linhas } = await capturar(() =>
        request(harness.app).get('/api/public/draws').set('x-tenant-slug', slug),
      );

      const requestId = resultado.headers['x-request-id'];
      const linha = linhas.find((l) => l['msg'] === 'requisicao' && l['request_id'] === requestId);
      expect(linha).toBeDefined();
      expect(linha).toMatchObject({
        service: 'api',
        level: 'info',
        tenant_id: tenantId,
        method: 'GET',
        path: '/api/public/draws',
        status: 200,
      });
      expect(typeof linha!['duration_ms']).toBe('number');
    });

    it('a query string NAO entra no log (nem o e-mail que estiver nela)', async () => {
      const { linhas } = await capturar(() =>
        request(harness.app).get('/api/public/draws?email=maria@example.com&telefone=11912345678').set('x-tenant-slug', slug),
      );
      const texto = JSON.stringify(linhas);
      expect(texto).not.toContain('maria@example.com');
      expect(texto).not.toContain('11912345678');
      expect(linhas.find((l) => l['msg'] === 'requisicao')!['path']).toBe('/api/public/draws');
    });

    it('o corpo NAO entra no log: e-mail, telefone e nome do comprador ficam de fora', async () => {
      const { linhas } = await capturar(() =>
        request(harness.app)
          .post('/api/public/orders')
          .set('x-tenant-slug', slug)
          .send({
            reservationId: '00000000-0000-4000-8000-000000000000',
            buyer: { name: 'Maria Souza', phone: '+55 11 91234-5678', email: 'maria@example.com' },
            acceptedTerms: true,
          }),
      );
      const texto = JSON.stringify(linhas);
      for (const proibido of ['maria@example.com', '91234', 'Maria Souza', 'Maria']) {
        expect(texto, proibido).not.toContain(proibido);
      }
    });

    it('caminho com identificador agrupa pelo PADRAO da rota, nao pelo valor', async () => {
      const { linhas } = await capturar(() =>
        request(harness.app).get('/api/public/orders/00000000-0000-4000-8000-000000000123').set('x-tenant-slug', slug),
      );
      const linha = linhas.find((l) => l['msg'] === 'requisicao')!;
      expect(linha['path']).toBe('/api/public/orders/:id');
      expect(linha['level']).toBe('warn'); // 404
    });

    it('x-request-id valido do cliente e aproveitado; invalido e substituido', async () => {
      const bom = await request(harness.app).get('/api/public/draws').set('x-tenant-slug', slug).set('x-request-id', 'trace-abc-12345');
      expect(bom.headers['x-request-id']).toBe('trace-abc-12345');

      const ruim = await request(harness.app)
        .get('/api/public/draws')
        .set('x-tenant-slug', slug)
        .set('x-request-id', 'com espaco e "aspas"');
      expect(ruim.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('/api/health nao gera linha (o Render o chama toda hora)', async () => {
      const { linhas } = await capturar(() => request(harness.app).get('/api/health'));
      expect(linhas.filter((l) => l['msg'] === 'requisicao')).toHaveLength(0);
    });

    it('erro inesperado: 500 generico na resposta, e no log so o essencial, com o request_id', async () => {
      const quebrado = {
        connect: async () => {
          throw new Error('falha interna com segredo=abc123');
        },
        query: async () => {
          throw new Error('falha interna com segredo=abc123');
        },
      } as unknown as DbPool;
      const app = createApp({
        config: harness.config,
        pool: quebrado,
        secretBox: new SecretBox(TEST_MFA_KEY),
        loginThrottle: new LoginThrottle({ windowMs: 60_000, maxFailures: 10, maxDistinctAccounts: 10 }),
        psp: null,
      });

      const { resultado, linhas } = await capturar(() => request(app).get('/api/public/draws').set('x-tenant-slug', slug));

      expect(resultado.status).toBe(500);
      expect(JSON.stringify(resultado.body)).not.toContain('segredo');
      const erro = linhas.find((l) => l['msg'] === 'erro nao tratado');
      expect(erro).toMatchObject({ level: 'error', request_id: resultado.headers['x-request-id'] });
      expect(erro!['error']).toEqual({ name: 'Error', message: 'falha interna com segredo=abc123' });
      // Sem pilha no log.
      expect(JSON.stringify(erro)).not.toContain('at ');
    });
  });

  // ---- comunidade pelo dominio -------------------------------------------

  describe('comunidade resolvida pelo dominio (Host e Origin)', () => {
    let dominio: string;
    let sorteioDaComunidade: string;
    let sorteioAlheio: string;

    async function sorteioAtivo(tenant: string, titulo: string): Promise<string> {
      const { rows } = await harness.owner.query<{ id: string }>(
        `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers, status)
         VALUES ($1, $2, $3, 'P', 1000, 100, 'ATIVA') RETURNING id`,
        [tenant, unique('s-'), titulo],
      );
      return rows[0]!.id;
    }

    beforeAll(async () => {
      dominio = `${unique('rifa')}.exemplo.com`.replace(/[^a-z0-9.-]/g, '');
      await harness.owner.query(
        'INSERT INTO tenant_domains (tenant_id, domain, is_primary, verified_at) VALUES ($1, $2, true, now())',
        [tenantId, dominio],
      );
      sorteioDaComunidade = await sorteioAtivo(tenantId, 'Sorteio da comunidade do dominio');
      const outro = await seedTenantWithSlug(harness.owner, unique('outro-'), 'Outra');
      sorteioAlheio = await sorteioAtivo(outro, 'Sorteio de outra comunidade');
    });

    const titulos = (res: request.Response) => (res.body.draws as { id: string }[]).map((d) => d.id);

    it('Origin de dominio proprio VERIFICADO resolve a comunidade (sem cabecalho)', async () => {
      const res = await request(producao.app).get('/api/public/draws').set('Origin', `https://${dominio}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(titulos(res)).toContain(sorteioDaComunidade);
      expect(titulos(res)).not.toContain(sorteioAlheio);
      expect(res.headers['access-control-allow-origin']).toBe(`https://${dominio}`);
    });

    it('Origin no formato {slug}.{APP_BASE_DOMAIN} resolve a comunidade', async () => {
      const res = await request(producao.app)
        .get('/api/public/draws')
        .set('Origin', `https://${slug}.clubedarifa.local`);
      expect(res.status).toBe(200);
      expect(titulos(res)).toContain(sorteioDaComunidade);
    });

    it('dominio registrado e NAO verificado: a origem e recusada (403)', async () => {
      const naoVerificado = `${unique('nv')}.exemplo.com`.replace(/[^a-z0-9.-]/g, '');
      await harness.owner.query('INSERT INTO tenant_domains (tenant_id, domain, verified_at) VALUES ($1, $2, NULL)', [tenantId, naoVerificado]);
      const res = await request(producao.app).get('/api/public/draws').set('Origin', `https://${naoVerificado}`);
      expect(res.status).toBe(403);
    });

    it('dominio DESCONHECIDO: a origem e recusada (403), nunca cai numa comunidade padrao', async () => {
      const res = await request(producao.app).get('/api/public/draws').set('Origin', 'https://nao-cadastrado.exemplo.com');
      expect(res.status).toBe(403);
    });

    it('Host desconhecido, sem Origin e sem cabecalho: 404 TENANT_NOT_RESOLVED', async () => {
      const res = await request(producao.app).get('/api/public/draws').set('Host', 'desconhecido.exemplo.com');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('TENANT_NOT_RESOLVED');
    });

    it('em producao o cabecalho x-tenant-slug e IGNORADO, mesmo com slug valido', async () => {
      const res = await request(producao.app).get('/api/public/draws').set('x-tenant-slug', slug);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('TENANT_NOT_RESOLVED');
    });

    it('o Host da requisicao vence a Origin', async () => {
      const outroSlug = unique('hostvence-');
      await seedTenantWithSlug(harness.owner, outroSlug, 'Dona do Host');
      const res = await request(producao.app)
        .get('/api/public/draws')
        .set('Host', `${outroSlug}.clubedarifa.local`)
        .set('Origin', `https://${dominio}`);
      expect(res.status).toBe(200);
      // A comunidade e a do Host (que nao tem sorteio), nao a do dominio da Origin.
      expect(titulos(res)).not.toContain(sorteioDaComunidade);
    });
  });
});
