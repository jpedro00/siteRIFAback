import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
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
 * Ciclo de vida do sorteio · RN02, RN11, RN22.
 *
 * O que estes testes protegem: o organizador nunca leva um sorteio a ATIVA
 * sozinho, quem decide a revisao e o Super Admin, e TODA mudanca de estado
 * deixa auditoria e evento na outbox — na mesma transacao.
 */
describe.skipIf(!hasTestDatabase)(`Ciclo de vida do sorteio ${hasTestDatabase ? '' : skipReason}`, () => {
  let harness: Harness;
  let slug: string;
  let tenantId: string;
  let organizerCookie: string;
  let platformCookie: string;

  beforeAll(async () => {
    harness = await createHarness();
    await cleanup(harness.owner);

    slug = unique('ciclo-');
    tenantId = await seedTenantWithSlug(harness.owner, slug, 'Comunidade do Ciclo');

    const organizer = await seedAccount(harness.owner);
    await grantMembership(harness.owner, { tenantId, userId: organizer.userId, role: 'OPERATOR' });
    organizerCookie = (await loginAs(harness, organizer)).cookie;

    const admin = await seedAccount(harness.owner);
    await grantPlatformRole(harness.owner, { userId: admin.userId, role: 'PLATFORM_COMPLIANCE' });
    const secret = await seedConfirmedTotp(harness.owner, admin.userId);
    const login = await loginAs(harness, admin);
    const mfa = await verifyMfa(harness, login.cookie, await currentCode(secret));
    expect(mfa.status).toBe(200);
    platformCookie = mfa.cookie;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  async function criarRascunho(): Promise<string> {
    const res = await request(harness.app)
      .post('/api/tenant/draws')
      .set('Cookie', organizerCookie)
      .set('x-tenant-slug', slug)
      .send({
        title: `Sorteio ${unique('t-')}`,
        prizeName: 'Moto 0 km',
        unitPriceCents: 1500,
        totalNumbers: 100,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  }

  function organizador(drawId: string, status: string) {
    return request(harness.app)
      .post(`/api/tenant/draws/${drawId}/status`)
      .set('Cookie', organizerCookie)
      .set('x-tenant-slug', slug)
      .send({ status });
  }

  function revisar(drawId: string, body: Record<string, unknown>, cookie = platformCookie) {
    return request(harness.app)
      .post(`/api/platform/draws/${drawId}/review`)
      .set('Cookie', cookie)
      .send(body);
  }

  async function statusNoBanco(drawId: string): Promise<string> {
    const { rows } = await harness.owner.query<{ status: string }>(
      'SELECT status FROM draws WHERE id = $1',
      [drawId],
    );
    return rows[0]!.status;
  }

  /**
   * Tipos de evento do sorteio, em ordem ALFABETICA. A outbox nao promete ordem
   * entre eventos da mesma transacao (mesmo `created_at`, `id` aleatorio), e os
   * consumidores sao idempotentes e independentes de ordem: o que se afirma
   * aqui e QUAIS eventos existem, nao a sequencia em que foram inseridos.
   */
  async function eventosDoSorteio(drawId: string): Promise<string[]> {
    const { rows } = await harness.owner.query<{ event_type: string }>(
      `SELECT event_type FROM outbox
        WHERE event_type LIKE 'draw.%' AND payload->>'drawId' = $1`,
      [drawId],
    );
    return rows.map((r) => r.event_type).sort();
  }

  async function submeter(drawId: string): Promise<void> {
    const res = await organizador(drawId, 'REVISÃO COMPLIANCE');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  // -------------------------------------------------------------------------
  describe('RN02 · o organizador nao ativa sozinho', () => {
    it('RN02_rascunho_nao_vai_direto_para_ativa', async () => {
      const id = await criarRascunho();

      const res = await organizador(id, 'ATIVA');

      expect(res.status).toBe(409);
      expect(await statusNoBanco(id)).toBe('RASCUNHO');
      expect(await eventosDoSorteio(id)).toEqual([]);
    });

    it('enviar para revisao muda o estado e publica draw.submitted', async () => {
      const id = await criarRascunho();
      await submeter(id);

      expect(await statusNoBanco(id)).toBe('REVISÃO COMPLIANCE');
      expect(await eventosDoSorteio(id)).toEqual(['draw.submitted']);
    });

    it('em revisao, o organizador nao aprova nem volta o sorteio (403)', async () => {
      const id = await criarRascunho();
      await submeter(id);

      for (const destino of ['ATIVA', 'AGENDADA', 'RASCUNHO']) {
        const res = await organizador(id, destino);
        expect(res.status, `organizador → ${destino}`).toBe(403);
      }
      expect(await statusNoBanco(id)).toBe('REVISÃO COMPLIANCE');
    });

    it('o organizador nao alcanca a rota de decisao da plataforma', async () => {
      const id = await criarRascunho();
      await submeter(id);

      const res = await revisar(id, { to: 'ATIVA' }, organizerCookie);

      expect([401, 403]).toContain(res.status);
      expect(await statusNoBanco(id)).toBe('REVISÃO COMPLIANCE');
    });
  });

  // -------------------------------------------------------------------------
  describe('decisao do Super Admin', () => {
    it('a fila lista o sorteio enviado, com a comunidade', async () => {
      const id = await criarRascunho();
      await submeter(id);

      const res = await request(harness.app).get('/api/platform/draws/review').set('Cookie', platformCookie);

      expect(res.status).toBe(200);
      const item = (res.body.draws as { id: string; tenantSlug: string }[]).find((d) => d.id === id);
      expect(item?.tenantSlug).toBe(slug);
    });

    it('aprovar para ATIVA publica draw.approved e draw.activated', async () => {
      const id = await criarRascunho();
      await submeter(id);

      const res = await revisar(id, { to: 'ATIVA' });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe('ATIVA');
      expect(await eventosDoSorteio(id)).toEqual(['draw.activated', 'draw.approved', 'draw.submitted']);
    });

    it('aprovar para AGENDADA publica so draw.approved', async () => {
      const id = await criarRascunho();
      await submeter(id);

      const res = await revisar(id, { to: 'AGENDADA' });

      expect(res.status).toBe(200);
      expect(await statusNoBanco(id)).toBe('AGENDADA');
      expect(await eventosDoSorteio(id)).toEqual(['draw.approved', 'draw.submitted']);
    });

    it('RN02_reprovacao_exige_motivo', async () => {
      const id = await criarRascunho();
      await submeter(id);

      const semMotivo = await revisar(id, { to: 'RASCUNHO' });
      expect(semMotivo.status).toBe(400);
      expect(await statusNoBanco(id)).toBe('REVISÃO COMPLIANCE');

      const curto = await revisar(id, { to: 'RASCUNHO', reason: 'ab' });
      expect(curto.status).toBe(400);

      const comMotivo = await revisar(id, { to: 'RASCUNHO', reason: 'Regulamento sem a fonte do resultado.' });
      expect(comMotivo.status, JSON.stringify(comMotivo.body)).toBe(200);
      expect(await statusNoBanco(id)).toBe('RASCUNHO');
      expect(await eventosDoSorteio(id)).toEqual(['draw.rejected', 'draw.submitted']);

      const { rows } = await harness.owner.query<{ after: { reason: string } }>(
        `SELECT after FROM audit_events
          WHERE target_id = $1 AND actor_type = 'PLATFORM'`,
        [id],
      );
      expect(rows[0]!.after.reason).toBe('Regulamento sem a fonte do resultado.');
    });

    it('sorteio que nao esta em revisao nao aceita decisao', async () => {
      const id = await criarRascunho();
      const res = await revisar(id, { to: 'ATIVA' });
      expect(res.status).toBe(409);
      expect(await statusNoBanco(id)).toBe('RASCUNHO');
    });

    it('sorteio inexistente e 404', async () => {
      const res = await revisar('00000000-0000-4000-8000-000000000000', { to: 'ATIVA' });
      expect(res.status).toBe(404);
    });

    it('duas decisoes simultaneas: uma vence, a outra recebe 409, e ha UM draw.approved', async () => {
      const id = await criarRascunho();
      await submeter(id);

      const [a, b] = await Promise.all([revisar(id, { to: 'ATIVA' }), revisar(id, { to: 'AGENDADA' })]);

      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const eventos = await eventosDoSorteio(id);
      expect(eventos.filter((e) => e === 'draw.approved')).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('venda em andamento', () => {
    async function ativo(): Promise<string> {
      const id = await criarRascunho();
      await submeter(id);
      expect((await revisar(id, { to: 'ATIVA' })).status).toBe(200);
      return id;
    }

    it('pausar, retomar e encerrar publicam draw.paused, draw.resumed e draw.sales_closed', async () => {
      const id = await ativo();

      expect((await organizador(id, 'PAUSADA')).status).toBe(200);
      expect((await organizador(id, 'ATIVA')).status).toBe(200);
      expect((await organizador(id, 'VENDAS ENCERRADAS')).status).toBe(200);

      expect(await eventosDoSorteio(id)).toEqual(
        [
          'draw.submitted',
          'draw.approved',
          'draw.activated',
          'draw.paused',
          'draw.resumed',
          'draw.sales_closed',
        ].sort(),
      );
    });

    it('vendas encerradas nao reabrem', async () => {
      const id = await ativo();
      expect((await organizador(id, 'VENDAS ENCERRADAS')).status).toBe(200);

      expect((await organizador(id, 'ATIVA')).status).toBe(409);
      expect((await organizador(id, 'PAUSADA')).status).toBe(409);
      expect(await statusNoBanco(id)).toBe('VENDAS ENCERRADAS');
    });

    it('RN22 · CANCELADA esta bloqueada, com a razao no erro', async () => {
      const id = await ativo();

      const res = await organizador(id, 'CANCELADA');

      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('RN22');
      expect(await statusNoBanco(id)).toBe('ATIVA');
    });

    it('estado que nao existe no ciclo e 400', async () => {
      const id = await criarRascunho();
      expect((await organizador(id, 'INVENTADO')).status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  describe('RN11 · auditoria e outbox andam junto com o estado', () => {
    it('cada transicao grava quem, antes/depois e o IP', async () => {
      const id = await criarRascunho();
      await submeter(id);

      const { rows } = await harness.owner.query<{
        action: string;
        actor_type: string;
        actor_user_id: string | null;
        before: { status: string };
        after: { status: string };
        ip: string | null;
        tenant_id: string;
      }>(
        `SELECT action, actor_type, actor_user_id, before, after, host(ip) AS ip, tenant_id
           FROM audit_events WHERE target_id = $1 ORDER BY occurred_at`,
        [id],
      );

      expect(rows.map((r) => r.action)).toEqual(['draw.created', 'draw.status_changed']);
      const mudanca = rows[1]!;
      expect(mudanca.before.status).toBe('RASCUNHO');
      expect(mudanca.after.status).toBe('REVISÃO COMPLIANCE');
      expect(mudanca.actor_user_id).not.toBeNull();
      expect(mudanca.actor_type).toBe('USER');
      expect(mudanca.ip).not.toBeNull();
      expect(mudanca.tenant_id).toBe(tenantId);
    });

    it('a decisao da plataforma e auditada na comunidade do sorteio, com ator PLATFORM', async () => {
      const id = await criarRascunho();
      await submeter(id);
      expect((await revisar(id, { to: 'ATIVA' })).status).toBe(200);

      const { rows } = await harness.owner.query<{ actor_type: string; tenant_id: string }>(
        `SELECT actor_type, tenant_id FROM audit_events
          WHERE target_id = $1 AND action = 'draw.status_changed' ORDER BY occurred_at`,
        [id],
      );
      expect(rows.map((r) => r.actor_type)).toEqual(['USER', 'PLATFORM']);
      expect(new Set(rows.map((r) => r.tenant_id))).toEqual(new Set([tenantId]));
    });

    it('transicao recusada nao deixa auditoria nem evento', async () => {
      const id = await criarRascunho();
      const antes = await harness.owner.query(
        "SELECT count(*)::int AS n FROM audit_events WHERE target_id = $1 AND action = 'draw.status_changed'",
        [id],
      );

      expect((await organizador(id, 'ATIVA')).status).toBe(409);

      const depois = await harness.owner.query(
        "SELECT count(*)::int AS n FROM audit_events WHERE target_id = $1 AND action = 'draw.status_changed'",
        [id],
      );
      expect(depois.rows[0]!.n).toBe(antes.rows[0]!.n);
      expect(await eventosDoSorteio(id)).toEqual([]);
    });
  });
});
