-- 0028 · Stripe Connect: taxa da plataforma e conta conectada do criador. Aditiva.
-- (O valor 'STRIPE' do enum nasce na 0027; aqui ele ja pode ser usado.)

-- Taxa por plano (pontos-base: 500 = 5%) e padrao da plataforma.
ALTER TABLE public.plans
  ADD COLUMN platform_fee_bps integer,
  ADD CONSTRAINT plans_fee_range CHECK (platform_fee_bps IS NULL OR platform_fee_bps BETWEEN 0 AND 10000);
ALTER TABLE public.billing_settings
  ADD COLUMN default_platform_fee_bps integer NOT NULL DEFAULT 500,
  ADD CONSTRAINT billing_settings_fee_range CHECK (default_platform_fee_bps BETWEEN 0 AND 10000);

-- A taxa fica CONGELADA no pagamento: mudar de plano depois nao altera o que ja foi vendido.
ALTER TABLE public.payments
  ADD COLUMN platform_fee_bps integer,
  ADD COLUMN platform_fee_cents integer,
  ADD CONSTRAINT payments_fee_valid CHECK (
    (platform_fee_bps IS NULL AND platform_fee_cents IS NULL)
    OR (platform_fee_bps IS NOT NULL AND platform_fee_cents IS NOT NULL
        AND platform_fee_bps BETWEEN 0 AND 10000 AND platform_fee_cents BETWEEN 0 AND amount_cents)
  );
ALTER TABLE public.payments DROP CONSTRAINT payments_provider_known;
ALTER TABLE public.payments ADD CONSTRAINT payments_provider_known
  CHECK (provider IN ('MERCADO_PAGO', 'STRIPE', 'FAKE'));

-- Conta Connect: sem token (a chave e da plataforma). O estado vem do webhook account.updated.
ALTER TABLE public.payment_provider_authorizations
  ADD COLUMN charges_enabled boolean,
  ADD COLUMN payouts_enabled boolean,
  ADD COLUMN requirements_due text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.payment_provider_authorizations DROP CONSTRAINT ppa_active_has_credentials;
ALTER TABLE public.payment_provider_authorizations ADD CONSTRAINT ppa_active_has_credentials CHECK (
  status <> 'ACTIVE'
  OR provider = 'STRIPE'
  OR (access_token_encrypted IS NOT NULL AND refresh_token_encrypted IS NOT NULL AND credentials_key_version IS NOT NULL)
);
ALTER TABLE public.payment_provider_authorizations ADD CONSTRAINT ppa_stripe_no_tokens CHECK (
  provider <> 'STRIPE' OR (access_token_encrypted IS NULL AND refresh_token_encrypted IS NULL)
);

-- Pode receber = vinculo conectado + autorizacao ativa + (se Stripe) charges_enabled.
-- CREATE OR REPLACE: a assinatura nao muda, entao os GRANTs da 0019 continuam valendo.
CREATE OR REPLACE FUNCTION app.tenant_has_payment_account(p_tenant uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN RETURN false; END IF;
  RETURN EXISTS (SELECT 1 FROM public.tenant_payment_accounts a
                   JOIN public.payment_provider_authorizations z ON z.id = a.authorization_id
                  WHERE a.tenant_id = p_tenant AND a.status = 'CONNECTED' AND z.status = 'ACTIVE'
                    AND (a.provider <> 'STRIPE' OR z.charges_enabled IS TRUE));
END;
$$;

-- Qual conta cobra uma venda NOVA: a conectada ha menos tempo que pode receber.
CREATE FUNCTION app.tenant_receiving_provider(p_tenant uuid, p_environment public.payment_environment)
RETURNS TABLE (account_id uuid, provider public.payment_provider)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN RETURN; END IF;
  RETURN QUERY
  SELECT a.id, a.provider FROM public.tenant_payment_accounts a
    JOIN public.payment_provider_authorizations z ON z.id = a.authorization_id
   WHERE a.tenant_id = p_tenant AND a.environment = p_environment
     AND a.status = 'CONNECTED' AND z.status = 'ACTIVE'
     AND (a.provider <> 'STRIPE' OR z.charges_enabled IS TRUE)
   ORDER BY a.connected_at DESC, a.id DESC LIMIT 1;
END;
$$;
REVOKE EXECUTE ON FUNCTION app.tenant_receiving_provider(uuid, public.payment_environment) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_receiving_provider(uuid, public.payment_environment) TO app_user, app_worker;

-- Taxa vigente: plano da assinatura viva da comunidade, senao o padrao da plataforma.
-- So a propria comunidade (ou o worker) le a taxa: para outra devolve NULL.
-- Assinatura `unpaid`/`paused` NAO conta como viva: de proposito cai na taxa padrao.
CREATE FUNCTION app.tenant_platform_fee_bps(p_tenant uuid)
RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN RETURN NULL; END IF;
  RETURN COALESCE(
    (SELECT p.platform_fee_bps FROM public.tenant_subscriptions s
       JOIN public.plans p ON p.id = s.plan_id
      WHERE s.tenant_id = p_tenant AND s.status IN ('trialing', 'active', 'past_due')),
    (SELECT default_platform_fee_bps FROM public.billing_settings));
END;
$$;
REVOKE EXECUTE ON FUNCTION app.tenant_platform_fee_bps(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_platform_fee_bps(uuid) TO app_user, app_worker;

-- Leitura da conta para a tela: ganha o estado Connect. O tipo de retorno muda, entao
-- DROP + CREATE; os privilegios da 0019 sao reaplicados (nada e publico).
DROP FUNCTION app.payment_account_overview(uuid);
CREATE FUNCTION app.payment_account_overview(p_tenant uuid)
RETURNS TABLE (
  id uuid, provider public.payment_provider, environment public.payment_environment,
  status public.payment_account_status, provider_account_id text,
  authorization_status public.payment_authorization_status, token_expires_at timestamptz,
  last_verified_at timestamptz, last_error text, connected_at timestamptz,
  disconnect_requested_at timestamptz, can_receive boolean, open_obligations integer,
  charges_enabled boolean, payouts_enabled boolean, requirements_due text[]
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
         (a.status = 'CONNECTED' AND z.status = 'ACTIVE' AND (a.provider <> 'STRIPE' OR z.charges_enabled IS TRUE)),
         app.payment_account_open_obligations(a.id),
         z.charges_enabled, z.payouts_enabled, z.requirements_due
    FROM public.tenant_payment_accounts a
    JOIN public.payment_provider_authorizations z ON z.id = a.authorization_id
   WHERE a.tenant_id = p_tenant
   ORDER BY (a.status = 'CONNECTED') DESC, a.connected_at DESC
   LIMIT 20;
END;
$$;
REVOKE EXECUTE ON FUNCTION app.payment_account_overview(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payment_account_overview(uuid) TO app_user, app_worker;
