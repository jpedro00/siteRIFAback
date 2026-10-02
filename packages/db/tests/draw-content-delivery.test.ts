import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/context.js';
import type { DbPool } from '../src/pool.js';
import {
  appPool,
  describeSkipReason,
  ensureMigrated,
  hasTestDatabase,
  ownerPool,
  resetFoundationTables,
  seedTenant,
  unique,
} from './helpers/testDb.js';

/**
 * 0021 · conteudo do sorteio (subtitulo, categoria, regulamento, personalizacao, valor do
 * premio) e entrega do premio. Tudo que importa e conferido PELO BANCO, com o papel de
 * runtime (`app_user`) e nao com o dono.
 */
describe.skipIf(!hasTestDatabase)(`0021 · conteudo do sorteio e entrega ${
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

  /** Comunidade nova; `id` abrevia `tenantId`. */
  const tenant = async () => {
    const t = await seedTenant(owner, unique('c-'), 'Comunidade de teste');
    return { id: t.tenantId };
  };

  async function novoSorteio(tenantId: string, status = 'RASCUNHO'): Promise<string> {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers)
       VALUES ($1, $2, 'T', 'P', 1000, 100) RETURNING id`,
      [tenantId, unique('d-')],
    );
    if (status !== 'RASCUNHO') {
      await owner.query(`UPDATE draws SET status = $2::draw_status WHERE id = $1`, [rows[0]!.id, status]);
    }
    return rows[0]!.id;
  }

  const estado = async (id: string) =>
    (await owner.query<{ s: string }>('SELECT status::text AS s FROM draws WHERE id = $1', [id])).rows[0]!.s;

  const entrega = (tenantId: string, drawId: string, extra = "'RETIRADA'") =>
    owner.query(
      `INSERT INTO draw_deliveries (tenant_id, draw_id, method, delivered_at) VALUES ($1, $2, ${extra}, now())`,
      [tenantId, drawId],
    );

  // ---------------------------------------------------------------------------
  describe('colunas novas de draws e prizes', () => {
    it('nascem opcionais, e a personalizacao nasce vazia (herda o padrao)', async () => {
      const t = await tenant();
      const id = await novoSorteio(t.id);
      const { rows } = await owner.query(
        'SELECT subtitle, category, regulation, customization FROM draws WHERE id = $1',
        [id],
      );
      expect(rows[0]).toEqual({ subtitle: null, category: null, regulation: null, customization: {} });
    });

    it('o banco recusa texto vazio, texto gigante e personalizacao que nao e objeto', async () => {
      const t = await tenant();
      const id = await novoSorteio(t.id);
      const tenta = (sql: string, params: unknown[] = []) => owner.query(sql, [id, ...params]);

      await expect(tenta(`UPDATE draws SET subtitle = '   ' WHERE id = $1`)).rejects.toThrow(/draws_subtitle_len/);
      await expect(tenta(`UPDATE draws SET subtitle = $2 WHERE id = $1`, ['x'.repeat(161)])).rejects.toThrow(/draws_subtitle_len/);
      await expect(tenta(`UPDATE draws SET category = $2 WHERE id = $1`, ['x'.repeat(41)])).rejects.toThrow(/draws_category_len/);
      await expect(tenta(`UPDATE draws SET regulation = '' WHERE id = $1`)).rejects.toThrow(/draws_regulation_len/);
      await expect(tenta(`UPDATE draws SET regulation = $2 WHERE id = $1`, ['r'.repeat(20001)])).rejects.toThrow(/draws_regulation_len/);
      await expect(tenta(`UPDATE draws SET customization = '[]'::jsonb WHERE id = $1`)).rejects.toThrow(/draws_customization_object/);
      await expect(
        tenta(`UPDATE draws SET customization = jsonb_build_object('x', $2::text) WHERE id = $1`, ['y'.repeat(5000)]),
      ).rejects.toThrow(/draws_customization_object/);
    });

    it('valor estimado do premio: de 0 a 2 bilhoes de centavos', async () => {
      const t = await tenant();
      const id = await novoSorteio(t.id);
      const premio = (valor: number) =>
        owner.query(
          `INSERT INTO prizes (tenant_id, draw_id, position, name, estimated_value_cents)
           VALUES ($1, $2, $3, 'Premio', $4)`,
          [t.id, id, Math.floor(Math.random() * 15) + 1, valor],
        );
      await expect(premio(-1)).rejects.toThrow(/prizes_estimated_value_range/);
      await expect(premio(2_000_000_001)).rejects.toThrow(/prizes_estimated_value_range/);
      await premio(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('entrega do premio', () => {
    it('so se registra com o resultado PUBLICADO', async () => {
      const t = await tenant();
      for (const antes of ['RASCUNHO', 'ATIVA', 'APURAÇÃO']) {
        const id = await novoSorteio(t.id, antes);
        await expect(entrega(t.id, id), antes).rejects.toThrow(/resultado publicado/);
      }
      const publicado = await novoSorteio(t.id, 'RESULTADO PUBLICADO');
      await entrega(t.id, publicado);
    });

    it('uma por sorteio, com forma conhecida e rastreio sem excesso', async () => {
      const t = await tenant();
      const id = await novoSorteio(t.id, 'RESULTADO PUBLICADO');
      await entrega(t.id, id);
      await expect(entrega(t.id, id)).rejects.toThrow(/draw_deliveries_one_per_draw/);

      const outro = await novoSorteio(t.id, 'RESULTADO PUBLICADO');
      await expect(entrega(t.id, outro, "'DRONE'")).rejects.toThrow(/draw_deliveries_method_known/);
      await expect(
        owner.query(
          `INSERT INTO draw_deliveries (tenant_id, draw_id, method, delivered_at, tracking_code)
           VALUES ($1, $2, 'ENVIO', now(), $3)`,
          [t.id, outro, 'x'.repeat(101)],
        ),
      ).rejects.toThrow(/draw_deliveries_tracking_len/);
    });

    it('o runtime (app_user) registra e le a PROPRIA comunidade; a outra nao ve nem alcanca', async () => {
      const a = await tenant();
      const b = await tenant();
      const sorteioA = await novoSorteio(a.id, 'RESULTADO PUBLICADO');

      await withTenant(app, { tenantId: a.id }, async (c) => {
        await c.query(
          `INSERT INTO draw_deliveries (tenant_id, draw_id, method, delivered_at) VALUES ($1, $2, 'ENVIO', now())`,
          [a.id, sorteioA],
        );
        const { rows } = await c.query('SELECT method FROM draw_deliveries WHERE draw_id = $1', [sorteioA]);
        expect(rows).toHaveLength(1);
      });

      // B nao enxerga a entrega de A (RLS)...
      await withTenant(app, { tenantId: b.id }, async (c) => {
        const { rows } = await c.query('SELECT 1 FROM draw_deliveries WHERE draw_id = $1', [sorteioA]);
        expect(rows).toHaveLength(0);
      });
      // ...e nao grava no sorteio de A, nem declarando a propria comunidade (FK composta) nem a de A (RLS).
      const sorteioA2 = await novoSorteio(a.id, 'RESULTADO PUBLICADO');
      await expect(
        withTenant(app, { tenantId: b.id }, (c) =>
          c.query(`INSERT INTO draw_deliveries (tenant_id, draw_id, method, delivered_at) VALUES ($1, $2, 'ENVIO', now())`, [b.id, sorteioA2]),
        ),
      ).rejects.toThrow();
      await expect(
        withTenant(app, { tenantId: b.id }, (c) =>
          c.query(`INSERT INTO draw_deliveries (tenant_id, draw_id, method, delivered_at) VALUES ($1, $2, 'ENVIO', now())`, [a.id, sorteioA2]),
        ),
      ).rejects.toThrow(/row-level security|violates/);
    });

    it('o runtime corrige a forma/data/rastreio, mas nao muda a quem a entrega pertence', async () => {
      const a = await tenant();
      const id = await novoSorteio(a.id, 'RESULTADO PUBLICADO');
      await entrega(a.id, id);
      await withTenant(app, { tenantId: a.id }, async (c) => {
        await c.query(`UPDATE draw_deliveries SET method = 'TRANSFERENCIA', tracking_code = 'ABC' WHERE draw_id = $1`, [id]);
        await expect(c.query(`UPDATE draw_deliveries SET draw_id = gen_random_uuid() WHERE draw_id = $1`, [id])).rejects.toThrow(/permission denied/);
      });
      await expect(
        withTenant(app, { tenantId: a.id }, (c) => c.query('DELETE FROM draw_deliveries WHERE draw_id = $1', [id])),
      ).rejects.toThrow(/permission denied/);
    });

    it('depois de ARQUIVADA, a entrega fica somente leitura', async () => {
      const t = await tenant();
      const id = await novoSorteio(t.id, 'RESULTADO PUBLICADO');
      await entrega(t.id, id);
      await owner.query(`UPDATE draws SET status = 'ARQUIVADA' WHERE id = $1`, [id]);
      await expect(
        owner.query(`UPDATE draw_deliveries SET notes = 'tarde' WHERE draw_id = $1`, [id]),
      ).rejects.toThrow(/resultado publicado/);
    });
  });

  // ---------------------------------------------------------------------------
  describe('arquivar', () => {
    it('exige entrega registrada, para qualquer papel (inclusive o dono do schema)', async () => {
      const t = await tenant();
      const id = await novoSorteio(t.id, 'RESULTADO PUBLICADO');
      await expect(owner.query(`UPDATE draws SET status = 'ARQUIVADA' WHERE id = $1`, [id])).rejects.toThrow(/registre a entrega/);
      expect(await estado(id)).toBe('RESULTADO PUBLICADO');

      await entrega(t.id, id);
      await owner.query(`UPDATE draws SET status = 'ARQUIVADA' WHERE id = $1`, [id]);
      expect(await estado(id)).toBe('ARQUIVADA');
    });

    it('o organizador (runtime) arquiva COM entrega; sem entrega o banco recusa', async () => {
      const t = await tenant();
      const sem = await novoSorteio(t.id, 'RESULTADO PUBLICADO');
      const com = await novoSorteio(t.id, 'RESULTADO PUBLICADO');
      await entrega(t.id, com);

      await expect(
        withTenant(app, { tenantId: t.id }, (c) => c.query(`UPDATE draws SET status = 'ARQUIVADA' WHERE id = $1`, [sem])),
      ).rejects.toThrow(/registre a entrega/);
      await withTenant(app, { tenantId: t.id }, (c) => c.query(`UPDATE draws SET status = 'ARQUIVADA' WHERE id = $1`, [com]));
      expect(await estado(com)).toBe('ARQUIVADA');
    });
  });
});
