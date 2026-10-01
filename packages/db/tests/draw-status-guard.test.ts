import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DRAW_STATUS_TRANSITIONS,
  ORGANIZER_DRAW_TRANSITIONS,
  PLATFORM_REVIEW_DECISIONS,
} from '@clubedarifa/shared';
import { withContext, withTenant } from '../src/context.js';
import type { DbPool } from '../src/pool.js';
import {
  appPool,
  describeSkipReason,
  ensureMigrated,
  hasTestDatabase,
  ownerPool,
  resetFoundationTables,
  seedTenant,
  seedUser,
  unique,
} from './helpers/testDb.js';

/**
 * 0017 · o banco recusa mudanca de estado do sorteio fora das vias oficiais.
 *
 * Regressao do achado da auditoria: `app_user` levava RASCUNHO direto a ATIVA por
 * UPDATE. Aqui tudo roda pela conexao de RUNTIME (`app_user`), nunca pelo dono.
 */
describe.skipIf(!hasTestDatabase)(`0017 · guarda de estado do sorteio ${
  hasTestDatabase ? '' : describeSkipReason()
}`, () => {
  let owner: DbPool;
  let app: DbPool;

  beforeAll(async () => {
    await ensureMigrated();
    owner = ownerPool();
    app = appPool();
    await resetFoundationTables();
  }, 120_000);

  afterAll(async () => {
    await owner?.end();
    await app?.end();
  });

  async function novoSorteio(tenantId: string, status = 'RASCUNHO'): Promise<string> {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers)
       VALUES ($1, $2, 'T', 'P', 1000, 100) RETURNING id`,
      [tenantId, unique('d-')],
    );
    const id = rows[0]!.id;
    if (status !== 'RASCUNHO') {
      // O dono nao passa pelo gatilho: e assim que a fixture chega ao estado de partida.
      await owner.query(`UPDATE draws SET status = $2::draw_status WHERE id = $1`, [id, status]);
    }
    return id;
  }

  async function estado(id: string): Promise<string> {
    const { rows } = await owner.query<{ status: string }>(`SELECT status FROM draws WHERE id = $1`, [id]);
    return rows[0]!.status;
  }

  const comoOrganizador = (tenantId: string, fn: Parameters<typeof withTenant>[2]) =>
    withTenant(app, { tenantId }, fn);

  // ---------------------------------------------------------------------------
  describe('paridade com a fonte oficial (packages/shared)', () => {
    it('a tabela do banco e EXATAMENTE o que o shared declara', async () => {
      const esperado = new Set<string>();
      const par = (de: string, para: string, ator: string) => esperado.add(`${de}|${para}|${ator}`);

      for (const [de, destinos] of Object.entries(ORGANIZER_DRAW_TRANSITIONS)) {
        for (const para of destinos ?? []) par(de, para, 'ORGANIZER');
      }
      // Publicar resultado: o organizador, por `allowResultPublication` no resultService.
      par('APURAÇÃO', 'RESULTADO PUBLICADO', 'ORGANIZER');
      for (const para of PLATFORM_REVIEW_DECISIONS) par('REVISÃO COMPLIANCE', para, 'PLATFORM');
      // Funcoes do worker (app.worker_transition_draw).
      par('ATIVA', 'VENDAS ENCERRADAS', 'SYSTEM');
      par('PAUSADA', 'VENDAS ENCERRADAS', 'SYSTEM');
      par('AGENDADA', 'ATIVA', 'SYSTEM');
      par('VENDAS ENCERRADAS', 'APURAÇÃO', 'SYSTEM');

      const { rows } = await owner.query<{ from_status: string; to_status: string; actor: string }>(
        'SELECT from_status, to_status, actor FROM draw_status_transitions',
      );
      const noBanco = new Set(rows.map((r) => `${r.from_status}|${r.to_status}|${r.actor}`));
      expect([...noBanco].sort()).toEqual([...esperado].sort());
    });

    it('nenhuma linha da tabela sai da maquina completa (DRAW_STATUS_TRANSITIONS)', async () => {
      const { rows } = await owner.query<{ from_status: string; to_status: string }>(
        'SELECT DISTINCT from_status, to_status FROM draw_status_transitions',
      );
      for (const r of rows) {
        const permitidos = DRAW_STATUS_TRANSITIONS[r.from_status as keyof typeof DRAW_STATUS_TRANSITIONS];
        expect(permitidos, `${r.from_status} -> ${r.to_status}`).toContain(r.to_status);
      }
    });

    it('os papeis de runtime nao leem nem escrevem o catalogo', async () => {
      const tenant = await seedTenant(owner, unique('cat-'), 'Catalogo');
      await expect(
        comoOrganizador(tenant.tenantId, (db) => db.query('SELECT * FROM draw_status_transitions')),
      ).rejects.toThrow(/permission denied|permiss/i);
    });
  });

  // ---------------------------------------------------------------------------
  describe('o achado da auditoria', () => {
    it('app_user NAO leva RASCUNHO direto a ATIVA por UPDATE', async () => {
      const tenant = await seedTenant(owner, unique('a-'), 'A');
      const id = await novoSorteio(tenant.tenantId);

      await expect(
        comoOrganizador(tenant.tenantId, (db) => db.query(`UPDATE draws SET status = 'ATIVA' WHERE id = $1`, [id])),
      ).rejects.toThrow(/transicao de estado nao permitida/);
      expect(await estado(id)).toBe('RASCUNHO');
    });

    it('app_user NAO cria sorteio ja em ATIVA', async () => {
      const tenant = await seedTenant(owner, unique('i-'), 'I');
      await expect(
        comoOrganizador(tenant.tenantId, (db) =>
          db.query(
            `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers, status)
             VALUES ($1, $2, 'T', 'P', 1000, 100, 'ATIVA')`,
            [tenant.tenantId, unique('d-')],
          ),
        ),
      ).rejects.toThrow(/so pode nascer em RASCUNHO/);
    });

    it('criar em RASCUNHO segue funcionando', async () => {
      const tenant = await seedTenant(owner, unique('ok-'), 'OK');
      await comoOrganizador(tenant.tenantId, (db) =>
        db.query(
          `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers)
           VALUES ($1, $2, 'T', 'P', 1000, 100)`,
          [tenant.tenantId, unique('d-')],
        ),
      );
    });
  });

  // ---------------------------------------------------------------------------
  describe('o organizador so faz o que ORGANIZER_DRAW_TRANSITIONS diz', () => {
    it('RASCUNHO -> REVISAO e permitido', async () => {
      const tenant = await seedTenant(owner, unique('o1-'), 'O1');
      const id = await novoSorteio(tenant.tenantId);
      await comoOrganizador(tenant.tenantId, (db) =>
        db.query(`UPDATE draws SET status = 'REVISÃO COMPLIANCE' WHERE id = $1`, [id]),
      );
      expect(await estado(id)).toBe('REVISÃO COMPLIANCE');
    });

    it('sair da REVISAO para ATIVA/AGENDADA/RASCUNHO e da plataforma, nao do organizador', async () => {
      const tenant = await seedTenant(owner, unique('o2-'), 'O2');
      for (const alvo of ['ATIVA', 'AGENDADA', 'RASCUNHO']) {
        const id = await novoSorteio(tenant.tenantId, 'REVISÃO COMPLIANCE');
        await expect(
          comoOrganizador(tenant.tenantId, (db) =>
            db.query(`UPDATE draws SET status = $2::draw_status WHERE id = $1`, [id, alvo]),
          ),
          alvo,
        ).rejects.toThrow(/ator ORGANIZER/);
        expect(await estado(id)).toBe('REVISÃO COMPLIANCE');
      }
    });

    it('pausar, retomar e encerrar seguem permitidos', async () => {
      const tenant = await seedTenant(owner, unique('o3-'), 'O3');
      const id = await novoSorteio(tenant.tenantId, 'ATIVA');
      for (const para of ['PAUSADA', 'ATIVA', 'VENDAS ENCERRADAS']) {
        await comoOrganizador(tenant.tenantId, (db) =>
          db.query(`UPDATE draws SET status = $2::draw_status WHERE id = $1`, [id, para]),
        );
        expect(await estado(id)).toBe(para);
      }
    });

    it('transicao fora da maquina e recusada (ATIVA -> RASCUNHO, ENCERRADAS -> ATIVA)', async () => {
      const tenant = await seedTenant(owner, unique('o4-'), 'O4');
      const a = await novoSorteio(tenant.tenantId, 'ATIVA');
      await expect(
        comoOrganizador(tenant.tenantId, (db) => db.query(`UPDATE draws SET status = 'RASCUNHO' WHERE id = $1`, [a])),
      ).rejects.toThrow(/nao permitida/);
      const b = await novoSorteio(tenant.tenantId, 'VENDAS ENCERRADAS');
      await expect(
        comoOrganizador(tenant.tenantId, (db) => db.query(`UPDATE draws SET status = 'ATIVA' WHERE id = $1`, [b])),
      ).rejects.toThrow(/nao permitida/);
    });

    it('editar outras colunas de um sorteio ativo nao e barrado pelo gatilho', async () => {
      const tenant = await seedTenant(owner, unique('o5-'), 'O5');
      const id = await novoSorteio(tenant.tenantId, 'ATIVA');
      await comoOrganizador(tenant.tenantId, (db) =>
        db.query(`UPDATE draws SET description = 'texto novo' WHERE id = $1`, [id]),
      );
    });
  });

  // ---------------------------------------------------------------------------
  describe('plataforma', () => {
    it('so um Super Admin de verdade aprova; ligar a variavel nao basta', async () => {
      const tenant = await seedTenant(owner, unique('p1-'), 'P1');
      const id = await novoSorteio(tenant.tenantId, 'REVISÃO COMPLIANCE');
      const intruso = await seedUser(owner, `${unique('int-')}@x.test`, 'Intruso');

      // Variavel ligada, mas o usuario NAO esta em platform_admins.
      await expect(
        withContext(app, { userId: intruso.userId, tenantId: tenant.tenantId, platformAccess: true }, (db) =>
          db.query(`UPDATE draws SET status = 'ATIVA' WHERE id = $1`, [id]),
        ),
      ).rejects.toThrow(/ator ORGANIZER/);
      expect(await estado(id)).toBe('REVISÃO COMPLIANCE');
    });

    it('o Super Admin aprova, agenda ou devolve a REVISAO; mas nao pula a revisao', async () => {
      const tenant = await seedTenant(owner, unique('p2-'), 'P2');
      const admin = await seedUser(owner, `${unique('adm-')}@x.test`, 'Admin');
      await owner.query("INSERT INTO platform_admins (user_id, role) VALUES ($1, 'PLATFORM_OPERATIONS')", [
        admin.userId,
      ]);
      const contexto = { userId: admin.userId, tenantId: tenant.tenantId, platformAccess: true };

      for (const alvo of ['ATIVA', 'AGENDADA', 'RASCUNHO']) {
        const id = await novoSorteio(tenant.tenantId, 'REVISÃO COMPLIANCE');
        await withContext(app, contexto, (db) =>
          db.query(`UPDATE draws SET status = $2::draw_status WHERE id = $1`, [id, alvo]),
        );
        expect(await estado(id)).toBe(alvo);
      }

      // A plataforma tambem nao leva RASCUNHO direto a ATIVA: a revisao e o unico caminho.
      const rascunho = await novoSorteio(tenant.tenantId);
      await expect(
        withContext(app, contexto, (db) => db.query(`UPDATE draws SET status = 'ATIVA' WHERE id = $1`, [rascunho])),
      ).rejects.toThrow(/nao permitida/);
    });
  });

  // ---------------------------------------------------------------------------
  it('o dono do schema (migrations, fixtures, reparo) nao e alcancado', async () => {
    const tenant = await seedTenant(owner, unique('dono-'), 'Dono');
    const id = await novoSorteio(tenant.tenantId);
    await owner.query(`UPDATE draws SET status = 'ATIVA' WHERE id = $1`, [id]);
    expect(await estado(id)).toBe('ATIVA');
  });
});
