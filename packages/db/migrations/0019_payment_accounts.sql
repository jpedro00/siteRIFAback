-- =============================================================================
-- 0019 · Recebimentos por comunidade (FLUXO B) — autorizacoes OAuth do provedor e
--        o vinculo de cada comunidade com elas
--
-- O participante paga ao ORGANIZADOR. Cada comunidade conecta a PROPRIA conta em um
-- provedor (o primeiro e o Mercado Pago, por OAuth). Nao existe credencial global de
-- pagamento: sem conta conectada, nao ha cobranca — nunca um fallback silencioso.
--
-- DOIS NIVEIS, PARA NAO DUPLICAR SEGREDO
--   payment_provider_authorizations  a autorizacao REAL (aplicacao x conta do vendedor).
--                                    E a UNICA fonte das credenciais (access e refresh
--                                    token, cifrados). Uma por (provedor, ambiente, conta).
--   tenant_payment_accounts          o VINCULO de uma comunidade com uma autorizacao, com o
--                                    estado operacional PARA AQUELA comunidade. Duas
--                                    comunidades do mesmo vendedor apontam para a MESMA
--                                    autorizacao: nenhum token e copiado.
--
-- REGRAS QUE O BANCO GARANTE
--   1. Credencial nunca sai por SELECT: a tabela de autorizacoes nao tem NENHUM privilegio
--      para os papeis de runtime. So as funcoes abaixo a entregam — a da comunidade do
--      contexto (ou ao worker, que opera em todas) e so o access token, cifrado.
--   2. Troca de credenciais e INDIVISIVEL: access e refresh token sao gravados no mesmo
--      UPDATE, com versao otimista (`credential_version`). Um refresh token antigo nunca
--      sobrescreve o novo, e uma falha no meio nao deixa o par pela metade.
--   3. O `state` do OAuth e de uso unico, curto, e guardado como HASH; o `code_verifier`
--      do PKCE fica cifrado. O retorno so vale para a comunidade E o usuario que iniciaram.
--   4. Cada PAGAMENTO fica preso a conta usada para cria-lo (`payments.payment_account_id`):
--      imutavel, e so nasce por uma conta CONECTADA.
--   5. Desconectar nao destroi a capacidade de resolver o que ja existe: a conexao vai a
--      DISCONNECTING (nada novo), e so conclui quando nao ha pagamento pendente.
--
-- A CIFRAGEM e da aplicacao (AES-256-GCM, chave propria `PAYMENT_CREDENTIALS_KEY`, fora do
-- banco). O banco guarda `bytea` opaco e a versao da chave.
-- =============================================================================

CREATE TYPE public.payment_provider AS ENUM ('MERCADO_PAGO');
CREATE TYPE public.payment_environment AS ENUM ('SANDBOX', 'PRODUCTION');
-- ACTIVE: credencial utilizavel (pode estar perto de vencer; o refresh cuida).
-- EXPIRED: nao renovavel por vencimento. REVOKED: o vendedor (ou nos) revogou; segredo
-- apagado. ERROR: falha inesperada.
CREATE TYPE public.payment_authorization_status AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED', 'ERROR');
-- CONNECTED: recebe pagamentos novos. DISCONNECTING: nada novo, credencial mantida so para
-- resolver o que existe. DISCONNECTED: encerrada. REVOKED: a autorizacao caiu.
CREATE TYPE public.payment_account_status AS ENUM (
  'CONNECTED', 'DISCONNECTING', 'DISCONNECTED', 'REVOKED', 'ERROR'
);

-- ---------------------------------------------------------------------------
-- payment_provider_authorizations
-- ---------------------------------------------------------------------------
CREATE TABLE public.payment_provider_authorizations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                public.payment_provider    NOT NULL,
  environment             public.payment_environment NOT NULL,
  provider_account_id     text                       NOT NULL,
  status                  public.payment_authorization_status NOT NULL DEFAULT 'ACTIVE',
  access_token_encrypted  bytea,
  refresh_token_encrypted bytea,
  credentials_key_version smallint,
  expires_at              timestamptz,
  scopes                  text[] NOT NULL DEFAULT '{}',
  -- Sobe a cada troca de credencial. A renovacao so grava se a versao ainda for a que leu.
  credential_version      integer NOT NULL DEFAULT 1,
  last_verified_at        timestamptz,
  last_refresh_at         timestamptz,
  -- Motivo curto e SEM segredo da ultima falha.
  last_error              text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ppa_account_not_blank CHECK (btrim(provider_account_id) <> ''),
  CONSTRAINT ppa_active_has_credentials CHECK (
    status <> 'ACTIVE'
    OR (access_token_encrypted IS NOT NULL AND refresh_token_encrypted IS NOT NULL AND credentials_key_version IS NOT NULL)
  ),
  CONSTRAINT ppa_revoked_wiped CHECK (
    status <> 'REVOKED' OR (access_token_encrypted IS NULL AND refresh_token_encrypted IS NULL)
  ),
  CONSTRAINT ppa_error_size CHECK (last_error IS NULL OR char_length(last_error) <= 300)
);
-- Uma autorizacao VIVA por (provedor, ambiente, conta do vendedor).
CREATE UNIQUE INDEX ppa_one_live
  ON public.payment_provider_authorizations (provider, environment, provider_account_id)
  WHERE status <> 'REVOKED';
CREATE INDEX ppa_refresh_idx ON public.payment_provider_authorizations (expires_at) WHERE status = 'ACTIVE';
CREATE TRIGGER ppa_touch_updated_at BEFORE UPDATE ON public.payment_provider_authorizations
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- tenant_payment_accounts · o vinculo comunidade x autorizacao
-- ---------------------------------------------------------------------------
CREATE TABLE public.tenant_payment_accounts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  authorization_id        uuid NOT NULL REFERENCES public.payment_provider_authorizations (id) ON DELETE RESTRICT,
  provider                public.payment_provider    NOT NULL,
  environment             public.payment_environment NOT NULL,
  status                  public.payment_account_status NOT NULL DEFAULT 'CONNECTED',
  connected_by_user_id    uuid REFERENCES public.users (id) ON DELETE SET NULL,
  connected_at            timestamptz NOT NULL DEFAULT now(),
  disconnect_requested_at timestamptz,
  disconnected_at         timestamptz,
  last_error              text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tpa_error_size CHECK (last_error IS NULL OR char_length(last_error) <= 300),
  -- Alvo das FKs de pagamentos: amarra pagamento e conta a mesma comunidade.
  CONSTRAINT tpa_tenant_id_key UNIQUE (tenant_id, id)
);
-- UMA conta RECEBENDO por comunidade/provedor/ambiente. Uma conta antiga em DISCONNECTING
-- convive com a nova: ela so serve para resolver o que ja existe.
CREATE UNIQUE INDEX tpa_one_receiving
  ON public.tenant_payment_accounts (tenant_id, provider, environment)
  WHERE status = 'CONNECTED';
CREATE INDEX tpa_authorization_idx ON public.tenant_payment_accounts (authorization_id);
CREATE TRIGGER tpa_touch_updated_at BEFORE UPDATE ON public.tenant_payment_accounts
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- payment_account_oauth_states · a tentativa de conexao (OAuth + PKCE)
-- ---------------------------------------------------------------------------
CREATE TABLE public.payment_account_oauth_states (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  user_id                  uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  provider                 public.payment_provider    NOT NULL,
  environment              public.payment_environment NOT NULL,
  -- SHA-256 do `state` (32 bytes). O valor em si nunca e gravado.
  state_hash               bytea NOT NULL,
  -- PKCE: o verifier fica CIFRADO; so o backend o usa, na troca do codigo.
  code_verifier_encrypted  bytea NOT NULL,
  expires_at               timestamptz NOT NULL,
  used_at                  timestamptz,
  completed_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_oauth_state_hash_size CHECK (octet_length(state_hash) = 32)
);
CREATE UNIQUE INDEX payment_oauth_states_hash_key ON public.payment_account_oauth_states (state_hash);
CREATE INDEX payment_oauth_states_tenant_idx ON public.payment_account_oauth_states (tenant_id, expires_at);

-- ---------------------------------------------------------------------------
-- RLS e grants
--   autorizacoes e states: NENHUM privilegio de runtime (so as funcoes);
--   vinculos: leitura pela comunidade / plataforma / worker; escrita so por funcao.
-- ---------------------------------------------------------------------------
ALTER TABLE public.payment_provider_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_payment_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_account_oauth_states ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.payment_provider_authorizations FROM PUBLIC, app_user, app_worker;
REVOKE ALL ON public.payment_account_oauth_states FROM PUBLIC, app_user, app_worker;
REVOKE ALL ON public.tenant_payment_accounts FROM PUBLIC, app_user, app_worker;

CREATE POLICY tpa_select ON public.tenant_payment_accounts FOR SELECT USING (
  tenant_id = app.current_tenant_id() OR app.has_platform_access() OR session_user = 'app_worker');
GRANT SELECT ON public.tenant_payment_accounts TO app_user, app_worker;

-- ---------------------------------------------------------------------------
-- payments ganha a CONTA usada. Imutavel, e so nasce por conta CONECTADA.
-- ---------------------------------------------------------------------------
ALTER TABLE public.payments ADD COLUMN payment_account_id uuid;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_account_fk
  FOREIGN KEY (tenant_id, payment_account_id)
  REFERENCES public.tenant_payment_accounts (tenant_id, id) ON DELETE RESTRICT;
-- Todo pagamento REAL NOVO nasce com conta (regra no gatilho abaixo, so no INSERT). Nao e um
-- CHECK de proposito: o Postgres confere CHECK `NOT VALID` em TODO UPDATE da linha, e os
-- pagamentos criados antes desta migration (sem conta) ficariam impedidos de ser aprovados,
-- expirados ou devolvidos. Eles seguem sem conta e sao resolvidos como pendencia manual.
CREATE INDEX payments_account_idx ON public.payments (payment_account_id) WHERE payment_account_id IS NOT NULL;

CREATE FUNCTION app.payments_account_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  a public.tenant_payment_accounts%ROWTYPE;
  z public.payment_provider_authorizations%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Depois de criado, o pagamento nao muda de conta (consulta, webhook, conciliacao e
    -- devolucao dependem de saber COM QUAL conta ele nasceu).
    IF NEW.payment_account_id IS DISTINCT FROM OLD.payment_account_id THEN
      RAISE EXCEPTION 'a conta de recebimento de um pagamento nao muda' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.payment_account_id IS NULL THEN
    -- Pagamento REAL novo exige conta. `FAKE` (so testes) fica de fora.
    IF NEW.provider <> 'FAKE' THEN
      RAISE EXCEPTION 'pagamento novo exige uma conta de recebimento' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO a FROM public.tenant_payment_accounts WHERE id = NEW.payment_account_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conta de recebimento de outra comunidade' USING ERRCODE = 'P0001';
  END IF;
  -- Pagamento NOVO so por conta CONECTADA e com autorizacao utilizavel.
  SELECT * INTO z FROM public.payment_provider_authorizations WHERE id = a.authorization_id;
  IF a.status <> 'CONNECTED' OR z.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'a conta de recebimento nao aceita pagamentos novos (%)', a.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payments_account_guard
  BEFORE INSERT OR UPDATE OF payment_account_id ON public.payments
  FOR EACH ROW EXECUTE FUNCTION app.payments_account_guard();

-- Uma divergencia nova: a autorizacao caiu com pagamento pendente (intervencao manual).
ALTER TABLE public.payment_reconciliation_issues DROP CONSTRAINT payment_recon_kind_known;
ALTER TABLE public.payment_reconciliation_issues
  ADD CONSTRAINT payment_recon_kind_known CHECK (kind IN (
    'APPROVED_ORDER_NOT_PAID',
    'ORDER_PAID_PAYMENT_NOT_APPROVED',
    'PSP_APPROVED_LOCAL_PENDING',
    'MANUAL_REFUND_OPEN',
    'PAYMENT_AUTHORIZATION_UNAVAILABLE'
  ));

-- ---------------------------------------------------------------------------
-- apply_psp_payment: agora confere TAMBEM a conta. A consulta ao PSP foi feita com as
-- credenciais DA CONTA do pagamento; se quem aplica diz outra conta, nada muda.
-- ---------------------------------------------------------------------------
DROP FUNCTION app.apply_psp_payment(text, text, text, integer, text, timestamptz, jsonb);

CREATE FUNCTION app.apply_psp_payment(
  p_provider             text,
  p_provider_payment_id  text,
  p_status               text,
  p_amount_cents         integer,
  p_external_reference   text,
  p_paid_at              timestamptz,
  p_raw                  jsonb,
  p_payment_account_id   uuid DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  pay public.payments%ROWTYPE;
  r   text;
BEGIN
  SELECT * INTO pay
    FROM public.payments
   WHERE provider = p_provider AND provider_payment_id = p_provider_payment_id
   FOR UPDATE;

  -- Ausente ou de OUTRA comunidade: para quem chama, e a mesma coisa.
  IF NOT FOUND OR NOT app.caller_can_touch_tenant(pay.tenant_id) THEN
    RETURN 'unknown_payment';
  END IF;

  -- A consulta foi feita com a conta X; o pagamento pertence a conta Y: nao confere.
  IF p_payment_account_id IS DISTINCT FROM pay.payment_account_id THEN
    INSERT INTO public.audit_events
      (tenant_id, actor_user_id, actor_type, action, target_type, target_id)
    VALUES (pay.tenant_id, NULL, 'SYSTEM', 'payment.account_mismatch', 'payment', pay.id::text);
    RETURN 'mismatch';
  END IF;

  -- O que o PSP diz precisa CONFERIR com o que cobramos. Valor ou pedido
  -- diferente nunca paga: e sinal de aviso forjado ou de bug.
  IF p_external_reference IS DISTINCT FROM pay.order_id::text
     OR p_amount_cents IS DISTINCT FROM pay.amount_cents THEN
    INSERT INTO public.audit_events
      (tenant_id, actor_user_id, actor_type, action, target_type, target_id, after)
    VALUES (pay.tenant_id, NULL, 'SYSTEM', 'payment.mismatch', 'payment', pay.id::text,
            jsonb_build_object(
              'expectedAmountCents', pay.amount_cents,
              'receivedAmountCents', p_amount_cents,
              'referenceMatches', p_external_reference IS NOT DISTINCT FROM pay.order_id::text));
    RETURN 'mismatch';
  END IF;

  IF pay.status = 'APROVADO' THEN
    RETURN 'already_processed';
  END IF;

  IF p_status = 'APROVADO' THEN
    UPDATE public.payments
       SET status = 'APROVADO', paid_at = COALESCE(p_paid_at, now()), raw = p_raw
     WHERE id = pay.id;
    r := app.settle_order_paid(pay.order_id, pay.id, 'PSP');
    RETURN CASE WHEN r = 'REFUND_REQUIRED' THEN 'refund_required' ELSE 'paid' END;
  ELSIF p_status IN ('EXPIRADO', 'CANCELADO') THEN
    UPDATE public.payments SET status = p_status::public.payment_status, raw = p_raw WHERE id = pay.id;
    RETURN 'closed';
  ELSIF p_status = 'ESTORNADO' THEN
    UPDATE public.payments
       SET status = 'ESTORNADO', paid_at = COALESCE(paid_at, p_paid_at, now()), raw = p_raw
     WHERE id = pay.id;
    INSERT INTO public.audit_events
      (tenant_id, actor_user_id, actor_type, action, target_type, target_id)
    VALUES (pay.tenant_id, NULL, 'SYSTEM', 'payment.refunded', 'payment', pay.id::text);
    RETURN 'refunded';
  END IF;

  RETURN 'pending';
END;
$$;
REVOKE EXECUTE ON FUNCTION app.apply_psp_payment(text, text, text, integer, text, timestamptz, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.apply_psp_payment(text, text, text, integer, text, timestamptz, jsonb, uuid) TO app_user, app_worker;

-- De qual comunidade e de qual CONTA e um pagamento do PSP? Serve ao ROTEAMENTO do webhook
-- (que chega sem comunidade confiavel): a resposta sai do NOSSO registro, nunca da URL.
CREATE FUNCTION app.find_payment_route(p_provider text, p_provider_payment_id text)
RETURNS TABLE (tenant_id uuid, payment_account_id uuid, provider_account_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.tenant_id, p.payment_account_id, z.provider_account_id
    FROM public.payments p
    LEFT JOIN public.tenant_payment_accounts a ON a.id = p.payment_account_id
    LEFT JOIN public.payment_provider_authorizations z ON z.id = a.authorization_id
   WHERE p.provider = p_provider AND p.provider_payment_id = p_provider_payment_id;
$$;
REVOKE EXECUTE ON FUNCTION app.find_payment_route(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.find_payment_route(text, text) TO app_user, app_worker;

-- ---------------------------------------------------------------------------
-- Inicio do fluxo: grava a tentativa (state em HASH, verifier cifrado).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.begin_payment_account_connection(
  p_tenant                  uuid,
  p_user                    uuid,
  p_provider                public.payment_provider,
  p_environment             public.payment_environment,
  p_state_hash              bytea,
  p_code_verifier_encrypted bytea,
  p_ttl_seconds             integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN
    RAISE EXCEPTION 'sem acesso a comunidade' USING ERRCODE = '42501';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 60 OR p_ttl_seconds > 3600 THEN
    RAISE EXCEPTION 'validade do state fora do intervalo permitido (60 a 3600 s)' USING ERRCODE = '22023';
  END IF;
  -- Nao deixa a tabela crescer por repeticao: no maximo 5 tentativas abertas por comunidade.
  IF (SELECT count(*) FROM public.payment_account_oauth_states
       WHERE tenant_id = p_tenant AND used_at IS NULL AND expires_at > now()) >= 5 THEN
    RAISE EXCEPTION 'muitas tentativas de conexao em aberto' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.payment_account_oauth_states
    (tenant_id, user_id, provider, environment, state_hash, code_verifier_encrypted, expires_at)
  VALUES (p_tenant, p_user, p_provider, p_environment, p_state_hash, p_code_verifier_encrypted,
          now() + make_interval(secs => p_ttl_seconds))
  RETURNING id INTO v_id;

  INSERT INTO public.audit_events (tenant_id, actor_user_id, actor_type, action, target_type, target_id, after)
  VALUES (p_tenant, p_user, 'USER', 'payment_account.connection_started', 'payment_account_attempt', v_id::text,
          jsonb_build_object('provider', p_provider, 'environment', p_environment));
  RETURN v_id;
END;
$$;

-- Retorno do provedor: CONSOME a tentativa (uso unico, dentro da validade). Vazio = invalido,
-- vencido ou ja usado. O `state` (256 bits) e que identifica quem iniciou; quem chama ainda
-- confere o usuario da sessao contra `user_id` devolvido.
CREATE FUNCTION app.consume_payment_oauth_state(p_state_hash bytea)
RETURNS TABLE (
  state_id uuid, tenant_id uuid, user_id uuid, provider public.payment_provider,
  environment public.payment_environment, code_verifier_encrypted bytea
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.payment_account_oauth_states s
     SET used_at = now()
   WHERE s.state_hash = p_state_hash
     AND s.used_at IS NULL
     AND s.expires_at > now()
  RETURNING s.id, s.tenant_id, s.user_id, s.provider, s.environment, s.code_verifier_encrypted;
$$;

-- Trilha das falhas da conexao (sem segredo). Lista fixa de acoes; o conteudo e de quem chama,
-- mas o guarda de auditoria (0007) recusa chave de segredo.
CREATE FUNCTION app.record_payment_account_event(
  p_tenant uuid, p_user uuid, p_action text, p_after jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_action NOT IN ('payment_account.connection_failed') THEN
    RAISE EXCEPTION 'acao de auditoria nao permitida' USING ERRCODE = '22023';
  END IF;
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN
    RAISE EXCEPTION 'sem acesso a comunidade' USING ERRCODE = '42501';
  END IF;
  IF length(COALESCE(p_after::text, '')) > 1000 THEN
    RAISE EXCEPTION 'detalhe de auditoria grande demais' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.audit_events (tenant_id, actor_user_id, actor_type, action, target_type, after)
  VALUES (p_tenant, p_user, CASE WHEN p_user IS NULL THEN 'SYSTEM' ELSE 'USER' END,
          p_action, 'payment_account', p_after);
END;
$$;

-- ---------------------------------------------------------------------------
-- Autorizacao concluida: cria ou REUTILIZA a autorizacao da conta do vendedor e vincula a
-- comunidade. So vale com uma tentativa REAL (consumida, nao concluida, recente) desta
-- comunidade e deste usuario.
--
-- Retorna (result, account_id, authorization_id):
--   'connected' | 'already_linked' | 'forbidden' | 'invalid_attempt'
-- Se a comunidade ja recebia por OUTRA conta, a antiga vai a DISCONNECTING (ou
-- DISCONNECTED, se nada pende); pagamentos antigos continuam presos a ela.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.complete_payment_account_connection(
  p_state_id            uuid,
  p_tenant              uuid,
  p_user                uuid,
  p_provider_account_id text,
  p_access_enc          bytea,
  p_refresh_enc         bytea,
  p_key_version         smallint,
  p_expires_at          timestamptz,
  p_scopes              text[]
)
RETURNS TABLE (result text, account_id uuid, authorization_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  st      public.payment_account_oauth_states%ROWTYPE;
  v_auth  uuid;
  v_acc   uuid;
  antiga  public.tenant_payment_accounts%ROWTYPE;
BEGIN
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN
    RETURN QUERY SELECT 'forbidden', NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  SELECT * INTO st FROM public.payment_account_oauth_states
   WHERE id = p_state_id AND tenant_id = p_tenant AND user_id = p_user
   FOR UPDATE;
  IF NOT FOUND OR st.used_at IS NULL OR st.completed_at IS NOT NULL
     OR st.used_at < now() - interval '10 minutes' THEN
    RETURN QUERY SELECT 'invalid_attempt', NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  -- Serializa por conta do vendedor: dois retornos simultaneos nao criam duas autorizacoes.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'ppa:' || st.provider::text || ':' || st.environment::text || ':' || p_provider_account_id, 0));

  SELECT id INTO v_auth FROM public.payment_provider_authorizations
   WHERE provider = st.provider AND environment = st.environment
     AND provider_account_id = p_provider_account_id AND status <> 'REVOKED'
   FOR UPDATE;

  IF v_auth IS NULL THEN
    INSERT INTO public.payment_provider_authorizations
      (provider, environment, provider_account_id, access_token_encrypted, refresh_token_encrypted,
       credentials_key_version, expires_at, scopes, last_verified_at, last_refresh_at)
    VALUES (st.provider, st.environment, p_provider_account_id, p_access_enc, p_refresh_enc,
            p_key_version, p_expires_at, COALESCE(p_scopes, '{}'), now(), now())
    RETURNING id INTO v_auth;
  ELSE
    -- Mesma conta do vendedor, nova autorizacao do OAuth: as credenciais NOVAS substituem as
    -- velhas (par indivisivel) para TODAS as comunidades que a usam — ninguem guarda copia.
    UPDATE public.payment_provider_authorizations
       SET access_token_encrypted = p_access_enc, refresh_token_encrypted = p_refresh_enc,
           credentials_key_version = p_key_version, expires_at = p_expires_at,
           scopes = COALESCE(p_scopes, '{}'), status = 'ACTIVE', last_error = NULL,
           credential_version = credential_version + 1, last_verified_at = now(), last_refresh_at = now()
     WHERE id = v_auth;
  END IF;

  SELECT * INTO antiga FROM public.tenant_payment_accounts
   WHERE tenant_id = p_tenant AND provider = st.provider AND environment = st.environment
     AND status = 'CONNECTED' FOR UPDATE;

  IF FOUND AND antiga.authorization_id = v_auth THEN
    UPDATE public.payment_account_oauth_states SET completed_at = now() WHERE id = st.id;
    RETURN QUERY SELECT 'already_linked', antiga.id, v_auth;
    RETURN;
  END IF;

  IF FOUND THEN
    -- TROCA DE CONTA: a antiga deixa de receber; o que ela ja criou continua com ela.
    UPDATE public.tenant_payment_accounts
       SET status = 'DISCONNECTING', disconnect_requested_at = now()
     WHERE id = antiga.id;
    INSERT INTO public.audit_events (tenant_id, actor_user_id, actor_type, action, target_type, target_id, after)
    VALUES (p_tenant, p_user, 'USER', 'payment_account.replaced', 'payment_account', antiga.id::text,
            jsonb_build_object('provider', st.provider, 'environment', st.environment));
    PERFORM app.finalize_payment_account_unchecked(antiga.id);
  END IF;

  INSERT INTO public.tenant_payment_accounts
    (tenant_id, authorization_id, provider, environment, status, connected_by_user_id)
  VALUES (p_tenant, v_auth, st.provider, st.environment, 'CONNECTED', p_user)
  RETURNING id INTO v_acc;

  UPDATE public.payment_account_oauth_states SET completed_at = now() WHERE id = st.id;

  INSERT INTO public.audit_events (tenant_id, actor_user_id, actor_type, action, target_type, target_id, after)
  VALUES (p_tenant, p_user, 'USER', 'payment_account.connected', 'payment_account', v_acc::text,
          jsonb_build_object('provider', st.provider, 'environment', st.environment,
                             'providerAccountId', p_provider_account_id));
  RETURN QUERY SELECT 'connected', v_acc, v_auth;
END;
$$;

-- ---------------------------------------------------------------------------
-- Leitura da conta para a tela: SEM segredo. Uma linha por vinculo (recentes).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payment_account_overview(p_tenant uuid)
RETURNS TABLE (
  id uuid, provider public.payment_provider, environment public.payment_environment,
  status public.payment_account_status, provider_account_id text,
  authorization_status public.payment_authorization_status, token_expires_at timestamptz,
  last_verified_at timestamptz, last_error text, connected_at timestamptz,
  disconnect_requested_at timestamptz, can_receive boolean, open_obligations integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT a.id, a.provider, a.environment, a.status, z.provider_account_id, z.status, z.expires_at,
         z.last_verified_at, COALESCE(a.last_error, z.last_error), a.connected_at, a.disconnect_requested_at,
         (a.status = 'CONNECTED' AND z.status = 'ACTIVE'),
         app.payment_account_open_obligations(a.id)
    FROM public.tenant_payment_accounts a
    JOIN public.payment_provider_authorizations z ON z.id = a.authorization_id
   WHERE a.tenant_id = p_tenant
   ORDER BY (a.status = 'CONNECTED') DESC, a.connected_at DESC
   LIMIT 20;
END;
$$;

-- Pagamentos que AINDA dependem da credencial da conta: pendentes, com devolucao manual em
-- aberto, ou recem-encerrados (a conciliacao ainda pode descobrir um pagamento tardio).
CREATE FUNCTION app.payment_account_open_obligations(p_account uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::integer FROM public.payments p
   WHERE p.payment_account_id = p_account
     AND (p.status = 'PENDENTE'
          OR p.needs_manual_refund
          OR (p.status IN ('EXPIRADO', 'CANCELADO') AND p.created_at > now() - interval '3 days'));
$$;

-- Tenta concluir a desconexao: sem dependencia financeira, encerra e, se ninguem mais usa a
-- autorizacao, apaga o segredo local. 'disconnected' | 'pending' | 'not_disconnecting'.
CREATE FUNCTION app.finalize_payment_account_unchecked(p_account uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  a public.tenant_payment_accounts%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.tenant_payment_accounts WHERE id = p_account FOR UPDATE;
  IF NOT FOUND OR a.status <> 'DISCONNECTING' THEN
    RETURN 'not_disconnecting';
  END IF;
  IF app.payment_account_open_obligations(a.id) > 0 THEN
    RETURN 'pending';
  END IF;

  UPDATE public.tenant_payment_accounts SET status = 'DISCONNECTED', disconnected_at = now() WHERE id = a.id;
  INSERT INTO public.audit_events (tenant_id, actor_user_id, actor_type, action, target_type, target_id)
  VALUES (a.tenant_id, NULL, 'SYSTEM', 'payment_account.disconnected', 'payment_account', a.id::text);

  -- A credencial e da AUTORIZACAO: so sai quando nenhuma comunidade depende mais dela.
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_payment_accounts o
     WHERE o.authorization_id = a.authorization_id AND o.status IN ('CONNECTED', 'DISCONNECTING')
  ) THEN
    UPDATE public.payment_provider_authorizations
       SET status = 'REVOKED', access_token_encrypted = NULL, refresh_token_encrypted = NULL,
           credentials_key_version = NULL, last_error = NULL
     WHERE id = a.authorization_id AND status <> 'REVOKED';
  END IF;
  RETURN 'disconnected';
END;
$$;

-- Pede a desconexao: imediatamente NADA novo; conclui se nada pende.
-- 'disconnecting' | 'disconnected' | 'forbidden' | 'unknown_account' | 'not_connected'
CREATE FUNCTION app.request_payment_account_disconnect(p_tenant uuid, p_account uuid, p_user uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  a public.tenant_payment_accounts%ROWTYPE;
  r text;
BEGIN
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN RETURN 'forbidden'; END IF;
  SELECT * INTO a FROM public.tenant_payment_accounts WHERE id = p_account AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unknown_account'; END IF;
  IF a.status <> 'CONNECTED' THEN RETURN 'not_connected'; END IF;

  UPDATE public.tenant_payment_accounts
     SET status = 'DISCONNECTING', disconnect_requested_at = now() WHERE id = a.id;
  INSERT INTO public.audit_events (tenant_id, actor_user_id, actor_type, action, target_type, target_id)
  VALUES (p_tenant, p_user, 'USER', 'payment_account.disconnect_requested', 'payment_account', a.id::text);

  r := app.finalize_payment_account_unchecked(a.id);
  RETURN CASE WHEN r = 'disconnected' THEN 'disconnected' ELSE 'disconnecting' END;
END;
$$;

-- Worker: conclui as desconexoes que estavam esperando pagamentos pendentes.
CREATE FUNCTION app.finalize_payment_disconnections(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer := 0;
  r record;
BEGIN
  IF session_user <> 'app_worker' THEN RETURN 0; END IF;
  FOR r IN SELECT id FROM public.tenant_payment_accounts WHERE status = 'DISCONNECTING'
            ORDER BY disconnect_requested_at LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500)
  LOOP
    IF app.finalize_payment_account_unchecked(r.id) = 'disconnected' THEN n := n + 1; END IF;
  END LOOP;
  RETURN n;
END;
$$;

-- ---------------------------------------------------------------------------
-- Credencial para CHAMAR o provedor. Devolve sempre UMA linha: `usable` diz se veio o
-- access token (cifrado); `reason` diz por que nao.
--   purpose 'CREATE'  cobranca NOVA: conta CONNECTED e autorizacao ACTIVE.
--   purpose 'SETTLE'  consultar/conciliar/devolver o que JA existe: conta CONNECTED ou
--                     DISCONNECTING e autorizacao ACTIVE.
-- Sem fallback: conta de outra comunidade, desconectada ou revogada nao entrega nada.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.get_payment_credentials(p_tenant uuid, p_account uuid, p_purpose text)
RETURNS TABLE (
  usable boolean, reason text, authorization_id uuid, provider public.payment_provider,
  environment public.payment_environment, provider_account_id text, access_token_encrypted bytea,
  key_version smallint, token_expires_at timestamptz, credential_version integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  a public.tenant_payment_accounts%ROWTYPE;
  z public.payment_provider_authorizations%ROWTYPE;
BEGIN
  IF p_purpose NOT IN ('CREATE', 'SETTLE') THEN
    RAISE EXCEPTION 'finalidade invalida' USING ERRCODE = '22023';
  END IF;
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN
    RETURN QUERY SELECT false, 'FORBIDDEN', NULL::uuid, NULL::public.payment_provider, NULL::public.payment_environment,
                        NULL::text, NULL::bytea, NULL::smallint, NULL::timestamptz, NULL::integer;
    RETURN;
  END IF;

  SELECT * INTO a FROM public.tenant_payment_accounts WHERE id = p_account AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'ACCOUNT_NOT_FOUND', NULL::uuid, NULL::public.payment_provider, NULL::public.payment_environment,
                        NULL::text, NULL::bytea, NULL::smallint, NULL::timestamptz, NULL::integer;
    RETURN;
  END IF;
  SELECT * INTO z FROM public.payment_provider_authorizations WHERE id = a.authorization_id;

  IF (p_purpose = 'CREATE' AND a.status <> 'CONNECTED')
     OR (p_purpose = 'SETTLE' AND a.status NOT IN ('CONNECTED', 'DISCONNECTING')) THEN
    RETURN QUERY SELECT false, 'ACCOUNT_' || a.status::text, a.authorization_id, a.provider, a.environment,
                        z.provider_account_id, NULL::bytea, NULL::smallint, NULL::timestamptz, NULL::integer;
    RETURN;
  END IF;
  IF z.status <> 'ACTIVE' THEN
    RETURN QUERY SELECT false, 'AUTHORIZATION_' || z.status::text, a.authorization_id, a.provider, a.environment,
                        z.provider_account_id, NULL::bytea, NULL::smallint, NULL::timestamptz, NULL::integer;
    RETURN;
  END IF;
  RETURN QUERY SELECT true, 'OK', a.authorization_id, a.provider, a.environment, z.provider_account_id,
                      z.access_token_encrypted, z.credentials_key_version, z.expires_at, z.credential_version;
END;
$$;

-- A conta que RECEBE hoje (CONNECTED) para a comunidade neste provedor/ambiente. Nulo = nenhuma.
CREATE FUNCTION app.tenant_receiving_account(
  p_tenant uuid, p_provider public.payment_provider, p_environment public.payment_environment
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN RETURN NULL; END IF;
  RETURN (SELECT a.id FROM public.tenant_payment_accounts a
           WHERE a.tenant_id = p_tenant AND a.provider = p_provider AND a.environment = p_environment
             AND a.status = 'CONNECTED');
END;
$$;

CREATE FUNCTION app.tenant_has_payment_account(p_tenant uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN RETURN false; END IF;
  RETURN EXISTS (SELECT 1 FROM public.tenant_payment_accounts a
                   JOIN public.payment_provider_authorizations z ON z.id = a.authorization_id
                  WHERE a.tenant_id = p_tenant AND a.status = 'CONNECTED' AND z.status = 'ACTIVE');
END;
$$;

-- ---------------------------------------------------------------------------
-- RENOVACAO do token: um processo por autorizacao, troca INDIVISIVEL.
--
--   1. `lock_authorization_for_refresh` pega o lock de transacao da autorizacao e devolve o
--      estado ATUAL. Quem esperou o lock ja encontra a credencial renovada por outro.
--   2. a aplicacao chama o provedor (com o lock segurado, na mesma transacao);
--   3. `store_refreshed_credentials` grava access + refresh + validade NUM UPDATE, so se a
--      versao ainda for a lida. Erro antes disso: rollback, credencial antiga intacta.
-- ---------------------------------------------------------------------------
-- Quem pode mexer numa autorizacao: o worker, ou quem esta no contexto de uma comunidade
-- que TEM vinculo com ela. O UUID sozinho nao basta para ler nem trocar credencial alheia.
CREATE FUNCTION app.can_touch_authorization(p_authorization uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT session_user = 'app_worker'
      OR EXISTS (SELECT 1 FROM public.tenant_payment_accounts a
                  WHERE a.authorization_id = p_authorization
                    AND a.tenant_id = app.current_tenant_id());
$$;

CREATE FUNCTION app.lock_authorization_for_refresh(p_authorization uuid)
RETURNS TABLE (
  status public.payment_authorization_status, credential_version integer, expires_at timestamptz,
  access_token_encrypted bytea, refresh_token_encrypted bytea, key_version smallint,
  provider public.payment_provider, environment public.payment_environment, provider_account_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app.can_touch_authorization(p_authorization) THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ppa-refresh:' || p_authorization::text, 0));
  RETURN QUERY
  SELECT z.status, z.credential_version, z.expires_at, z.access_token_encrypted,
         z.refresh_token_encrypted, z.credentials_key_version, z.provider, z.environment,
         z.provider_account_id
    FROM public.payment_provider_authorizations z WHERE z.id = p_authorization;
END;
$$;

CREATE FUNCTION app.store_refreshed_credentials(
  p_authorization uuid, p_expected_version integer, p_access_enc bytea, p_refresh_enc bytea,
  p_key_version smallint, p_expires_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
  c record;
BEGIN
  IF NOT app.can_touch_authorization(p_authorization) THEN
    RETURN false;
  END IF;
  UPDATE public.payment_provider_authorizations
     SET access_token_encrypted = p_access_enc, refresh_token_encrypted = p_refresh_enc,
         credentials_key_version = p_key_version, expires_at = p_expires_at,
         credential_version = credential_version + 1, last_refresh_at = now(),
         last_verified_at = now(), last_error = NULL, status = 'ACTIVE'
   WHERE id = p_authorization AND credential_version = p_expected_version
     AND status IN ('ACTIVE', 'ERROR');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RETURN false; END IF;

  FOR c IN SELECT DISTINCT tenant_id FROM public.tenant_payment_accounts
            WHERE authorization_id = p_authorization AND status IN ('CONNECTED', 'DISCONNECTING', 'ERROR')
  LOOP
    INSERT INTO public.audit_events (tenant_id, actor_user_id, actor_type, action, target_type, target_id)
    VALUES (c.tenant_id, NULL, 'SYSTEM', 'payment_account.token_refreshed', 'payment_authorization', p_authorization::text);
  END LOOP;
  -- Contas que estavam em ERROR por causa da autorizacao voltam a operar.
  UPDATE public.tenant_payment_accounts SET status = 'CONNECTED', last_error = NULL
   WHERE authorization_id = p_authorization AND status = 'ERROR';
  RETURN true;
END;
$$;

-- A autorizacao ficou invalida (o vendedor revogou, o refresh foi recusado...). Nada novo:
-- as contas ligadas a ela caem junto, e cada pagamento pendente vira pendencia MANUAL
-- (nao se finge que ainda da para consultar o provedor).
CREATE FUNCTION app.mark_authorization_invalid(
  p_authorization uuid, p_status public.payment_authorization_status, p_error text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c record;
  issues integer := 0;
  pay record;
BEGIN
  IF p_status = 'ACTIVE' THEN
    RAISE EXCEPTION 'estado invalido' USING ERRCODE = '22023';
  END IF;
  IF NOT app.can_touch_authorization(p_authorization) THEN
    RETURN 0;
  END IF;

  UPDATE public.payment_provider_authorizations
     SET status = p_status, last_error = left(p_error, 300),
         access_token_encrypted = CASE WHEN p_status = 'REVOKED' THEN NULL ELSE access_token_encrypted END,
         refresh_token_encrypted = CASE WHEN p_status = 'REVOKED' THEN NULL ELSE refresh_token_encrypted END,
         credentials_key_version = CASE WHEN p_status = 'REVOKED' THEN NULL ELSE credentials_key_version END
   WHERE id = p_authorization AND status <> 'REVOKED';
  IF NOT FOUND THEN RETURN 0; END IF;

  FOR c IN SELECT id, tenant_id FROM public.tenant_payment_accounts
            WHERE authorization_id = p_authorization AND status IN ('CONNECTED', 'DISCONNECTING')
  LOOP
    UPDATE public.tenant_payment_accounts
       SET status = CASE WHEN p_status = 'REVOKED' THEN 'REVOKED'::public.payment_account_status
                         ELSE 'ERROR'::public.payment_account_status END,
           last_error = left(p_error, 300)
     WHERE id = c.id;
    INSERT INTO public.audit_events (tenant_id, actor_user_id, actor_type, action, target_type, target_id, after)
    VALUES (c.tenant_id, NULL, 'SYSTEM',
            CASE WHEN p_status = 'REVOKED' THEN 'payment_account.authorization_revoked'
                 ELSE 'payment_account.authorization_expired' END,
            'payment_account', c.id::text, jsonb_build_object('status', p_status));
    FOR pay IN SELECT id FROM public.payments
                WHERE payment_account_id = c.id AND status = 'PENDENTE'
    LOOP
      INSERT INTO public.payment_reconciliation_issues (tenant_id, payment_id, order_id, kind, detail)
      SELECT p.tenant_id, p.id, p.order_id, 'PAYMENT_AUTHORIZATION_UNAVAILABLE',
             jsonb_build_object('authorizationStatus', p_status)
        FROM public.payments p WHERE p.id = pay.id
      ON CONFLICT (payment_id, kind) WHERE resolved_at IS NULL DO NOTHING;
      issues := issues + 1;
    END LOOP;
  END LOOP;
  RETURN issues;
END;
$$;

-- Worker: autorizacoes ativas que vencem dentro da margem e ainda tem comunidade dependendo.
CREATE FUNCTION app.list_authorizations_due_for_refresh(p_margin_days integer, p_limit integer)
RETURNS TABLE (authorization_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF session_user <> 'app_worker' THEN RETURN; END IF;
  RETURN QUERY
  SELECT z.id FROM public.payment_provider_authorizations z
   WHERE z.status = 'ACTIVE'
     AND z.expires_at IS NOT NULL
     AND z.expires_at < now() + make_interval(days => p_margin_days)
     AND EXISTS (SELECT 1 FROM public.tenant_payment_accounts a
                  WHERE a.authorization_id = z.id AND a.status IN ('CONNECTED', 'DISCONNECTING'))
   ORDER BY z.expires_at
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
END;
$$;

-- ---------------------------------------------------------------------------
-- Permissoes de execucao: nada e publico.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  app.begin_payment_account_connection(uuid, uuid, public.payment_provider, public.payment_environment, bytea, bytea, integer),
  app.consume_payment_oauth_state(bytea),
  app.record_payment_account_event(uuid, uuid, text, jsonb),
  app.complete_payment_account_connection(uuid, uuid, uuid, text, bytea, bytea, smallint, timestamptz, text[]),
  app.payment_account_overview(uuid),
  app.payment_account_open_obligations(uuid),
  app.finalize_payment_account_unchecked(uuid),
  app.request_payment_account_disconnect(uuid, uuid, uuid),
  app.finalize_payment_disconnections(integer),
  app.get_payment_credentials(uuid, uuid, text),
  app.tenant_receiving_account(uuid, public.payment_provider, public.payment_environment),
  app.tenant_has_payment_account(uuid),
  app.lock_authorization_for_refresh(uuid),
  app.store_refreshed_credentials(uuid, integer, bytea, bytea, smallint, timestamptz),
  app.mark_authorization_invalid(uuid, public.payment_authorization_status, text),
  app.list_authorizations_due_for_refresh(integer, integer),
  app.payments_account_guard(),
  app.can_touch_authorization(uuid)
FROM PUBLIC;

-- `finalize_payment_account_unchecked` e `payment_account_open_obligations` sao internas: sem GRANT.
GRANT EXECUTE ON FUNCTION
  app.begin_payment_account_connection(uuid, uuid, public.payment_provider, public.payment_environment, bytea, bytea, integer),
  app.consume_payment_oauth_state(bytea),
  app.record_payment_account_event(uuid, uuid, text, jsonb),
  app.complete_payment_account_connection(uuid, uuid, uuid, text, bytea, bytea, smallint, timestamptz, text[]),
  app.payment_account_overview(uuid),
  app.request_payment_account_disconnect(uuid, uuid, uuid),
  app.finalize_payment_disconnections(integer),
  app.get_payment_credentials(uuid, uuid, text),
  app.tenant_receiving_account(uuid, public.payment_provider, public.payment_environment),
  app.tenant_has_payment_account(uuid),
  app.lock_authorization_for_refresh(uuid),
  app.store_refreshed_credentials(uuid, integer, bytea, bytea, smallint, timestamptz),
  app.mark_authorization_invalid(uuid, public.payment_authorization_status, text),
  app.list_authorizations_due_for_refresh(integer, integer)
TO app_user, app_worker;
