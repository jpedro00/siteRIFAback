/**
 * Estados do sorteio. DOC-01 secao 7.
 *
 * Os nomes sao FIXOS e usados identicos no banco, no painel e nos diagramas.
 * Sao valores persistidos em portugues, com acentos e espacos, e NAO sao
 * traduzidos para ingles apesar da preferencia geral de codigo em ingles
 * (PROMPT_ASTRA secao 10 - "nomes fixos"; conflito C14 do relatorio de analise).
 *
 * Identificadores Mermaid como `VENDAS_ENCERRADAS` no diagrama do DOC-01 sao
 * apenas apelidos de renderizacao; o valor persistido tem espaco.
 *
 * E3 - vocabulario unico de status: este array e a UNICA fonte dos rotulos.
 * A migration cria o tipo `draw_status` a partir desta mesma lista e um teste
 * compara pg_enum com este array. Dois vocabularios evoluindo em separado -
 * um no codigo, outro no banco - terminam numa CHECK desatualizada que recusa
 * insercoes validas.
 */
export const DRAW_STATUSES = [
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
] as const;

export type DrawStatus = (typeof DRAW_STATUSES)[number];

export function isDrawStatus(value: unknown): value is DrawStatus {
  return typeof value === 'string' && (DRAW_STATUSES as readonly string[]).includes(value);
}

/**
 * Transicoes permitidas, exatamente como o diagrama do DOC-01 secao 7.
 *
 * AGENDADA continua identificada como S6 (suposicao aberta): esta no catalogo
 * porque o ciclo do DOC-01 a inclui, mas a Fase 1 NAO implementa o job de
 * ativacao. Presenca no mapa nao significa comportamento implementado.
 */
export const DRAW_STATUS_TRANSITIONS: Readonly<Record<DrawStatus, readonly DrawStatus[]>> =
  Object.freeze({
    RASCUNHO: ['REVISÃO COMPLIANCE'],
    'REVISÃO COMPLIANCE': ['RASCUNHO', 'ATIVA', 'AGENDADA'],
    AGENDADA: ['ATIVA'],
    ATIVA: ['PAUSADA', 'VENDAS ENCERRADAS', 'CANCELADA'],
    PAUSADA: ['ATIVA', 'VENDAS ENCERRADAS', 'CANCELADA'],
    'VENDAS ENCERRADAS': ['APURAÇÃO'],
    APURAÇÃO: ['RESULTADO PUBLICADO'],
    'RESULTADO PUBLICADO': ['ARQUIVADA'],
    ARQUIVADA: [],
    CANCELADA: [],
  });

/** Estados em que o sorteio pode vender. DOC-01 secao 7, coluna "Vende?". */
export const DRAW_STATUSES_THAT_SELL: readonly DrawStatus[] = Object.freeze(['ATIVA']);
