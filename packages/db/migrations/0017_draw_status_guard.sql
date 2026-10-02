-- =============================================================================
-- 0017 · o BANCO recusa mudanca de estado do sorteio fora das vias oficiais
--
-- Achado da auditoria final (A2): `app_user` tem UPDATE em `draws` e nada no
-- banco impedia `UPDATE draws SET status = 'ATIVA'` sobre um RASCUNHO — nem um
-- INSERT ja com `status = 'ATIVA'`. Hoje so `transitionDrawStatus` grava
-- `status`, mas uma regra que vive so no codigo da API deixa de valer no dia em
-- que outro caminho de codigo (ou uma falha) escrever na coluna.
--
-- O QUE ESTA MIGRATION FAZ
--   * `draw_status_transitions`: quem (actor) pode levar de um estado a outro.
--   * gatilho BEFORE INSERT/UPDATE em `draws` que consulta essa tabela.
--
-- UMA FONTE DE VERDADE, NAO DUAS
--   A fonte oficial continua sendo `packages/shared/src/states/drawStatus.ts`
--   (DRAW_STATUS_TRANSITIONS, ORGANIZER_DRAW_TRANSITIONS,
--   PLATFORM_REVIEW_DECISIONS). O SQL nao pode importa-la, entao esta tabela e um
--   ESPELHO — e o teste `draw-status-guard.test.ts` compara linha a linha com o
--   `shared`: se as duas divergirem, a suite quebra. Mudou a maquina? Muda no
--   `shared`, o teste aponta a diferenca, e uma migration nova ajusta a tabela.
--
-- QUEM E CADA ATOR
--   PLATFORM   `app.has_platform_access()` — exige GUC ligado E o usuario em
--              `platform_admins` (0007). Nao basta ligar a variavel.
--   SYSTEM     `session_user = 'app_worker'`: o worker, sempre por meio das
--              funcoes `app.worker_*` (SECURITY DEFINER). `session_user` e o
--              papel da CONEXAO; `current_user` dentro da funcao e o dono dela.
--   ORGANIZER  qualquer outra conexao de runtime (`app_user`).
--
-- QUEM NAO E ALCANCADO
--   Papeis que nao sao de runtime (dono do schema, migrations, fixtures de
--   teste) seguem livres: o gatilho so age para `app_user` e `app_worker`.
--   Reparo de dados por DBA continua possivel — e continua auditavel pelo
--   proprio dono, fora do caminho da aplicacao.
--
-- LIMITE HONESTO
--   O contexto de tenant (RLS) tambem vem de variaveis de sessao; o gatilho tem o
--   mesmo alcance da RLS. Ele fecha o caminho ACIDENTAL (bug, rota nova, SQL
--   escrito com pressa) e o de organizador; nao promete conter um SQL arbitrario
--   executado com a credencial de `app_user`, coisa que nenhuma regra em gatilho
--   contem.
--
-- NAO MUDA: RLS, grants de `draws`, `transitionDrawStatus`, funcoes do worker,
-- auditoria e outbox (continuam onde estao).
-- =============================================================================

CREATE TABLE public.draw_status_transitions (
  from_status public.draw_status NOT NULL,
  to_status   public.draw_status NOT NULL,
  actor       text               NOT NULL,
  PRIMARY KEY (from_status, to_status, actor),
  CONSTRAINT draw_status_transitions_actor_valid
    CHECK (actor IN ('ORGANIZER', 'PLATFORM', 'SYSTEM'))
);

COMMENT ON TABLE public.draw_status_transitions IS
  'Espelho de ORGANIZER_DRAW_TRANSITIONS / PLATFORM_REVIEW_DECISIONS / funcoes do worker. Fonte oficial: packages/shared/src/states/drawStatus.ts (teste de paridade).';

-- Catalogo global, sem `tenant_id`: RLS ligada sem politica alguma para os
-- papeis de runtime — eles nao leem nem escrevem; o gatilho (SECURITY DEFINER) le.
ALTER TABLE public.draw_status_transitions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.draw_status_transitions FROM PUBLIC;
REVOKE ALL ON public.draw_status_transitions FROM app_user, app_worker;

INSERT INTO public.draw_status_transitions (from_status, to_status, actor) VALUES
  -- Organizador (ORGANIZER_DRAW_TRANSITIONS)
  ('RASCUNHO',          'REVISÃO COMPLIANCE', 'ORGANIZER'),
  ('ATIVA',             'PAUSADA',            'ORGANIZER'),
  ('ATIVA',             'VENDAS ENCERRADAS',  'ORGANIZER'),
  ('PAUSADA',           'ATIVA',              'ORGANIZER'),
  ('PAUSADA',           'VENDAS ENCERRADAS',  'ORGANIZER'),
  -- Publicar o resultado (allowResultPublication, via resultService)
  ('APURAÇÃO',          'RESULTADO PUBLICADO', 'ORGANIZER'),
  -- Super Admin (PLATFORM_REVIEW_DECISIONS, a partir de REVISÃO COMPLIANCE)
  ('REVISÃO COMPLIANCE', 'ATIVA',             'PLATFORM'),
  ('REVISÃO COMPLIANCE', 'AGENDADA',          'PLATFORM'),
  ('REVISÃO COMPLIANCE', 'RASCUNHO',          'PLATFORM'),
  -- Sistema (app.worker_transition_draw)
  ('ATIVA',             'VENDAS ENCERRADAS',  'SYSTEM'),
  ('PAUSADA',           'VENDAS ENCERRADAS',  'SYSTEM'),
  ('AGENDADA',          'ATIVA',              'SYSTEM'),
  ('VENDAS ENCERRADAS', 'APURAÇÃO',           'SYSTEM');

CREATE FUNCTION app.draw_status_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  papel text;
BEGIN
  -- Fora do runtime (dono, migrations, fixtures): sem interferencia.
  IF session_user NOT IN ('app_user', 'app_worker') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Todo sorteio nasce em RASCUNHO; o resto do ciclo e por transicao.
    IF NEW.status <> 'RASCUNHO' THEN
      RAISE EXCEPTION 'sorteio novo so pode nascer em RASCUNHO (recebeu "%")', NEW.status
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE que nao mexe no estado nao e da conta deste gatilho.
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  papel := CASE
    WHEN session_user = 'app_worker'   THEN 'SYSTEM'
    WHEN app.has_platform_access()     THEN 'PLATFORM'
    ELSE 'ORGANIZER'
  END;

  IF NOT EXISTS (
    SELECT 1
      FROM public.draw_status_transitions t
     WHERE t.from_status = OLD.status
       AND t.to_status   = NEW.status
       AND t.actor       = papel
  ) THEN
    RAISE EXCEPTION 'transicao de estado nao permitida: "%" -> "%" (ator %)',
      OLD.status, NEW.status, papel
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.draw_status_guard() FROM PUBLIC;

-- O nome comeca com `draws_05`: roda ANTES dos gatilhos `draws_10_*` (ordem
-- alfabetica dos gatilhos BEFORE) e depois de `draws_00_sync_legacy_price`.
CREATE TRIGGER draws_05_status_guard
  BEFORE INSERT OR UPDATE OF status ON public.draws
  FOR EACH ROW EXECUTE FUNCTION app.draw_status_guard();
