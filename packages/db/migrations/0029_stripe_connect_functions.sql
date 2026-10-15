-- =============================================================================
-- 0029 · Stripe Connect: cadastro da conta conectada e estado vindo da Stripe.
--
-- A conta Connect (Express) e criada pela PLATAFORMA com a chave dela; nao ha OAuth nem token.
-- Por isso o `acct_...` sozinho NAO prova posse: quem o registra e o backend, logo depois de
-- criar a conta, e a funcao recusa um `acct_` que ja pertenceu a outra comunidade.
--
-- Escrita so por estas funcoes (padrao da 0019); as tabelas continuam sem privilegio de runtime.
--   connect_register_account     contexto da comunidade: cria/reutiliza a autorizacao STRIPE
--                                (ACTIVE, sem token) e o vinculo CONNECTED.
--   connect_apply_account_state  SEM contexto (vem do webhook `account.updated`): grava
--                                charges/payouts/pendencias numa autorizacao STRIPE que JA
--                                existe. Nunca cria linha, nunca toca outro provedor.
-- =============================================================================

-- Retorna (result, account_id, authorization_id):
--   'connected' | 'already_linked' | 'account_taken'
-- Se a comunidade ja recebia por OUTRA conta Stripe, a antiga vai a DISCONNECTING (ou
-- DISCONNECTED, se nada pende); pagamentos antigos continuam presos a ela.
CREATE FUNCTION app.connect_register_account(
  p_tenant      uuid,
  p_user        uuid,
  p_environment public.payment_environment,
  p_account     text
)
RETURNS TABLE (result text, account_id uuid, authorization_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_auth uuid;
  v_acc  uuid;
  antiga public.tenant_payment_accounts%ROWTYPE;
BEGIN
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN
    RAISE EXCEPTION 'sem acesso a comunidade' USING ERRCODE = '42501';
  END IF;
  IF p_environment IS NULL OR p_account IS NULL OR p_account !~ '^acct_[A-Za-z0-9]{1,64}$' THEN
    RAISE EXCEPTION 'identificador de conta Stripe invalido' USING ERRCODE = '22023';
  END IF;

  -- Serializa por conta: dois cadastros simultaneos nao criam duas autorizacoes.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'ppa:STRIPE:' || p_environment::text || ':' || p_account, 0));

  -- O `acct_` nao e prova de posse: se ele ja esteve com OUTRA comunidade, recusa.
  IF EXISTS (SELECT 1 FROM public.tenant_payment_accounts a
               JOIN public.payment_provider_authorizations z ON z.id = a.authorization_id
              WHERE z.provider = 'STRIPE' AND z.environment = p_environment
                AND z.provider_account_id = p_account AND a.tenant_id <> p_tenant) THEN
    RETURN QUERY SELECT 'account_taken', NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  SELECT id INTO v_auth FROM public.payment_provider_authorizations
   WHERE provider = 'STRIPE' AND environment = p_environment
     AND provider_account_id = p_account AND status <> 'REVOKED'
   FOR UPDATE;

  IF v_auth IS NULL THEN
    -- Sem token (a chave e da plataforma). charges/payouts ficam nulos ate o primeiro estado.
    INSERT INTO public.payment_provider_authorizations (provider, environment, provider_account_id, status)
    VALUES ('STRIPE', p_environment, p_account, 'ACTIVE')
    RETURNING id INTO v_auth;
  ELSE
    UPDATE public.payment_provider_authorizations
       SET status = 'ACTIVE', last_error = NULL
     WHERE id = v_auth AND status <> 'ACTIVE';
  END IF;

  SELECT * INTO antiga FROM public.tenant_payment_accounts
   WHERE tenant_id = p_tenant AND provider = 'STRIPE' AND environment = p_environment
     AND status = 'CONNECTED' FOR UPDATE;

  IF FOUND AND antiga.authorization_id = v_auth THEN
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
            jsonb_build_object('provider', 'STRIPE', 'environment', p_environment));
    PERFORM app.finalize_payment_account_unchecked(antiga.id);
  END IF;

  INSERT INTO public.tenant_payment_accounts
    (tenant_id, authorization_id, provider, environment, status, connected_by_user_id)
  VALUES (p_tenant, v_auth, 'STRIPE', p_environment, 'CONNECTED', p_user)
  RETURNING id INTO v_acc;

  INSERT INTO public.audit_events (tenant_id, actor_user_id, actor_type, action, target_type, target_id, after)
  VALUES (p_tenant, p_user, 'USER', 'payment_account.connected', 'payment_account', v_acc::text,
          jsonb_build_object('provider', 'STRIPE', 'environment', p_environment,
                             'providerAccountId', p_account));
  RETURN QUERY SELECT 'connected', v_acc, v_auth;
END;
$$;

-- Estado da conta lido da Stripe (`accounts.retrieve`, disparado pelo webhook). Grava so os
-- tres campos que a plataforma usa — nunca o corpo da Stripe. As pendencias sao NOMES de campo:
-- no maximo 100, cada um com ate 200 caracteres, sem repeticao.
-- Retorna quantas autorizacoes foram atualizadas (0 = conta desconhecida: nada acontece).
CREATE FUNCTION app.connect_apply_account_state(
  p_account      text,
  p_charges      boolean,
  p_payouts      boolean,
  p_requirements text[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req text[];
  z     record;
  c     record;
  n     integer := 0;
BEGIN
  IF p_account IS NULL OR p_charges IS NULL OR p_payouts IS NULL THEN
    RAISE EXCEPTION 'estado da conta incompleto' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(r ORDER BY r), '{}') INTO v_req
    FROM (SELECT DISTINCT left(btrim(x), 200) AS r
            FROM unnest(COALESCE(p_requirements, '{}')) AS x
           WHERE x IS NOT NULL AND btrim(x) <> ''
           ORDER BY 1 LIMIT 100) s;

  FOR z IN SELECT id, charges_enabled, payouts_enabled FROM public.payment_provider_authorizations
            WHERE provider = 'STRIPE' AND provider_account_id = p_account AND status <> 'REVOKED'
            FOR UPDATE
  LOOP
    UPDATE public.payment_provider_authorizations
       SET charges_enabled = p_charges, payouts_enabled = p_payouts, requirements_due = v_req,
           last_verified_at = now()
     WHERE id = z.id;
    n := n + 1;

    -- Trilha so quando a conta muda de "pode receber"/"pode sacar" (sem o corpo da Stripe).
    IF z.charges_enabled IS DISTINCT FROM p_charges OR z.payouts_enabled IS DISTINCT FROM p_payouts THEN
      FOR c IN SELECT id, tenant_id FROM public.tenant_payment_accounts
                WHERE authorization_id = z.id AND status IN ('CONNECTED', 'DISCONNECTING')
      LOOP
        INSERT INTO public.audit_events (tenant_id, actor_user_id, actor_type, action, target_type, target_id, after)
        VALUES (c.tenant_id, NULL, 'SYSTEM', 'payment_account.connect_state_changed', 'payment_account', c.id::text,
                jsonb_build_object('chargesEnabled', p_charges, 'payoutsEnabled', p_payouts));
      END LOOP;
    END IF;
  END LOOP;
  RETURN n;
END;
$$;

-- ---------------------------------------------------------------------------
-- Permissoes de execucao: nada e publico.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  app.connect_register_account(uuid, uuid, public.payment_environment, text),
  app.connect_apply_account_state(text, boolean, boolean, text[])
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  app.connect_register_account(uuid, uuid, public.payment_environment, text),
  app.connect_apply_account_state(text, boolean, boolean, text[])
TO app_user, app_worker;
