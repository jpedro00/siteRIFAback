-- ============================================================================
-- 0008 · Trilha de identidade, dead-letter da outbox e posse do schema da fila
--
-- Modulo: M01 (identidade) · M12 (auditoria e observabilidade)
-- Regras: RN11 (trilha imutavel), RN12 (MFA obrigatorio), RN21 (outbox)
--
-- Tres correcoes, cada uma fechando uma lacuna concreta encontrada na
-- validacao da fundacao. Nenhuma delas edita migration ja aplicada: a guarda
-- de checksum do runner existe justamente para impedir isso (erro E6).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. `app.record_login_attempt` passa a DEVOLVER o estado resultante
--
-- RN11 exige trilha para o bloqueio de conta (`auth.account_locked`), e a
-- decisao de bloquear e tomada DENTRO desta funcao — o comparativo
-- `failed_attempts + 1 >= p_max_attempts` acontece na propria linha que esta
-- sendo atualizada. A aplicacao nao tem como saber se o bloqueio disparou sem
-- reler a linha, e reler abriria uma janela de corrida entre o UPDATE e o
-- SELECT.
--
-- Devolver o estado pos-UPDATE fecha a janela: a aplicacao audita exatamente o
-- que a funcao decidiu, na mesma chamada.
--
-- O tipo de retorno muda, entao CREATE OR REPLACE nao basta — o PostgreSQL
-- recusa trocar o retorno de uma funcao existente. DROP + CREATE tambem apaga
-- os GRANTs, que sao reconcedidos abaixo.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS app.record_login_attempt(uuid, boolean, integer, integer);

CREATE FUNCTION app.record_login_attempt(
  p_user_id uuid,
  p_success boolean,
  p_max_attempts integer,
  p_lock_minutes integer
)
RETURNS TABLE (locked boolean, failed_attempts integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  was_locked boolean;
BEGIN
  -- Estado ANTES da tentativa, para distinguir "bloqueou agora" de "ja estava
  -- bloqueado". Sem isso, toda tentativa numa conta bloqueada geraria um novo
  -- evento `auth.account_locked` e a trilha viraria ruido.
  SELECT c.locked_until IS NOT NULL AND c.locked_until > now()
    INTO was_locked
    FROM user_credentials c
   WHERE c.user_id = p_user_id;

  IF p_success THEN
    UPDATE user_credentials c
       SET failed_attempts = 0,
           locked_until = NULL,
           updated_at = now()
     WHERE c.user_id = p_user_id;
  ELSE
    UPDATE user_credentials c
       SET failed_attempts = c.failed_attempts + 1,
           locked_until = CASE
             WHEN c.failed_attempts + 1 >= p_max_attempts
               THEN now() + make_interval(mins => p_lock_minutes)
             ELSE c.locked_until
           END,
           updated_at = now()
     WHERE c.user_id = p_user_id;
  END IF;

  RETURN QUERY
    SELECT
      -- true somente na transicao: o bloqueio passou a valer NESTA tentativa.
      (c.locked_until IS NOT NULL AND c.locked_until > now() AND NOT coalesce(was_locked, false)),
      c.failed_attempts
    FROM user_credentials c
   WHERE c.user_id = p_user_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.record_login_attempt(uuid, boolean, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_login_attempt(uuid, boolean, integer, integer) TO app_user;

-- ---------------------------------------------------------------------------
-- 2. Dead-letter da outbox
--
-- 0004 nao tem coluna de esgotamento. O relay, ao exceder o maximo de
-- tentativas, so empurrava `available_at` uma hora para frente — e como o
-- criterio de varredura e `published_at IS NULL AND available_at <= now()`, o
-- evento voltava a ser reclamado indefinidamente, uma vez por hora, para
-- sempre. Isso NAO e dead-letter: e um laco infinito lento.
--
-- `dead_lettered_at` tira o evento do fluxo normal de forma inequivoca, sem
-- apaga-lo — a linha continua visivel para inspecao, que e o ponto de existir
-- uma outbox.
--
-- A CHECK impede o estado contraditorio "entregue a fila E esgotado".
-- ---------------------------------------------------------------------------
ALTER TABLE outbox
  ADD COLUMN dead_lettered_at timestamptz;

ALTER TABLE outbox
  ADD CONSTRAINT outbox_dead_letter_not_published
    CHECK (dead_lettered_at IS NULL OR published_at IS NULL);

COMMENT ON COLUMN outbox.dead_lettered_at IS
  'RN21 · o relay esgotou as tentativas. O evento sai do fluxo normal e NAO e '
  'reclamado de novo; permanece na tabela para inspecao. Retomar exige acao '
  'deliberada (limpar a coluna), nunca acontece sozinho.';

-- O indice de varredura precisa refletir o novo criterio: um evento esgotado
-- nao e candidato, e mante-lo no indice faria o relay pagar por linhas que
-- nunca vai processar.
DROP INDEX IF EXISTS outbox_pending_idx;
CREATE INDEX outbox_pending_idx
  ON outbox (available_at, id)
  WHERE published_at IS NULL AND dead_lettered_at IS NULL;

-- Varredura de inspecao: "o que esgotou?" e uma pergunta operacional real.
CREATE INDEX outbox_dead_lettered_idx
  ON outbox (dead_lettered_at DESC)
  WHERE dead_lettered_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Posse e privilegios do schema da fila, de forma idempotente
--
-- 0007 criou `pgboss` com `CREATE SCHEMA IF NOT EXISTS ... AUTHORIZATION
-- app_worker`. O `IF NOT EXISTS` tem uma armadilha: num banco onde o schema ja
-- existisse com outro dono, a clausula AUTHORIZATION e simplesmente ignorada e
-- a migration passa em silencio — o worker ficaria sem poder criar as tabelas
-- da fila, e a falha so apareceria em producao, na subida.
--
-- Aqui a posse e os privilegios sao afirmados explicitamente. O papel continua
-- sem qualquer privilegio de DDL no schema `public`, onde vivem os dados de
-- negocio: o que ele administra e apenas a propria fila.
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS pgboss;
ALTER SCHEMA pgboss OWNER TO app_worker;
GRANT USAGE, CREATE ON SCHEMA pgboss TO app_worker;

-- A API nao toca a fila. Nem leitura: a outbox e a fronteira entre as duas.
REVOKE ALL ON SCHEMA pgboss FROM app_user;
