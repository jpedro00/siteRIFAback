-- ============================================================================
-- 0006 · Privilegios dos papeis de execucao
--
-- Modulo: M01 · M12
-- Regras: RN01, RN11
--
-- Dois papeis restritos, criados pelo bootstrap (packages/db/src/cli/bootstrap.ts)
-- com senha vinda do ambiente — senha nao entra em migration versionada:
--
--   app_user   · usado pela API. Nao e dono de tabela, nao tem BYPASSRLS,
--                nao tem CREATE. Todas as policies de 0005 valem para ele.
--   app_worker · usado pelo relay da outbox e pelos jobs. Enxerga a outbox de
--                todas as comunidades, porque um relay que so enxergasse uma
--                comunidade por vez nao teria como drenar a fila; NAO enxerga
--                nenhuma tabela de negocio alem do minimo declarado aqui.
--
-- A migration falha de proposito se os papeis nao existirem: rodar sem eles
-- produziria um banco onde a aplicacao se conectaria como dono e a RLS seria
-- silenciosamente inofensiva.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    RAISE EXCEPTION
      'Papel "app_user" nao existe. Rode o bootstrap antes das migrations: npm run db:bootstrap';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker') THEN
    RAISE EXCEPTION
      'Papel "app_worker" nao existe. Rode o bootstrap antes das migrations: npm run db:bootstrap';
  END IF;
END;
$$;

-- Nenhum dos dois pode criar objeto no schema public.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_user, app_worker;
GRANT USAGE ON SCHEMA app TO app_user, app_worker;

-- ---------------------------------------------------------------------------
-- app_user — API
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON
  tenants,
  tenant_domains,
  tenant_branding,
  users,
  user_credentials,
  user_mfa_factors,
  sessions,
  platform_admins,
  memberships
TO app_user;

-- RN11 · a trilha e somente insercao. Sem UPDATE, sem DELETE, sem TRUNCATE.
GRANT SELECT, INSERT ON audit_events TO app_user;

-- A API grava eventos na transacao da mudanca, mas nao publica nem conclui:
-- isso e trabalho do worker. Por isso, sem UPDATE na outbox.
GRANT SELECT, INSERT ON outbox TO app_user;

-- DELETE nao e concedido em nenhuma tabela: exclusao vira revogacao/arquivamento.

-- ---------------------------------------------------------------------------
-- app_worker — relay da outbox e consumidores
-- ---------------------------------------------------------------------------
GRANT SELECT, UPDATE ON outbox TO app_worker;
GRANT SELECT, INSERT ON event_consumptions TO app_worker;
GRANT SELECT ON tenants TO app_worker;
-- O consumidor da fundacao provisiona a marca padrao da comunidade recem-criada.
GRANT SELECT, INSERT ON tenant_branding TO app_worker;
GRANT SELECT, INSERT ON audit_events TO app_worker;

-- ---------------------------------------------------------------------------
-- Politicas especificas do worker
--
-- O worker atravessa comunidades APENAS na outbox e nas tabelas que a
-- consumidora precisa tocar. Ele nao recebe policy em users, memberships,
-- sessions nem credenciais — e tambem nao recebe GRANT nelas.
-- ---------------------------------------------------------------------------
CREATE POLICY outbox_worker_all ON outbox
  FOR ALL
  TO app_worker
  USING (true)
  WITH CHECK (true);

CREATE POLICY event_consumptions_worker ON event_consumptions
  FOR ALL
  TO app_worker
  USING (true)
  WITH CHECK (true);

CREATE POLICY tenants_worker_select ON tenants
  FOR SELECT
  TO app_worker
  USING (true);

CREATE POLICY tenant_branding_worker ON tenant_branding
  FOR ALL
  TO app_worker
  USING (true)
  WITH CHECK (true);

CREATE POLICY audit_events_worker_insert ON audit_events
  FOR INSERT
  TO app_worker
  WITH CHECK (true);

CREATE POLICY audit_events_worker_select ON audit_events
  FOR SELECT
  TO app_worker
  USING (true);

-- ---------------------------------------------------------------------------
-- Funcoes SECURITY DEFINER — execucao explicita, nunca via PUBLIC.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION app.resolve_tenant_by_domain(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.resolve_tenant_by_slug(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.authenticate_session(bytea) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.find_login_credential(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.record_login_attempt(uuid, boolean, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.my_memberships() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.my_platform_roles() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.my_roles_in_tenant(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.resolve_tenant_by_domain(text) TO app_user;
GRANT EXECUTE ON FUNCTION app.resolve_tenant_by_slug(text) TO app_user;
GRANT EXECUTE ON FUNCTION app.authenticate_session(bytea) TO app_user;
GRANT EXECUTE ON FUNCTION app.find_login_credential(text) TO app_user;
GRANT EXECUTE ON FUNCTION app.record_login_attempt(uuid, boolean, integer, integer) TO app_user;
GRANT EXECUTE ON FUNCTION app.my_memberships() TO app_user;
GRANT EXECUTE ON FUNCTION app.my_platform_roles() TO app_user;
GRANT EXECUTE ON FUNCTION app.my_roles_in_tenant(uuid) TO app_user;

-- Funcoes de contexto usadas pelas policies.
GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO app_user, app_worker;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO app_user, app_worker;
GRANT EXECUTE ON FUNCTION app.has_platform_access() TO app_user, app_worker;

-- ---------------------------------------------------------------------------
-- Sequencias: nenhuma tabela da fundacao usa serial (todas usam uuid), mas o
-- default abaixo protege as fases seguintes de conceder mais do que o previsto.
-- ---------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC;
