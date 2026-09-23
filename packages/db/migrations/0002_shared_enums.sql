-- ============================================================================
-- 0002 · Enums compartilhados de estado
--
-- Modulo: M02 (campanhas) · M03 (reservas) — tipos criados na fundacao
-- Regras: RN13, RN18 · Prevencao do erro E3 (vocabulario unico de status)
--
-- E3: uma CHECK constraint de status desatualizada recusa insercoes que o
-- codigo considera validas. A causa e ter dois vocabularios - um no codigo,
-- outro no banco - evoluindo em separado.
--
-- Correcao: os rotulos existem UMA vez em packages/shared/src/states/ e sao
-- transcritos aqui. O teste packages/db/tests/enum-parity.test.ts compara
-- pg_enum com aquele array e FALHA se um lado mudar sem o outro.
--
-- Os tipos sao criados agora, na fundacao, embora as tabelas `draws` e
-- `draw_numbers` pertencam a Fase 2. Criar o vocabulario antes das tabelas e
-- justamente o que impede as duas listas de divergirem.
--
-- Os valores sao gravados em portugues, com acento e espaco, exatamente como
-- o DOC-01 secoes 7 e 8. NAO sao traduzidos para ingles apesar da regra geral
-- de codigo em ingles (conflito C14): o DOC-01 exige o mesmo nome no banco, no
-- painel e nos diagramas.
-- ============================================================================

-- DOC-01 secao 7 · dez estados, nesta ordem.
CREATE TYPE draw_status AS ENUM (
  'RASCUNHO',
  'REVISÃO COMPLIANCE',
  'AGENDADA',
  'ATIVA',
  'PAUSADA',
  'VENDAS ENCERRADAS',
  'APURAÇÃO',
  'RESULTADO PUBLICADO',
  'ARQUIVADA',
  'CANCELADA'
);

COMMENT ON TYPE draw_status IS
  'DOC-01 secao 7. AGENDADA permanece identificada como S6 (suposicao): esta no '
  'catalogo porque o ciclo a inclui, mas a ativacao agendada nao foi implementada '
  'na fundacao.';

-- DOC-01 secao 8 · seis estados. Regra de produto.
CREATE TYPE draw_number_status AS ENUM (
  'LIVRE',
  'RESERVADO',
  'PENDENTE',
  'CATIVO PENDENTE',
  'PAGO',
  'ESTORNADO'
);

COMMENT ON TYPE draw_number_status IS
  'DOC-01 secao 8. "CATIVO PENDENTE" e gravado com espaco; CATIVO_PENDENTE e '
  'apenas o identificador Mermaid do diagrama. RN18: somente PAGO conta como '
  'vendido.';

-- Papeis de equipe da comunidade. DOC-01 secao 3.
CREATE TYPE membership_role AS ENUM (
  'OWNER',
  'FINANCE',
  'MARKETING',
  'SUPPORT',
  'OPERATOR'
);

-- Papeis do Super Admin da plataforma. DOC-01 secao 17, PROMPT_GERAL {{PERFIS}}.
-- Eixo separado de membership_role: papel de comunidade nunca vira privilegio
-- global.
CREATE TYPE platform_role AS ENUM (
  'PLATFORM_OPERATIONS',
  'PLATFORM_COMPLIANCE',
  'PLATFORM_RISK',
  'PLATFORM_SUPPORT',
  'PLATFORM_FINANCE'
);

CREATE TYPE tenant_status AS ENUM (
  'ACTIVE',
  'SUSPENDED',
  'ARCHIVED'
);

CREATE TYPE user_status AS ENUM (
  'ACTIVE',
  'DISABLED'
);
