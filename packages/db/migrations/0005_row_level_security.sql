-- ============================================================================
-- 0005 · Row Level Security
--
-- Modulo: M01 · M12
-- Regras: RN01 (uma comunidade nunca ve dados de outra), RN11
--
-- MODELO DE CONFIANCA
--
--   * A aplicacao conecta com um papel RESTRITO (app_user), que nao e dono das
--     tabelas e nao tem BYPASSRLS. As politicas abaixo valem para ele.
--   * O papel que roda as migrations e dono do schema e NAO e usado pela
--     aplicacao. Os testes de isolamento conectam como app_user, nao como
--     superusuario — testar RLS como dono nao prova nada.
--   * Contexto ausente => app.current_tenant_id() = NULL => `tenant_id = NULL`
--     e NULL => nenhuma linha passa. Negar e o comportamento padrao.
--
-- DUAS EXCECOES DE CONTEXTO, ambas resolvidas por funcao SECURITY DEFINER de
-- projecao minima, e nao por afrouxamento de policy:
--   1. Resolver a comunidade a partir do dominio/slug acontece ANTES de existir
--      contexto de comunidade.
--   2. Validar o token de sessao acontece ANTES de existir contexto de usuario.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenants_select ON tenants
  FOR SELECT
  USING (id = app.current_tenant_id() OR app.has_platform_access());

-- Criar comunidade e acao de plataforma. DOC-01 secao 2, passo 1.
CREATE POLICY tenants_insert ON tenants
  FOR INSERT
  WITH CHECK (app.has_platform_access());

CREATE POLICY tenants_update ON tenants
  FOR UPDATE
  USING (id = app.current_tenant_id() OR app.has_platform_access())
  WITH CHECK (id = app.current_tenant_id() OR app.has_platform_access());

-- Sem policy de DELETE: a aplicacao nao apaga comunidade.

-- ---------------------------------------------------------------------------
-- tenant_domains
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_domains ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_domains_select ON tenant_domains
  FOR SELECT
  USING (tenant_id = app.current_tenant_id() OR app.has_platform_access());

CREATE POLICY tenant_domains_write ON tenant_domains
  FOR ALL
  USING (app.has_platform_access())
  WITH CHECK (app.has_platform_access());

-- ---------------------------------------------------------------------------
-- tenant_branding
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_branding ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_branding_select ON tenant_branding
  FOR SELECT
  USING (tenant_id = app.current_tenant_id() OR app.has_platform_access());

CREATE POLICY tenant_branding_insert ON tenant_branding
  FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() OR app.has_platform_access());

CREATE POLICY tenant_branding_update ON tenant_branding
  FOR UPDATE
  USING (tenant_id = app.current_tenant_id() OR app.has_platform_access())
  WITH CHECK (tenant_id = app.current_tenant_id() OR app.has_platform_access());

-- ---------------------------------------------------------------------------
-- users — identidade global, acesso restrito.
--
-- Nao basta "nao ter tenant_id": sem policy, o papel da aplicacao leria a base
-- inteira de usuarios de todas as comunidades. A policy limita a leitura a:
--   * o proprio usuario autenticado;
--   * quem tem vinculo VIGENTE na comunidade resolvida no momento (a equipe
--     precisa enxergar a propria equipe — DOC-01 secao 3);
--   * acesso de plataforma verificado.
-- ---------------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_select ON users
  FOR SELECT
  USING (
    id = app.current_user_id()
    OR app.has_platform_access()
    OR EXISTS (
      SELECT 1
      FROM memberships m
      WHERE m.user_id = users.id
        AND m.tenant_id = app.current_tenant_id()
        AND m.revoked_at IS NULL
    )
  );

CREATE POLICY users_insert ON users
  FOR INSERT
  WITH CHECK (app.has_platform_access());

CREATE POLICY users_update ON users
  FOR UPDATE
  USING (id = app.current_user_id() OR app.has_platform_access())
  WITH CHECK (id = app.current_user_id() OR app.has_platform_access());

-- ---------------------------------------------------------------------------
-- user_credentials — so o proprio dono. O login usa SECURITY DEFINER.
-- ---------------------------------------------------------------------------
ALTER TABLE user_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_credentials_self ON user_credentials
  FOR SELECT
  USING (user_id = app.current_user_id());

CREATE POLICY user_credentials_self_update ON user_credentials
  FOR UPDATE
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

CREATE POLICY user_credentials_insert ON user_credentials
  FOR INSERT
  WITH CHECK (app.has_platform_access() OR user_id = app.current_user_id());

-- ---------------------------------------------------------------------------
-- user_mfa_factors — segredo do proprio usuario, de ninguem mais.
-- Nem o dono da comunidade nem o Super Admin leem o segredo de outra pessoa.
-- ---------------------------------------------------------------------------
ALTER TABLE user_mfa_factors ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_mfa_factors_self ON user_mfa_factors
  FOR ALL
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

-- ---------------------------------------------------------------------------
-- sessions — do proprio usuario. A validacao do token usa SECURITY DEFINER.
-- ---------------------------------------------------------------------------
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY sessions_self ON sessions
  FOR ALL
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

-- ---------------------------------------------------------------------------
-- platform_admins
-- ---------------------------------------------------------------------------
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;

CREATE POLICY platform_admins_select ON platform_admins
  FOR SELECT
  USING (user_id = app.current_user_id() OR app.has_platform_access());

CREATE POLICY platform_admins_write ON platform_admins
  FOR ALL
  USING (app.has_platform_access())
  WITH CHECK (app.has_platform_access());

-- ---------------------------------------------------------------------------
-- memberships — dado de comunidade, isolado por tenant_id.
--
-- "Quais sao as minhas comunidades?" e uma pergunta que atravessa tenants por
-- natureza. Ela NAO e respondida afrouxando esta policy: e respondida por
-- app.my_memberships(), que filtra pelo usuario do contexto.
-- ---------------------------------------------------------------------------
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;

CREATE POLICY memberships_select ON memberships
  FOR SELECT
  USING (tenant_id = app.current_tenant_id() OR app.has_platform_access());

CREATE POLICY memberships_insert ON memberships
  FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() OR app.has_platform_access());

CREATE POLICY memberships_update ON memberships
  FOR UPDATE
  USING (tenant_id = app.current_tenant_id() OR app.has_platform_access())
  WITH CHECK (tenant_id = app.current_tenant_id() OR app.has_platform_access());

-- Sem policy de DELETE: vinculo se revoga (revoked_at), nao se apaga. RN11.

-- ---------------------------------------------------------------------------
-- audit_events — insercao e leitura no proprio contexto. Sem UPDATE/DELETE.
--
-- A ausencia de policy para UPDATE e DELETE ja nega a operacao sob RLS. Os
-- GRANTs de 0006 e o trigger de 0004 reforcam.
-- ---------------------------------------------------------------------------
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_events_select ON audit_events
  FOR SELECT
  USING (
    (tenant_id IS NOT NULL AND tenant_id = app.current_tenant_id())
    OR app.has_platform_access()
  );

CREATE POLICY audit_events_insert ON audit_events
  FOR INSERT
  WITH CHECK (
    (tenant_id IS NOT NULL AND tenant_id = app.current_tenant_id())
    OR (tenant_id IS NULL AND app.has_platform_access())
  );

-- ---------------------------------------------------------------------------
-- outbox — gravado pela API na transacao da mudanca; lido pelo relay.
-- As politicas do papel do worker ficam em 0006, junto dos GRANTs.
-- ---------------------------------------------------------------------------
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY outbox_insert ON outbox
  FOR INSERT
  WITH CHECK (
    (tenant_id IS NOT NULL AND tenant_id = app.current_tenant_id())
    OR (tenant_id IS NULL AND app.has_platform_access())
  );

CREATE POLICY outbox_select ON outbox
  FOR SELECT
  USING (
    (tenant_id IS NOT NULL AND tenant_id = app.current_tenant_id())
    OR app.has_platform_access()
  );

ALTER TABLE event_consumptions ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- Excecoes de contexto — funcoes SECURITY DEFINER de projecao minima
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Resolucao da comunidade por dominio.
--
-- Roda antes de existir contexto. Devolve NO MAXIMO uma linha e apenas os
-- campos necessarios para abrir o contexto.
--
-- Dominio desconhecido devolve ZERO linhas. Nao existe comunidade padrao de
-- fallback: o chamador precisa tratar a ausencia como "nao encontrada".
--
-- Dominio ainda nao verificado (verified_at IS NULL) tambem devolve zero
-- linhas: o registro do dominio nao basta, a posse precisa ter sido
-- comprovada.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.resolve_tenant_by_domain(p_domain text)
RETURNS TABLE (tenant_id uuid, slug text, name text, status tenant_status)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT t.id, t.slug, t.name, t.status
  FROM tenant_domains d
  JOIN tenants t ON t.id = d.tenant_id
  WHERE d.domain = lower(btrim(p_domain))
    AND d.verified_at IS NOT NULL
  LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- Resolucao da comunidade por slug (subdominio {slug}.plataforma.com.br).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.resolve_tenant_by_slug(p_slug text)
RETURNS TABLE (tenant_id uuid, slug text, name text, status tenant_status)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT t.id, t.slug, t.name, t.status
  FROM tenants t
  WHERE t.slug = lower(btrim(p_slug))
  LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- Validacao do token de sessao.
--
-- Roda antes de existir contexto de usuario. Recebe o HASH do token, nunca o
-- token. Devolve linha somente para sessao nao revogada e nao expirada — a
-- revogacao passa a valer na requisicao seguinte, sem esperar expiracao.
--
-- Nao devolve o hash do token nem qualquer segredo.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.authenticate_session(p_token_hash bytea)
RETURNS TABLE (
  session_id       uuid,
  user_id          uuid,
  mfa_satisfied_at timestamptz,
  expires_at       timestamptz,
  user_status      user_status,
  email            text,
  display_name     text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.user_id, s.mfa_satisfied_at, s.expires_at,
         u.status, u.email, u.display_name
  FROM sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = p_token_hash
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
    AND u.status = 'ACTIVE'
  LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- Busca de credencial para login.
--
-- Roda antes de existir contexto. Escopo minimo: recebe um e-mail, devolve a
-- credencial daquele e-mail. Nao permite listar, filtrar nem varrer a base.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.find_login_credential(p_email text)
RETURNS TABLE (
  user_id       uuid,
  email         text,
  display_name  text,
  user_status   user_status,
  password_hash text,
  locked_until  timestamptz,
  failed_attempts integer
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.email, u.display_name, u.status,
         c.password_hash, c.locked_until, c.failed_attempts
  FROM users u
  JOIN user_credentials c ON c.user_id = u.id
  WHERE u.email = lower(btrim(p_email))
  LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- Registro de tentativa de login.
--
-- SECURITY DEFINER porque acontece antes do contexto de usuario existir (uma
-- tentativa falha nao pode abrir contexto). Escopo minimo: so mexe nos
-- contadores de tentativa daquele usuario.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.record_login_attempt(
  p_user_id uuid,
  p_success boolean,
  p_max_attempts integer,
  p_lock_minutes integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_success THEN
    UPDATE user_credentials
       SET failed_attempts = 0,
           locked_until = NULL,
           updated_at = now()
     WHERE user_id = p_user_id;
  ELSE
    UPDATE user_credentials
       SET failed_attempts = failed_attempts + 1,
           locked_until = CASE
             WHEN failed_attempts + 1 >= p_max_attempts
               THEN now() + make_interval(mins => p_lock_minutes)
             ELSE locked_until
           END,
           updated_at = now()
     WHERE user_id = p_user_id;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Vinculos do usuario autenticado, atravessando comunidades.
--
-- Le o usuario do CONTEXTO (app.current_user_id()), nunca de um argumento: um
-- argumento permitiria pedir os vinculos de outra pessoa. Sem contexto de
-- usuario, devolve zero linhas.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.my_memberships()
RETURNS TABLE (tenant_id uuid, tenant_slug text, tenant_name text, role membership_role)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT m.tenant_id, t.slug, t.name, m.role
  FROM memberships m
  JOIN tenants t ON t.id = m.tenant_id
  WHERE m.user_id = app.current_user_id()
    AND app.current_user_id() IS NOT NULL
    AND m.revoked_at IS NULL
    AND m.accepted_at IS NOT NULL
    AND t.status = 'ACTIVE'
  ORDER BY t.name, m.role;
$$;

-- ---------------------------------------------------------------------------
-- Papeis de plataforma do usuario autenticado.
-- Mesmo cuidado: le o usuario do contexto, nao de argumento.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.my_platform_roles()
RETURNS TABLE (role platform_role)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT p.role
  FROM platform_admins p
  WHERE p.user_id = app.current_user_id()
    AND app.current_user_id() IS NOT NULL
    AND p.revoked_at IS NULL
  ORDER BY p.role;
$$;

-- ---------------------------------------------------------------------------
-- Papeis do usuario autenticado numa comunidade especifica.
--
-- Verifica o vinculo ANTES de qualquer contexto de comunidade ser aberto. E
-- este o ponto que impede aceitar um tenant_id arbitrario vindo do cliente: o
-- contexto so e aberto se esta funcao devolver ao menos um papel.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.my_roles_in_tenant(p_tenant_id uuid)
RETURNS TABLE (role membership_role)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT m.role
  FROM memberships m
  WHERE m.user_id = app.current_user_id()
    AND app.current_user_id() IS NOT NULL
    AND m.tenant_id = p_tenant_id
    AND m.revoked_at IS NULL
    AND m.accepted_at IS NOT NULL
  ORDER BY m.role;
$$;
