import { describe, expect, it } from 'vitest';
import {
  computeDrawResult,
  correctResultRequestSchema,
  publishResultRequestSchema,
  gridLabelRange,
} from '../src/index.js';

/**
 * Calculo do contemplado. RN13 (rotulos) e RN09/RN20 (prova refazivel).
 *
 * Os numeros vendidos vem do SNAPSHOT; a funcao e pura, entao o teste e uma
 * tabela: entrada -> vencedor -> tentativas.
 */
describe('computeDrawResult · grade de 100 (rotulos 00–99)', () => {
  it('numero vendido: os 2 ultimos digitos decidem', () => {
    const r = computeDrawResult({ federalNumber: '48372', totalNumbers: 100, soldNumbers: [72, 10] });
    expect(r).toMatchObject({ candidateNumber: 72, winningNumber: 72 });
    expect(r.attempts).toEqual([{ number: 72, inGrid: true, sold: true }]);
  });

  it('zeros a esquerda contam: ...05 e o numero 5', () => {
    const r = computeDrawResult({ federalNumber: '12305', totalNumbers: 100, soldNumbers: [5] });
    expect(r.winningNumber).toBe(5);
    expect(r.candidateNumber).toBe(5);
  });

  it('nao vendido: usa o proximo vendido ACIMA e registra cada tentativa', () => {
    const r = computeDrawResult({ federalNumber: '00040', totalNumbers: 100, soldNumbers: [43] });
    expect(r.winningNumber).toBe(43);
    expect(r.attempts).toEqual([
      { number: 40, inGrid: true, sold: false },
      { number: 41, inGrid: true, sold: false },
      { number: 42, inGrid: true, sold: false },
      { number: 43, inGrid: true, sold: true },
    ]);
  });

  it('volta ao inicio da grade: 98 nao vendido, so o 3 vendido', () => {
    const r = computeDrawResult({ federalNumber: '99998', totalNumbers: 100, soldNumbers: [3] });
    expect(r.winningNumber).toBe(3);
    // 98, 99, 0, 1, 2, 3
    expect(r.attempts.map((a) => a.number)).toEqual([98, 99, 0, 1, 2, 3]);
  });

  it('o proprio candidato nao e conferido duas vezes numa volta completa', () => {
    const r = computeDrawResult({ federalNumber: '00050', totalNumbers: 100, soldNumbers: [] });
    expect(r.winningNumber).toBeNull();
    expect(r.attempts).toHaveLength(100);
    expect(new Set(r.attempts.map((a) => a.number)).size).toBe(100);
  });
});

describe('computeDrawResult · grade de 500 (rotulos 000–499)', () => {
  it('usa 3 digitos', () => {
    const r = computeDrawResult({ federalNumber: '71234', totalNumbers: 500, soldNumbers: [234] });
    expect(r).toMatchObject({ candidateNumber: 234, winningNumber: 234 });
  });

  it('candidato FORA da grade (731 numa grade de 500): a busca recomeca no 0', () => {
    const r = computeDrawResult({ federalNumber: '55731', totalNumbers: 500, soldNumbers: [2, 400] });
    expect(r.candidateNumber).toBe(731);
    expect(r.attempts[0]).toEqual({ number: 731, inGrid: false, sold: false });
    expect(r.winningNumber).toBe(2);
    expect(r.attempts.map((a) => a.number)).toEqual([731, 0, 1, 2]);
  });

  it('499 e o ultimo numero; 500 ja esta fora', () => {
    expect(computeDrawResult({ federalNumber: '00499', totalNumbers: 500, soldNumbers: [499] }).winningNumber).toBe(499);
    const fora = computeDrawResult({ federalNumber: '00500', totalNumbers: 500, soldNumbers: [7] });
    expect(fora.attempts[0]).toEqual({ number: 500, inGrid: false, sold: false });
    expect(fora.winningNumber).toBe(7);
  });
});

describe('computeDrawResult · grade de 1000 (rotulos 000–999)', () => {
  it('999 e valido e 000 tambem', () => {
    expect(computeDrawResult({ federalNumber: '12999', totalNumbers: 1000, soldNumbers: [999] }).winningNumber).toBe(999);
    expect(computeDrawResult({ federalNumber: '12000', totalNumbers: 1000, soldNumbers: [0] }).winningNumber).toBe(0);
  });

  it('nao vendido: proximo acima, com volta', () => {
    const r = computeDrawResult({ federalNumber: '00999', totalNumbers: 1000, soldNumbers: [1] });
    expect(r.winningNumber).toBe(1);
    expect(r.attempts.map((a) => a.number)).toEqual([999, 0, 1]);
  });
});

describe('computeDrawResult · politica e casos limite', () => {
  it('SEM_CONTEMPLADO: numero nao vendido nao procura outro', () => {
    const r = computeDrawResult({
      federalNumber: '00040',
      totalNumbers: 100,
      soldNumbers: [43],
      policy: 'SEM_CONTEMPLADO',
    });
    expect(r.winningNumber).toBeNull();
    expect(r.attempts).toEqual([{ number: 40, inGrid: true, sold: false }]);
  });

  it('SEM_CONTEMPLADO: numero vendido ainda ganha', () => {
    const r = computeDrawResult({ federalNumber: '00043', totalNumbers: 100, soldNumbers: [43], policy: 'SEM_CONTEMPLADO' });
    expect(r.winningNumber).toBe(43);
  });

  it('nenhum numero vendido: ninguem contemplado', () => {
    expect(computeDrawResult({ federalNumber: '12345', totalNumbers: 100, soldNumbers: [] }).winningNumber).toBeNull();
  });

  it('e deterministico: o mesmo snapshot gera sempre o mesmo resultado (Set ou lista)', () => {
    const a = computeDrawResult({ federalNumber: '31415', totalNumbers: 100, soldNumbers: [15, 16] });
    const b = computeDrawResult({ federalNumber: '31415', totalNumbers: 100, soldNumbers: new Set([16, 15]) });
    expect(a).toEqual(b);
  });

  it('numero da Federal curto demais ou nao numerico e recusado', () => {
    expect(() => computeDrawResult({ federalNumber: '5', totalNumbers: 100, soldNumbers: [] })).toThrow(RangeError);
    expect(() => computeDrawResult({ federalNumber: '12', totalNumbers: 1000, soldNumbers: [] })).toThrow(RangeError);
    expect(() => computeDrawResult({ federalNumber: '12a45', totalNumbers: 100, soldNumbers: [] })).toThrow(RangeError);
  });

  it('o vencedor sempre cabe nos rotulos da grade (RN13)', () => {
    for (const grade of [100, 500, 1000] as const) {
      const { last } = gridLabelRange(grade);
      const r = computeDrawResult({ federalNumber: '00000', totalNumbers: grade, soldNumbers: [Number(last)] });
      expect(r.winningNumber).toBe(Number(last));
    }
  });
});

describe('contratos de publicacao', () => {
  it('exige evidencia: texto e/ou link https', () => {
    expect(publishResultRequestSchema.safeParse({ federalNumber: '48372' }).success).toBe(false);
    expect(publishResultRequestSchema.safeParse({ federalNumber: '48372', evidenceText: 'Concurso 6001' }).success).toBe(true);
    expect(
      publishResultRequestSchema.safeParse({ federalNumber: '48372', evidenceUrl: 'https://loterias.caixa.gov.br/x' }).success,
    ).toBe(true);
    expect(
      publishResultRequestSchema.safeParse({ federalNumber: '48372', evidenceUrl: 'http://x.exemplo/a' }).success,
    ).toBe(false);
  });

  it('numero da Federal so com digitos', () => {
    for (const ruim of ['', '1', 'abcde', '12 345', '12345678901']) {
      expect(publishResultRequestSchema.safeParse({ federalNumber: ruim, evidenceText: 'ok ok' }).success, ruim).toBe(false);
    }
  });

  it('correcao exige motivo', () => {
    const base = { federalNumber: '48372', evidenceText: 'Concurso 6001' };
    expect(correctResultRequestSchema.safeParse(base).success).toBe(false);
    expect(correctResultRequestSchema.safeParse({ ...base, reason: 'ab' }).success).toBe(false);
    expect(correctResultRequestSchema.safeParse({ ...base, reason: 'Digitei o numero errado.' }).success).toBe(true);
  });
});
