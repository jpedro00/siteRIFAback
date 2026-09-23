import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DRAW_NUMBER_STATUSES,
  DRAW_STATUSES,
  MEMBERSHIP_ROLES,
  PLATFORM_ROLES,
} from '@campaigns/shared';
import type { DbPool } from '../src/pool.js';
import {
  describeSkipReason,
  ensureMigrated,
  hasTestDatabase,
  ownerPool,
} from './helpers/testDb.js';

/**
 * E3 · vocabulario unico de status: uma CHECK constraint desatualizada no
 * banco recusa inserts que o codigo considera validos.
 *
 * Este teste falha se o vocabulario do banco e o do codigo divergirem em
 * QUALQUER direcao: valor a mais, valor a menos ou ordem diferente.
 *
 * Secao 8 do pedido, item "enums da aplicacao x constraints do banco".
 */
describe.skipIf(!hasTestDatabase)(`E3 · enums do banco e do codigo ${
  hasTestDatabase ? '' : describeSkipReason()
}`, () => {
  let owner: DbPool;

  beforeAll(async () => {
    await ensureMigrated();
    owner = ownerPool();
  });

  afterAll(async () => {
    await owner?.end();
  });

  async function enumLabels(typeName: string): Promise<string[]> {
    const { rows } = await owner.query<{ label: string }>(
      `SELECT e.enumlabel AS label
         FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname = $1
        ORDER BY e.enumsortorder`,
      [typeName],
    );
    return rows.map((row) => row.label);
  }

  it('draw_status do banco e identico a DRAW_STATUSES do codigo', async () => {
    expect(await enumLabels('draw_status')).toEqual([...DRAW_STATUSES]);
  });

  it('draw_number_status do banco e identico a DRAW_NUMBER_STATUSES do codigo', async () => {
    expect(await enumLabels('draw_number_status')).toEqual([...DRAW_NUMBER_STATUSES]);
  });

  it('membership_role do banco e identico a MEMBERSHIP_ROLES do codigo', async () => {
    expect(await enumLabels('membership_role')).toEqual([...MEMBERSHIP_ROLES]);
  });

  it('platform_role do banco e identico a PLATFORM_ROLES do codigo', async () => {
    expect(await enumLabels('platform_role')).toEqual([...PLATFORM_ROLES]);
  });

  it('cada estado de sorteio do codigo e aceito pelo banco', async () => {
    // E3 aconteceu porque um valor do codigo era recusado pelo banco.
    // Aqui todos sao convertidos de verdade.
    for (const status of DRAW_STATUSES) {
      const { rows } = await owner.query<{ value: string }>('SELECT $1::draw_status AS value', [
        status,
      ]);
      expect(rows[0]?.value).toBe(status);
    }
  });

  it('cada estado de numero do codigo e aceito pelo banco', async () => {
    for (const status of DRAW_NUMBER_STATUSES) {
      const { rows } = await owner.query<{ value: string }>(
        'SELECT $1::draw_number_status AS value',
        [status],
      );
      expect(rows[0]?.value).toBe(status);
    }
  });

  it('"CATIVO PENDENTE" e aceito e "CATIVO_PENDENTE" e recusado', async () => {
    const { rows } = await owner.query('SELECT $1::draw_number_status AS value', [
      'CATIVO PENDENTE',
    ]);
    expect(rows[0]).toBeTruthy();

    await expect(
      owner.query('SELECT $1::draw_number_status AS value', ['CATIVO_PENDENTE']),
    ).rejects.toThrow(/invalid input value/i);
  });

  it('estado traduzido para ingles e recusado pelo banco', async () => {
    for (const traduzido of ['DRAFT', 'ACTIVE', 'PAID', 'FREE']) {
      await expect(owner.query('SELECT $1::draw_status AS value', [traduzido])).rejects.toThrow();
    }
  });
});
