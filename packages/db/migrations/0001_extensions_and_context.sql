-- ============================================================================
-- 0001 · Extensoes e contexto de execucao
--
-- Modulo: M01 (identidade e comunidade) · M12 (auditoria)
-- Regras: RN01 (isolamento por comunidade)
--
-- Este arquivo cria as funcoes que TODA politica de RLS usa para descobrir em
-- nome de quem e de qual comunidade a transacao corrente esta rodando.
--
-- Contrato do contexto:
--   - a aplicacao usa SEMPRE `SET LOCAL`, nunca `SET`. `SET LOCAL` morre no
--     fim da transacao, entao o contexto NAO sobrevive numa conexao devolvida
--     ao pool e reaproveitada por outra requisicao;
--   - `current_setting(..., true)` devolve NULL quando a chave nunca foi
--     definida e '' quando foi limpa. `nullif` normaliza os dois para NULL;
--   - contexto ausente => a funcao devolve NULL => toda comparacao
--     `tenant_id = NULL` e NULL => a politica nao libera linha nenhuma.
--     Ausencia de contexto NEGA acesso; nao existe fallback para comunidade
--     padrao.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS app;

COMMENT ON SCHEMA app IS
  'Funcoes de contexto de execucao usadas pelas politicas de RLS. Sem tabelas.';

-- ---------------------------------------------------------------------------
-- Comunidade (tenant) da transacao corrente.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.current_tenant_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
AS $$
DECLARE
  raw text;
BEGIN
  raw := nullif(current_setting('app.tenant_id', true), '');
  IF raw IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN raw::uuid;
EXCEPTION
  -- Um valor malformado nao pode virar "sem filtro": vira ausencia de
  -- contexto, que nega tudo.
  WHEN invalid_text_representation THEN
    RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Usuario autenticado da transacao corrente.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
AS $$
DECLARE
  raw text;
BEGIN
  raw := nullif(current_setting('app.user_id', true), '');
  IF raw IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN raw::uuid;
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Acesso de plataforma (Super Admin).
--
-- Vale somente quando a API JA verificou, na camada de autorizacao, que a
-- sessao tem papel de plataforma e que o segundo fator foi satisfeito (RN12).
-- A RLS aqui e defesa em profundidade contra consulta sem filtro; a decisao
-- de autorizacao vive na API e tem teste proprio. Nenhum papel de comunidade
-- consegue ligar esta chave: quem a define e o middleware de plataforma.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.has_platform_access()
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(nullif(current_setting('app.platform_access', true), ''), 'off') = 'on';
$$;

-- ---------------------------------------------------------------------------
-- Guarda contra segredo em trilha de auditoria.
--
-- A auditoria registra "antes/depois" de acoes sensiveis. Senha, token de
-- sessao, segredo TOTP e credencial de PSP nunca podem entrar nesse registro.
-- A checagem fica no banco porque a trilha e escrita por varios modulos.
-- ---------------------------------------------------------------------------
-- A checagem e RECURSIVA: um segredo escondido em `{"credentials":{"token":...}}`
-- precisa ser barrado igual a um segredo no primeiro nivel.
CREATE OR REPLACE FUNCTION app.assert_no_secrets(payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  forbidden constant text[] := ARRAY[
    'password', 'senha', 'password_hash', 'passwordhash',
    'token', 'token_hash', 'access_token', 'refresh_token', 'session_token',
    'secret', 'segredo', 'secret_encrypted', 'totp_secret', 'mfa_secret',
    'card_token', 'card_token_ref', 'private_key', 'api_key', 'client_secret',
    'authorization', 'cookie'
  ];
  entry record;
  item jsonb;
BEGIN
  IF payload IS NULL THEN
    RETURN true;
  END IF;

  IF jsonb_typeof(payload) = 'object' THEN
    FOR entry IN SELECT key, value FROM jsonb_each(payload) LOOP
      IF lower(entry.key) = ANY (forbidden) THEN
        RAISE EXCEPTION
          'audit_events: campo sensivel "%" nao pode ser gravado na trilha de auditoria',
          entry.key
          USING ERRCODE = 'check_violation';
      END IF;
      PERFORM app.assert_no_secrets(entry.value);
    END LOOP;
  ELSIF jsonb_typeof(payload) = 'array' THEN
    FOR item IN SELECT value FROM jsonb_array_elements(payload) LOOP
      PERFORM app.assert_no_secrets(item);
    END LOOP;
  END IF;

  RETURN true;
END;
$$;
