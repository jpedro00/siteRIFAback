import { describe, expect, it } from 'vitest';
import {
  ALLOWED_GRID_SIZES,
  DEFAULT_REMAINING_THRESHOLDS,
  DRAW_NUMBER_STATUSES,
  DRAW_STATUSES,
  LABEL_DIGITS_BY_GRID_SIZE,
  PREAUTHORIZATION_MAX_RETENTION_HOURS,
  PROMOTIONAL_RESERVATION_TTL_MINUTES,
  RESERVATION_TTL_MINUTES,
  SOLD_NUMBER_STATUSES,
  formatNumberLabel,
  gridLabelRange,
  labelDigitsForGridSize,
} from '../src/index.js';

/**
 * Teste que FALHA se qualquer constante protegida mudar.
 * PROMPT_ASTRA secao 4.1. Nenhum destes valores pode ser alterado sem uma
 * decisao explicita registrada nos documentos.
 */
describe('constantes protegidas', () => {
  it('RN05 · reserva dura exatamente 30 minutos', () => {
    expect(RESERVATION_TTL_MINUTES).toBe(30);
  });

  it('RN05 · reserva promocional usa o mesmo prazo de 30 minutos', () => {
    expect(PROMOTIONAL_RESERVATION_TTL_MINUTES).toBe(30);
  });

  it('RN05 · o prazo de reserva nao e 10 nem 5 minutos', () => {
    // C01: o D01 e o prompt geral supunham 10 min. O DOC-01 fixa 30.
    expect(RESERVATION_TTL_MINUTES).not.toBe(10);
    expect(RESERVATION_TTL_MINUTES).not.toBe(5);
  });

  it('RN16 · retencao maxima de pre-autorizacao e 12 horas', () => {
    expect(PREAUTHORIZATION_MAX_RETENTION_HOURS).toBe(12);
  });

  it('RN13 · grades permitidas sao exatamente 100, 500 e 1000', () => {
    expect([...ALLOWED_GRID_SIZES]).toEqual([100, 500, 1000]);
  });

  it('RN13 · label_digits e 2 para 100 e 3 para 500 e 1000', () => {
    expect(LABEL_DIGITS_BY_GRID_SIZE[100]).toBe(2);
    expect(LABEL_DIGITS_BY_GRID_SIZE[500]).toBe(3);
    expect(LABEL_DIGITS_BY_GRID_SIZE[1000]).toBe(3);
    expect(labelDigitsForGridSize(100)).toBe(2);
    expect(labelDigitsForGridSize(500)).toBe(3);
    expect(labelDigitsForGridSize(1000)).toBe(3);
  });

  it('RN13 · rotulos vao de 00-99, 000-499 e 000-999', () => {
    expect(gridLabelRange(100)).toEqual({ first: '00', last: '99' });
    expect(gridLabelRange(500)).toEqual({ first: '000', last: '499' });
    expect(gridLabelRange(1000)).toEqual({ first: '000', last: '999' });
  });

  it('RN13 · zeros a esquerda sao preservados', () => {
    expect(formatNumberLabel(0, 2)).toBe('00');
    expect(formatNumberLabel(7, 2)).toBe('07');
    expect(formatNumberLabel(7, 3)).toBe('007');
    expect(formatNumberLabel(499, 3)).toBe('499');
  });

  it('RN13 · tamanho de grade fora da lista e recusado', () => {
    expect(() => labelDigitsForGridSize(200)).toThrow(RangeError);
    expect(() => labelDigitsForGridSize(0)).toThrow(RangeError);
    expect(() => labelDigitsForGridSize(1001)).toThrow(RangeError);
  });

  it('RN18 · thresholds padrao sao 25 e 10', () => {
    expect([...DEFAULT_REMAINING_THRESHOLDS]).toEqual([25, 10]);
  });

  it('RN18 · apenas PAGO conta como vendido', () => {
    expect([...SOLD_NUMBER_STATUSES]).toEqual(['PAGO']);
    expect(SOLD_NUMBER_STATUSES).not.toContain('RESERVADO');
    expect(SOLD_NUMBER_STATUSES).not.toContain('CATIVO PENDENTE');
  });
});

describe('estados literais do DOC-01', () => {
  it('estados do sorteio sao os dez do DOC-01 secao 7, na ordem e com acentos', () => {
    expect([...DRAW_STATUSES]).toEqual([
      'RASCUNHO',
      'REVISÃO COMPLIANCE',
      'AGENDADA',
      'ATIVA',
      'PAUSADA',
      'VENDAS ENCERRADAS',
      'APURAÇÃO',
      'RESULTADO PUBLICADO',
      'ARQUIVADA',
      'CANCELADA',
    ]);
  });

  it('estados do numero sao os seis do DOC-01 secao 8', () => {
    expect([...DRAW_NUMBER_STATUSES]).toEqual([
      'LIVRE',
      'RESERVADO',
      'PENDENTE',
      'CATIVO PENDENTE',
      'PAGO',
      'ESTORNADO',
    ]);
  });

  it('CATIVO PENDENTE e persistido com espaco, nao com underscore', () => {
    // CATIVO_PENDENTE e apenas o identificador Mermaid do diagrama.
    expect(DRAW_NUMBER_STATUSES).toContain('CATIVO PENDENTE');
    expect(DRAW_NUMBER_STATUSES as readonly string[]).not.toContain('CATIVO_PENDENTE');
  });

  it('estados nao foram traduzidos para ingles', () => {
    const traduzidos = ['DRAFT', 'ACTIVE', 'PAUSED', 'FREE', 'RESERVED', 'PAID', 'REFUNDED'];
    for (const termo of traduzidos) {
      expect(DRAW_STATUSES as readonly string[]).not.toContain(termo);
      expect(DRAW_NUMBER_STATUSES as readonly string[]).not.toContain(termo);
    }
  });
});
