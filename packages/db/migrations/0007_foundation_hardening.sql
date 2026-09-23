-- ============================================================================
-- 0007 · Reforço da fundação
--
-- Modulo: M01 (identidade e permissoes) · M12 (auditoria)
-- Regras: RN01, RN11, RN12
--
-- Quatro correcoes sobre 0005/0006, cada uma fechando uma lacuna concreta.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Privilegio que faltava: DELETE em user_mfa_factors
--
-- `startMfaEnrollment` descarta cadastros de segundo fator NAO confirmados
-- antes de gerar um novo, para nao acumular segredos orfaos. 0006 concedeu
-- SELECT/INSERT/UPDATE mas nao DELETE, entao o cadastro de MFA falharia com
-- "permission denied" — justamente no fluxo que RN12 torna obrigatorio.
--
-- O DELETE e seguro: a policy `user_mfa_factors_self` (0005) restringe a
-- operacao ao proprio usuario, e o servico so apaga fatores nao confirmados.
-- ---------------------------------------------------------------------------
GRANT DELETE ON user_mfa_factors TO app_user;

-- ---------------------------------------------------------------------------
-- 2. Concessao de privilegio de plataforma sai do alcance da aplicacao
--
-- Nenhuma rota desta fase concede papel de Super Admin, e nao deve existir
-- caminho pela aplicacao para isso: seria escalada de privilegio exposta na
-- internet. A primeira concessao e feita no banco, pelo dono do schema
-- (procedimento no README).
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE ON platform_admins FROM app_user;

-- ---------------------------------------------------------------------------
-- 3. Trilha de auditoria da IDENTIDADE, sem tenant artificial
--
-- Login, logout e verificacao de segundo fator acontecem ANTES de existir
-- comunidade — e podem acontecer para quem nao tem comunidade nenhuma. Pelas
-- policies de 0005, esses eventos so poderiam ser gravados com acesso de
-- plataforma, o que deixaria a identidade sem trilha.
--
-- Inventar um "tenant tecnico" para abriga-los seria criar um balde onde dados
-- de varias comunidades se encontrariam. A saida e esta policy estreita:
--   * tenant_id NULO (evento de identidade, nao de comunidade);
--   * o ator e o proprio usuario do contexto — ninguem grava em nome de outro;
--   * apenas acoes do prefixo `auth.`.
-- ---------------------------------------------------------------------------
CREATE POLICY audit_identity_insert ON audit_events
  FOR INSERT
  TO app_user
  WITH CHECK (
    tenant_id IS NULL
    AND actor_type = 'USER'
    AND actor_user_id = app.current_user_id()
    AND action LIKE 'auth.%'
  );

-- ---------------------------------------------------------------------------
-- 4. Bloqueio de forca bruta no SEGUNDO FATOR
--
-- `user_credentials.failed_attempts` protege a SENHA. O segundo fator nao
-- tinha protecao equivalente: um codigo TOTP tem apenas 10^6 combinacoes, e
-- quem ja tem a senha correta possui sessao aberta para tentar a vontade.
-- Sem limite, o segundo fator viraria um obstaculo de minutos.
--
-- Os contadores ficam em `user_credentials` junto dos da senha: e a mesma
-- conta, e o bloqueio precisa ser lido no mesmo lugar.
-- ---------------------------------------------------------------------------
ALTER TABLE user_credentials
  ADD COLUMN mfa_failed_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN mfa_locked_until timestamptz;

ALTER TABLE user_credentials
  ADD CONSTRAINT user_credentials_mfa_attempts_sane CHECK (mfa_failed_attempts >= 0);

COMMENT ON COLUMN user_credentials.mfa_failed_attempts IS
  'RN12 · tentativas seguidas de segundo fator sem sucesso. Zerado ao acertar.';

-- ---------------------------------------------------------------------------
-- 5. Acesso de plataforma exige concessao VIGENTE, nao apenas o contexto
--
-- Em 0005, `app.has_platform_access()` confiava somente no GUC
-- `app.platform_access`, ligado pela API. Isso deixava a RLS inteiramente
-- dependente de a aplicacao nao errar: um `withPlatform` disparado por engano
-- abriria todas as comunidades.
--
-- Agora a funcao exige as DUAS coisas:
--   a) o contexto ligado pela API (que so o faz apos verificar papel e MFA);
--   b) uma linha VIGENTE em `platform_admins` para o usuario do contexto.
--
-- Revogar o privilegio passa a ter efeito imediato na camada de dados, e nao
-- apenas na camada de autorizacao.
--
-- SECURITY DEFINER e necessario: a funcao le `platform_admins`, cuja propria
-- policy a chamaria de volta. Como definer, roda como dono do schema, que nao
-- sofre RLS — nao ha recursao.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.has_platform_access()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(nullif(current_setting('app.platform_access', true), ''), 'off') = 'on'
     AND EXISTS (
       SELECT 1
       FROM platform_admins
       WHERE user_id = app.current_user_id()
         AND app.current_user_id() IS NOT NULL
         AND revoked_at IS NULL
     );
$$;

REVOKE EXECUTE ON FUNCTION app.has_platform_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.has_platform_access() TO app_user, app_worker;

-- ---------------------------------------------------------------------------
-- 6. Schema da fila pertence ao papel do worker
--
-- O pg-boss cria e mantem o proprio schema. Dar a posse do schema ao
-- `app_worker` permite que ele administre a fila sem receber privilegio de DDL
-- no schema `public`, onde vivem os dados de negocio.
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION app_worker;
