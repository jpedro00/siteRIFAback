import { describe, expect, it } from 'vitest';
import {
  DRAW_CLOSE_MODES,
  DRAW_EVENT_TYPES,
  DRAW_STATUS_TRANSITIONS,
  DRAW_STATUSES,
  DRAW_STATUSES_BLOCKED_UNTIL_REFUND,
  OUTBOX_EVENT_TYPES,
  OUTBOX_PAYLOAD_SCHEMAS,
  ORGANIZER_DRAW_TRANSITIONS,
  PLATFORM_REVIEW_DECISIONS,
  drawReadinessProblems,
  drawTransitionEvents,
  reviewDrawRequestSchema,
  validateDrawRules,
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

// ---------------------------------------------------------------------------
// Regras de preco e cronograma (0012)
// ---------------------------------------------------------------------------
describe('validateDrawRules', () => {
  it('sem promocao e sem datas: valido', () => {
    expect(validateDrawRules({ ticketPriceCents: 1500 })).toEqual([]);
  });

  it('promocional menor que o cheio, com prazo: valido', () => {
    expect(
      validateDrawRules({ ticketPriceCents: 1500, promotionalPriceCents: 1000, promoUntil: '2030-01-01T00:00:00Z' }),
    ).toEqual([]);
  });

  it('promocional igual ou maior que o cheio: problema', () => {
    for (const promo of [1500, 2000]) {
      expect(
        validateDrawRules({ ticketPriceCents: 1500, promotionalPriceCents: promo, promoUntil: '2030-01-01T00:00:00Z' }),
      ).toContainEqual(expect.stringContaining('menor que o preço cheio'));
    }
  });

  it('promocional e prazo andam juntos', () => {
    expect(validateDrawRules({ ticketPriceCents: 1500, promotionalPriceCents: 1000 })).not.toEqual([]);
    expect(validateDrawRules({ ticketPriceCents: 1500, promoUntil: '2030-01-01T00:00:00Z' })).not.toEqual([]);
  });

  it('fechamento anterior ao sorteio e inicio anterior ao fechamento', () => {
    expect(
      validateDrawRules({ closeAt: '2030-01-02T00:00:00Z', drawDate: '2030-01-01T00:00:00Z' }),
    ).toContainEqual(expect.stringContaining('anterior à data do sorteio'));
    expect(
      validateDrawRules({ salesStartAt: '2030-01-03T00:00:00Z', closeAt: '2030-01-02T00:00:00Z' }),
    ).toContainEqual(expect.stringContaining('início das vendas'));
    expect(
      validateDrawRules({
        salesStartAt: '2030-01-01T00:00:00Z',
        closeAt: '2030-01-02T00:00:00Z',
        drawDate: '2030-01-03T00:00:00Z',
      }),
    ).toEqual([]);
  });
});

describe('drawReadinessProblems (checklist de envio)', () => {
  const completo = {
    title: 'Sorteio de Natal',
    regulation: 'Regulamento do sorteio: participam todos os números pagos; o resultado segue a Loteria Federal do dia indicado.',
    prizes: [{ name: 'Moto' }],
    ticketPriceCents: 1500,
    drawDate: '2030-01-10T00:00:00Z',
  };

  it('rascunho completo: nada falta', () => {
    expect(drawReadinessProblems(completo)).toEqual([]);
  });

  it('lista tudo o que falta, em portugues', () => {
    const problemas = drawReadinessProblems({});
    expect(problemas.join(' ')).toMatch(/título/);
    expect(problemas.join(' ')).toMatch(/prêmio/);
    expect(problemas.join(' ')).toMatch(/preço/);
    expect(problemas.join(' ')).toMatch(/data do sorteio/);
    expect(problemas.join(' ')).toMatch(/regulamento/);
  });

  it('regulamento curto demais nao basta (RN02)', () => {
    expect(drawReadinessProblems({ ...completo, regulation: 'ok' })).toContainEqual(
      expect.stringContaining('regulamento'),
    );
    expect(drawReadinessProblems({ ...completo, regulation: '   ' })).toContainEqual(
      expect.stringContaining('regulamento'),
    );
  });

  it('fechamento que nao e AO_ESGOTAR exige a data de fechamento', () => {
    for (const modo of DRAW_CLOSE_MODES.filter((m) => m !== 'AO_ESGOTAR')) {
      expect(drawReadinessProblems({ ...completo, closeMode: modo })).toContainEqual(
        expect.stringContaining('data de fechamento'),
      );
      expect(drawReadinessProblems({ ...completo, closeMode: modo, closeAt: '2030-01-09T00:00:00Z' })).toEqual([]);
    }
    expect(drawReadinessProblems({ ...completo, closeMode: 'AO_ESGOTAR' })).toEqual([]);
  });
});
