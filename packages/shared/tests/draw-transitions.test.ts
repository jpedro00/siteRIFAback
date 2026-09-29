import { describe, expect, it } from 'vitest';
import {
  DRAW_EVENT_TYPES,
  DRAW_STATUS_TRANSITIONS,
  DRAW_STATUSES,
  DRAW_STATUSES_BLOCKED_UNTIL_REFUND,
  OUTBOX_EVENT_TYPES,
  OUTBOX_PAYLOAD_SCHEMAS,
  ORGANIZER_DRAW_TRANSITIONS,
  PLATFORM_REVIEW_DECISIONS,
  drawTransitionEvents,
  reviewDrawRequestSchema,
} from '../src/index.js';

/** RN02 · a tabela de quem-pode e um recorte da maquina do DOC-01, nunca uma segunda maquina. */
describe('transicoes do sorteio por ator', () => {
  it('toda transicao do organizador existe na maquina do DOC-01', () => {
    for (const [de, destinos] of Object.entries(ORGANIZER_DRAW_TRANSITIONS)) {
      for (const para of destinos ?? []) {
        expect(
          DRAW_STATUS_TRANSITIONS[de as (typeof DRAW_STATUSES)[number]],
          `${de} → ${para}`,
        ).toContain(para);
      }
    }
  });

  it('RN02 · o organizador nao tem RASCUNHO → ATIVA nem saida de REVISÃO COMPLIANCE', () => {
    expect(ORGANIZER_DRAW_TRANSITIONS['RASCUNHO']).toEqual(['REVISÃO COMPLIANCE']);
    expect(ORGANIZER_DRAW_TRANSITIONS['REVISÃO COMPLIANCE']).toBeUndefined();
  });

  it('as decisoes da plataforma sao exatamente as saidas de REVISÃO COMPLIANCE', () => {
    expect([...PLATFORM_REVIEW_DECISIONS].sort()).toEqual(
      [...DRAW_STATUS_TRANSITIONS['REVISÃO COMPLIANCE']].sort(),
    );
  });

  it('RN22 · CANCELADA esta bloqueada', () => {
    expect(DRAW_STATUSES_BLOCKED_UNTIL_REFUND).toContain('CANCELADA');
  });
});

describe('eventos do ciclo de vida', () => {
  it('toda transicao permitida ao organizador ou a plataforma publica ao menos um evento', () => {
    const pares: [string, string][] = [];
    for (const [de, destinos] of Object.entries(ORGANIZER_DRAW_TRANSITIONS)) {
      for (const para of destinos ?? []) pares.push([de, para]);
    }
    for (const para of PLATFORM_REVIEW_DECISIONS) pares.push(['REVISÃO COMPLIANCE', para]);
    pares.push(['AGENDADA', 'ATIVA']);

    for (const [de, para] of pares) {
      expect(
        drawTransitionEvents(de as never, para as never),
        `${de} → ${para} sem evento`,
      ).not.toEqual([]);
    }
  });

  it('aprovar para ATIVA publica approved e activated; para AGENDADA, so approved', () => {
    expect(drawTransitionEvents('REVISÃO COMPLIANCE', 'ATIVA')).toEqual([
      'draw.approved',
      'draw.activated',
    ]);
    expect(drawTransitionEvents('REVISÃO COMPLIANCE', 'AGENDADA')).toEqual(['draw.approved']);
  });

  it('todo evento de sorteio esta no catalogo da outbox e tem schema', () => {
    for (const tipo of DRAW_EVENT_TYPES) {
      expect(OUTBOX_EVENT_TYPES).toContain(tipo);
      expect(OUTBOX_PAYLOAD_SCHEMAS[tipo]).toBeDefined();
    }
  });
});

describe('contrato da decisao de revisao', () => {
  it('reprovar exige motivo', () => {
    expect(reviewDrawRequestSchema.safeParse({ to: 'RASCUNHO' }).success).toBe(false);
    expect(reviewDrawRequestSchema.safeParse({ to: 'RASCUNHO', reason: '   ' }).success).toBe(false);
    expect(reviewDrawRequestSchema.safeParse({ to: 'RASCUNHO', reason: 'Falta regulamento' }).success).toBe(true);
  });

  it('aprovar nao exige motivo', () => {
    expect(reviewDrawRequestSchema.safeParse({ to: 'ATIVA' }).success).toBe(true);
    expect(reviewDrawRequestSchema.safeParse({ to: 'AGENDADA' }).success).toBe(true);
  });

  it('nao aceita destino fora das decisoes', () => {
    expect(reviewDrawRequestSchema.safeParse({ to: 'CANCELADA' }).success).toBe(false);
    expect(reviewDrawRequestSchema.safeParse({ to: 'PAUSADA' }).success).toBe(false);
  });
});
