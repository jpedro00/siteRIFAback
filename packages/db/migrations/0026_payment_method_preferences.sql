-- 0026 · preferencia do criador sobre os meios de pagamento.
--
-- O criador so pode DESLIGAR (e religar) meios que a plataforma suporta de verdade e que a conta
-- conectada reporta; quem valida isso e a API (e o contrato). Aqui fica apenas a escolha: a lista
-- de meios que o criador DESLIGOU. Vazia = nada desligado pelo criador (o padrao).
--
-- Tabela por comunidade, com RLS pelo contexto da comunidade. Nao altera migrations anteriores.

CREATE TABLE public.tenant_payment_preferences (
  tenant_id        uuid PRIMARY KEY REFERENCES public.tenants (id) ON DELETE CASCADE,
  disabled_methods text[] NOT NULL DEFAULT '{}',
  updated_by       uuid REFERENCES public.users (id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_payment_prefs_methods_known CHECK (
    disabled_methods <@ ARRAY['PIX', 'CREDIT_CARD', 'DEBIT_CARD', 'ACCOUNT_MONEY', 'BOLETO', 'OTHER']::text[]
  )
);

ALTER TABLE public.tenant_payment_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_payment_prefs_select ON public.tenant_payment_preferences FOR SELECT
  USING (tenant_id = app.current_tenant_id() OR app.has_platform_access());
CREATE POLICY tenant_payment_prefs_insert ON public.tenant_payment_preferences FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_payment_prefs_update ON public.tenant_payment_preferences FOR UPDATE
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

GRANT SELECT, INSERT ON public.tenant_payment_preferences TO app_user;
GRANT UPDATE (disabled_methods, updated_by, updated_at) ON public.tenant_payment_preferences TO app_user;
