import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { DRAW_CLOSE_MODES, gridLabelRange, DEFAULT_REMAINING_THRESHOLDS } from '@clubedarifa/shared';
import { MIGRATIONS_DIR, loadMigrations, migrate } from '../src/migrator.js';
import { withTenant } from '../src/context.js';
import { pgConnectionConfig } from '../src/ssl.js';
import type { DbPool } from '../src/pool.js';
import {
  TEST_OWNER_URL,
  appPool,
  describeSkipReason,
  ensureMigrated,
  hasTestDatabase,
  ownerPool,
  resetFoundationTables,
  seedTenant,
  unique,
} from './helpers/testDb.js';

const { Client } = pg;

/**
 * 0012 · sorteio alinhado ao DOC-01 §18.
 *
 * Duas frentes: (1) o que acontece com os dados que JA existiam quando a
 * migration roda; (2) o que o esquema novo garante dali em diante.
 */
describe.skipIf(!hasTestDatabase)(`0012 · sorteio DOC-01 ${
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

  // -------------------------------------------------------------------------
  describe('migracao de dados existentes', () => {
    const tempDatabase = `clubedarifa_mig0012_${Math.floor(Math.random() * 1e9).toString(36)}`;
    let tempUrl = '';
    let antesDir = '';

    function urlWith(name: string): string {
      const url = new URL(TEST_OWNER_URL);
      url.pathname = `/${name}`;
      return url.toString();
    }

    beforeAll(async () => {
      tempUrl = urlWith(tempDatabase);
      const admin = new Client(pgConnectionConfig(TEST_OWNER_URL));
      await admin.connect();
      try {
        await admin.query(`CREATE DATABASE "${tempDatabase}"`);
      } finally {
        await admin.end();
      }

      // So as migrations ANTERIORES a 0012: o estado em que um banco real esta
      // no instante anterior ao deploy.
      antesDir = await mkdtemp(join(tmpdir(), 'mig-antes-'));
      for (const file of await loadMigrations()) {
        if (file.filename < '0012') await copyFile(join(MIGRATIONS_DIR, file.filename), join(antesDir, file.filename));
      }
    }, 120_000);

    afterAll(async () => {
      const admin = new Client(pgConnectionConfig(TEST_OWNER_URL));
      await admin.connect();
      try {
        await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [
          tempDatabase,
        ]);
        await admin.query(`DROP DATABASE IF EXISTS "${tempDatabase}"`);
      } finally {
        await admin.end();
      }
      if (antesDir) await rm(antesDir, { recursive: true, force: true });
    });

    it('copia o preco sem perda, gera o premio da posicao 1 e preserva o estado', async () => {
      await migrate(tempUrl, antesDir);

      const db = new Client(pgConnectionConfig(tempUrl));
      await db.connect();
      try {
        const { rows: t } = await db.query<{ id: string }>(
          "INSERT INTO tenants (slug, name) VALUES ('legado', 'Legado') RETURNING id",
        );
        const tenantId = t[0]!.id;
        const inserir = async (slug: string, preco: number, grade: number, status: string, img: string | null) => {
          const { rows } = await db.query<{ id: string }>(
            `INSERT INTO draws (tenant_id, slug, title, prize_name, prize_description,
                                prize_image_url, unit_price_cents, total_numbers, status)
             VALUES ($1, $2, $3, 'Moto 0 km', 'Zero km', $4, $5, $6, $7::draw_status)
             RETURNING id`,
            [tenantId, slug, `Sorteio ${slug}`, img, preco, grade, status],
          );
          return rows[0]!.id;
        };
        const a = await inserir('com-https', 1500, 100, 'ATIVA', 'https://cdn.exemplo/moto.jpg');
        const b = await inserir('com-http', 2500, 1000, 'PAUSADA', 'http://antigo.exemplo/moto.jpg');
        const c = await inserir('sem-imagem', 990, 500, 'RASCUNHO', null);

        await migrate(tempUrl); // aplica a 0012 sobre dados existentes

        const { rows: draws } = await db.query(
          `SELECT id, unit_price_cents, ticket_price_cents, number_count, label_digits,
                  close_mode, thresholds, status, promotional_price_cents
             FROM draws ORDER BY slug`,
        );
        const porId = new Map(draws.map((d) => [d.id as string, d]));
        for (const [id, preco, grade, digitos, estado] of [
          [a, 1500, 100, 2, 'ATIVA'],
          [b, 2500, 1000, 3, 'PAUSADA'],
          [c, 990, 500, 3, 'RASCUNHO'],
        ] as const) {
          const d = porId.get(id)!;
          expect(d.ticket_price_cents, 'preco copiado').toBe(preco);
          expect(d.unit_price_cents, 'preco antigo intacto').toBe(preco);
          expect(d.number_count).toBe(grade);
          expect(d.label_digits).toBe(digitos);
          expect(d.status, 'estado preservado').toBe(estado);
          expect(d.close_mode).toBe('AO_ESGOTAR');
          expect(d.thresholds).toEqual([...DEFAULT_REMAINING_THRESHOLDS]);
          expect(d.promotional_price_cents).toBeNull();
        }

        const { rows: prizes } = await db.query(
          'SELECT draw_id, position, name, description, image_url FROM prizes ORDER BY draw_id',
        );
        expect(prizes).toHaveLength(3);
        const premio = new Map(prizes.map((p) => [p.draw_id as string, p]));
        expect(premio.get(a)).toMatchObject({ position: 1, name: 'Moto 0 km', description: 'Zero km' });
        expect(premio.get(a)!.image_url).toBe('https://cdn.exemplo/moto.jpg');
        // http nao passa na CHECK: o link legado fica so na coluna antiga.
        expect(premio.get(b)!.image_url).toBeNull();
        expect(premio.get(c)!.image_url).toBeNull();
      } finally {
        await db.end();
      }
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  describe('RN13 · rotulos da grade', () => {
    it('label_digits e number_count sao gerados a partir de total_numbers', async () => {
      const tenant = await seedTenant(owner, unique('rn13-'), 'RN13');
      const esperado: [number, number, string, string][] = [
        [100, 2, '00', '99'],
        [500, 3, '000', '499'],
        [1000, 3, '000', '999'],
      ];
      for (const [grade, digitos, primeiro, ultimo] of esperado) {
        const { rows } = await owner.query<{ label_digits: number; number_count: number }>(
          `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers)
           VALUES ($1, $2, 'T', 'P', 1000, $3) RETURNING label_digits, number_count`,
          [tenant.tenantId, unique('g-'), grade],
        );
        expect(rows[0]!.label_digits).toBe(digitos);
        expect(rows[0]!.number_count).toBe(grade);
        expect(gridLabelRange(grade as 100 | 500 | 1000)).toEqual({ first: primeiro, last: ultimo });
      }
    });

    it('a coluna gerada nao aceita ser gravada', async () => {
      const tenant = await seedTenant(owner, unique('rn13g-'), 'RN13');
      await expect(
        owner.query(
          `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers, label_digits)
           VALUES ($1, $2, 'T', 'P', 1000, 100, 3)`,
          [tenant.tenantId, unique('g-')],
        ),
      ).rejects.toThrow(/non-DEFAULT|generated/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('preco, promocao e cronograma', () => {
    let tenantId: string;
    let n = 0;

    beforeAll(async () => {
      tenantId = (await seedTenant(owner, unique('preco-'), 'Preco')).tenantId;
    });

    function novo(extra: string, valores: unknown[] = []) {
      n += 1;
      return owner.query(
        `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers ${extra.split('|')[0] ?? ''})
         VALUES ($1, $2, 'T', 'P', 1000, 100 ${extra.split('|')[1] ?? ''})`,
        [tenantId, `d-${unique('x-')}-${n}`, ...valores],
      );
    }

    it('promocional MENOR que o cheio, com prazo, e aceito', async () => {
      await expect(
        novo(', promotional_price_cents, promo_until|, 800, now() + interval \'1 day\''),
      ).resolves.toBeDefined();
    });

    it('promocional igual ou maior que o cheio e recusado', async () => {
      await expect(novo(', promotional_price_cents, promo_until|, 1000, now()')).rejects.toThrow(
        /draws_promo_below_ticket/,
      );
      await expect(novo(', promotional_price_cents, promo_until|, 1200, now()')).rejects.toThrow(
        /draws_promo_below_ticket/,
      );
    });

    it('promocional sem prazo (ou prazo sem promocional) e recusado', async () => {
      await expect(novo(', promotional_price_cents|, 800')).rejects.toThrow(/draws_promo_pair/);
      await expect(novo(', promo_until|, now()')).rejects.toThrow(/draws_promo_pair/);
    });

    it('fechamento tem de ser ANTERIOR a data do sorteio', async () => {
      await expect(
        novo(", draw_date, close_at|, now() + interval '1 day', now() + interval '2 days'"),
      ).rejects.toThrow(/draws_close_before_draw/);
      await expect(
        novo(", draw_date, close_at|, now() + interval '2 days', now() + interval '1 day'"),
      ).resolves.toBeDefined();
    });

    it('inicio das vendas tem de ser anterior ao fechamento', async () => {
      await expect(
        novo(", sales_start_at, close_at|, now() + interval '2 days', now() + interval '1 day'"),
      ).rejects.toThrow(/draws_sales_start_before_close/);
    });

    it('limiares: padrao {25,10}; vazio, zero, 100 e crescente sao recusados', async () => {
      const { rows } = await owner.query<{ thresholds: number[] }>(
        `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers)
         VALUES ($1, $2, 'T', 'P', 1000, 100) RETURNING thresholds`,
        [tenantId, unique('t-')],
      );
      expect(rows[0]!.thresholds).toEqual([25, 10]);

      for (const ruim of ["'{}'", "'{0,10}'", "'{100,10}'", "'{10,25}'", "'{25,25}'"]) {
        await expect(novo(`, thresholds|, ${ruim}::int[]`), ruim).rejects.toThrow(/draws_thresholds_valid/);
      }
      await expect(novo(", thresholds|, '{50,25,10}'::int[]")).resolves.toBeDefined();
    });

    it('modo de fechamento: paridade com o codigo e valor desconhecido recusado', async () => {
      const { rows } = await owner.query<{ label: string }>(
        `SELECT e.enumlabel AS label FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
          WHERE t.typname = 'draw_close_mode' ORDER BY e.enumsortorder`,
      );
      expect(rows.map((r) => r.label)).toEqual([...DRAW_CLOSE_MODES]);
      await expect(novo(", close_mode|, 'QUALQUER'")).rejects.toThrow(/draw_close_mode/);
    });

    it('link da imagem so aceita https em sorteio novo', async () => {
      await expect(novo(', prize_image_url|, \'http://x.exemplo/a.jpg\'')).rejects.toThrow(
        /draws_prize_image_https/,
      );
      await expect(novo(', prize_image_url|, \'https://x.exemplo/a.jpg\'')).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('espelho do preco legado', () => {
    let tenantId: string;

    beforeAll(async () => {
      tenantId = (await seedTenant(owner, unique('legado-'), 'Legado')).tenantId;
    });

    it('API anterior (so unit_price_cents) continua gravando', async () => {
      const { rows } = await owner.query(
        `INSERT INTO draws (tenant_id, slug, title, prize_name, unit_price_cents, total_numbers)
         VALUES ($1, $2, 'T', 'P', 1700, 100) RETURNING ticket_price_cents, unit_price_cents`,
        [tenantId, unique('a-')],
      );
      expect(rows[0]).toMatchObject({ ticket_price_cents: 1700, unit_price_cents: 1700 });
    });

    it('API nova (so ticket_price_cents) mantem a coluna antiga igual', async () => {
      const { rows } = await owner.query(
        `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers)
         VALUES ($1, $2, 'T', 'P', 1800, 100) RETURNING id, ticket_price_cents, unit_price_cents`,
        [tenantId, unique('b-')],
      );
      expect(rows[0]).toMatchObject({ ticket_price_cents: 1800, unit_price_cents: 1800 });

      await owner.query('UPDATE draws SET ticket_price_cents = 1900 WHERE id = $1', [rows[0]!.id]);
      const { rows: depois } = await owner.query(
        'SELECT ticket_price_cents, unit_price_cents FROM draws WHERE id = $1',
        [rows[0]!.id],
      );
      expect(depois[0]).toMatchObject({ ticket_price_cents: 1900, unit_price_cents: 1900 });

      await owner.query('UPDATE draws SET unit_price_cents = 2000 WHERE id = $1', [rows[0]!.id]);
      const { rows: legado } = await owner.query(
        'SELECT ticket_price_cents FROM draws WHERE id = $1',
        [rows[0]!.id],
      );
      expect(legado[0]!.ticket_price_cents).toBe(2000);
    });
  });

  // -------------------------------------------------------------------------
  describe('RN14 · grade e preco base travados depois da primeira reserva', () => {
    let tenantId: string;

    async function sorteio(): Promise<string> {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers, status)
         VALUES ($1, $2, 'T', 'P', 1000, 100, 'ATIVA') RETURNING id`,
        [tenantId, unique('r14-')],
      );
      return rows[0]!.id;
    }

    async function reservar(drawId: string): Promise<void> {
      await owner.query(
        `INSERT INTO reservations (tenant_id, draw_id, expires_at)
         VALUES ($1, $2, now() + interval '30 minutes')`,
        [tenantId, drawId],
      );
    }

    beforeAll(async () => {
      tenantId = (await seedTenant(owner, unique('rn14-'), 'RN14')).tenantId;
    });

    it('sem reserva, grade e preco ainda mudam', async () => {
      const id = await sorteio();
      await owner.query('UPDATE draws SET total_numbers = 500, ticket_price_cents = 2000 WHERE id = $1', [id]);
      const { rows } = await owner.query('SELECT total_numbers, ticket_price_cents FROM draws WHERE id = $1', [id]);
      expect(rows[0]).toMatchObject({ total_numbers: 500, ticket_price_cents: 2000 });
    });

    it('com reserva, a grade NAO muda', async () => {
      const id = await sorteio();
      await reservar(id);
      await expect(owner.query('UPDATE draws SET total_numbers = 500 WHERE id = $1', [id])).rejects.toThrow(/RN14/);
    });

    it('com reserva, o preco base NAO muda — nem pela coluna antiga', async () => {
      const id = await sorteio();
      await reservar(id);
      await expect(owner.query('UPDATE draws SET ticket_price_cents = 2000 WHERE id = $1', [id])).rejects.toThrow(
        /RN14/,
      );
      await expect(owner.query('UPDATE draws SET unit_price_cents = 2000 WHERE id = $1', [id])).rejects.toThrow(
        /RN14/,
      );
    });

    it('com reserva, o preco promocional e o titulo ainda podem mudar', async () => {
      const id = await sorteio();
      await reservar(id);
      await expect(
        owner.query(
          `UPDATE draws SET title = 'Novo', promotional_price_cents = 700,
                            promo_until = now() + interval '1 day' WHERE id = $1`,
          [id],
        ),
      ).resolves.toBeDefined();
    });

    it('a trava vale tambem para o papel da aplicacao', async () => {
      const id = await sorteio();
      await reservar(id);
      await expect(
        withTenant(app, { tenantId }, (c) => c.query('UPDATE draws SET total_numbers = 500 WHERE id = $1', [id])),
      ).rejects.toThrow(/RN14/);
    });
  });

  // -------------------------------------------------------------------------
  describe('prizes', () => {
    let a: { tenantId: string };
    let b: { tenantId: string };
    let drawA: string;
    let drawB: string;

    async function novoSorteio(tenantId: string, status = 'RASCUNHO'): Promise<string> {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers, status)
         VALUES ($1, $2, 'T', 'P', 1000, 100, $3::draw_status) RETURNING id`,
        [tenantId, unique('pz-'), status],
      );
      return rows[0]!.id;
    }

    beforeAll(async () => {
      a = await seedTenant(owner, unique('pza-'), 'A');
      b = await seedTenant(owner, unique('pzb-'), 'B');
      drawA = await novoSorteio(a.tenantId);
      drawB = await novoSorteio(b.tenantId);
      await owner.query("INSERT INTO prizes (tenant_id, draw_id, position, name) VALUES ($1, $2, 1, 'Moto')", [a.tenantId, drawA]);
      await owner.query("INSERT INTO prizes (tenant_id, draw_id, position, name) VALUES ($1, $2, 1, 'Carro')", [b.tenantId, drawB]);
    });

    it('posicao unica por sorteio', async () => {
      await expect(
        owner.query("INSERT INTO prizes (tenant_id, draw_id, position, name) VALUES ($1, $2, 1, 'Outro')", [a.tenantId, drawA]),
      ).rejects.toThrow(/prizes_draw_position_key/);
      await expect(
        owner.query("INSERT INTO prizes (tenant_id, draw_id, position, name) VALUES ($1, $2, 2, 'Segundo')", [a.tenantId, drawA]),
      ).resolves.toBeDefined();
    });

    it('premio da comunidade A nao aponta para sorteio da comunidade B (FK composta)', async () => {
      await expect(
        owner.query("INSERT INTO prizes (tenant_id, draw_id, position, name) VALUES ($1, $2, 9, 'Cruzado')", [a.tenantId, drawB]),
      ).rejects.toThrow(/prizes_draw_fk/);
    });

    it('imagem so em https e nome nao vazio', async () => {
      await expect(
        owner.query(
          "INSERT INTO prizes (tenant_id, draw_id, position, name, image_url) VALUES ($1, $2, 10, 'X', 'http://a/b')",
          [a.tenantId, drawA],
        ),
      ).rejects.toThrow(/prizes_image_https/);
      await expect(
        owner.query("INSERT INTO prizes (tenant_id, draw_id, position, name) VALUES ($1, $2, 11, '  ')", [a.tenantId, drawA]),
      ).rejects.toThrow(/prizes_name_not_blank/);
    });

    it('premio so muda com o sorteio em RASCUNHO', async () => {
      const ativo = await novoSorteio(a.tenantId);
      await owner.query("INSERT INTO prizes (tenant_id, draw_id, position, name) VALUES ($1, $2, 1, 'Fixo')", [a.tenantId, ativo]);
      await owner.query("UPDATE draws SET status = 'ATIVA' WHERE id = $1", [ativo]);

      await expect(owner.query("UPDATE prizes SET name = 'Trocado' WHERE draw_id = $1", [ativo])).rejects.toThrow(
        /so muda com o sorteio em RASCUNHO/,
      );
      await expect(owner.query('DELETE FROM prizes WHERE draw_id = $1', [ativo])).rejects.toThrow(
        /so muda com o sorteio em RASCUNHO/,
      );
      await expect(
        owner.query("INSERT INTO prizes (tenant_id, draw_id, position, name) VALUES ($1, $2, 2, 'Novo')", [a.tenantId, ativo]),
      ).rejects.toThrow(/so muda com o sorteio em RASCUNHO/);
    });

    it('RLS · a comunidade A nao le, nao altera e nao insere premio da B', async () => {
      const vistos = await withTenant(app, { tenantId: a.tenantId }, async (c) => {
        const { rows } = await c.query<{ name: string }>('SELECT name FROM prizes ORDER BY position');
        return rows.map((r) => r.name);
      });
      expect(vistos).toContain('Moto');
      expect(vistos).not.toContain('Carro');

      const alterados = await withTenant(app, { tenantId: a.tenantId }, (c) =>
        c.query("UPDATE prizes SET name = 'Roubado' WHERE draw_id = $1", [drawB]),
      );
      expect(alterados.rowCount).toBe(0);

      await expect(
        withTenant(app, { tenantId: a.tenantId }, (c) =>
          c.query("INSERT INTO prizes (tenant_id, draw_id, position, name) VALUES ($1, $2, 5, 'X')", [b.tenantId, drawB]),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it('sem contexto de comunidade, nenhum premio e visivel', async () => {
      const { rows } = await app.query('SELECT count(*)::int AS n FROM prizes');
      expect(rows[0]!.n).toBe(0);
    });

    it('anon, authenticated e service_role nao tem privilegio em prizes', async () => {
      const { rows } = await owner.query<{ papel: string; tem: boolean }>(
        `SELECT r.rolname AS papel,
                has_table_privilege(r.rolname, 'public.prizes', 'SELECT,INSERT,UPDATE,DELETE') AS tem
           FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role')`,
      );
      for (const row of rows) expect(row.tem, row.papel).toBe(false);
    });
  });
});
