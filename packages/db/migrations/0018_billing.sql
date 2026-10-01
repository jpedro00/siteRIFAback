-- =============================================================================
-- 0018 · Assinaturas SaaS (FLUXO A) — planos, assinaturas, historico financeiro
--        da PLATAFORMA e a base do controle de acesso por plano
--
-- DOIS FLUXOS FINANCEIROS INDEPENDENTES
--   A. o criador paga ao Clube da Rifa (Stripe)  ........... ESTA migration
--   B. o participante paga ao organizador (PSP da comunidade) ... 0019
--   Nada aqui reaproveita `orders` ou `payments`: cobranca da plataforma nao e
--   venda de numero. Nao ha divisao de receita nem comissao por venda.
--
-- ESTA MIGRATION NAO MUDA COMPORTAMENTO NENHUM ate ser ligada:
--   * nao ha plano, assinatura nem fatura semeados (nenhum valor comercial);
--   * `billing_settings.enforcement_enabled = false`: as funcoes de limite
--     respondem "permitido" e ninguem perde funcionalidade;
--   * as duas travas comerciais (envio de sorteio para revisao e aceite de convite de
--     equipe) so ATUAM com `enforcement_enabled = true`; ate la o gatilho e o aceite
--     passam direto, como antes.
--
-- REGRAS QUE O BANCO GARANTE (e nao so o codigo)
--   1. PRECO NAO MUDA POR TRAS DO PLANO. Preco da Stripe e imutavel; o gatilho
--      `plans_price_immutable` recusa alterar preco/periodicidade/moeda/Price ID
--      de um plano ja sincronizado. Preco novo = plano novo.
--   2. UMA assinatura VIVA por comunidade (indice parcial): uma cobranca
--      aprovada nao cria duas assinaturas locais.
--   3. A assinatura e o cliente Stripe pertencem a MESMA comunidade: FK composta
--      (tenant_id, stripe_customer_id). Uma comunidade nao usa a assinatura de outra.
--   4. EVENTO REPETIDO OU ANTIGO NAO ESCREVE. Idempotencia por `event_id`; e cada
--      `apply_*` so aplica se `p_observed_at >= stripe_synced_at` (estado ANTIGO
--      nunca sobrepoe estado NOVO), sob lock por objeto Stripe.
--   5. TOLERANCIA DE past_due com referencia PERSISTENTE (`past_due_since`): grava
--      na entrada em past_due e nao anda com webhook duplicado; some ao sair.
--
-- QUEM ESCREVE
--   Tabelas de assinatura/fatura/evento: so as funcoes SECURITY DEFINER abaixo
--   (papeis de runtime so tem SELECT). Cada funcao confere
--   `app.caller_can_touch_tenant` — o worker atua em qualquer comunidade; a API,
--   so na do contexto (mesmo criterio de `apply_psp_payment`).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tipos. Os valores de `subscription_status` e `invoice_status` sao os da Stripe;
-- `packages/shared/src/states/billing.ts` os declara e o teste compara com o banco.
-- ---------------------------------------------------------------------------
CREATE TYPE public.plan_status AS ENUM ('DRAFT', 'AVAILABLE', 'ARCHIVED');
CREATE TYPE public.plan_interval AS ENUM ('month', 'year');
CREATE TYPE public.subscription_status AS ENUM (
  'incomplete', 'incomplete_expired', 'trialing', 'active',
  'past_due', 'canceled', 'unpaid', 'paused'
);
CREATE TYPE public.invoice_status AS ENUM ('draft', 'open', 'paid', 'void', 'uncollectible');
CREATE TYPE public.stripe_event_status AS ENUM (
  'RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED', 'DEAD'
);
CREATE TYPE public.billing_adjustment_kind AS ENUM ('REFUND', 'DISPUTE');

-- ---------------------------------------------------------------------------
-- billing_settings · configuracao global da plataforma (singleton)
-- ---------------------------------------------------------------------------
CREATE TABLE public.billing_settings (
  singleton            boolean PRIMARY KEY DEFAULT true,
  -- Tolerancia de past_due, em dias. 3 por decisao do produto; o Super Admin altera.
  past_due_grace_days  integer     NOT NULL DEFAULT 3,
  -- DESLIGADO por padrao: enquanto o produto nao ligar, nenhum limite/estado de
  -- assinatura barra nada (preserva o funcionamento atual).
  enforcement_enabled  boolean     NOT NULL DEFAULT false,
  updated_by           uuid REFERENCES public.users (id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_settings_singleton CHECK (singleton),
  CONSTRAINT billing_settings_grace_range CHECK (past_due_grace_days BETWEEN 0 AND 90)
);
INSERT INTO public.billing_settings DEFAULT VALUES;

-- ---------------------------------------------------------------------------
-- plans · catalogo global, administrado pelo Super Admin
-- ---------------------------------------------------------------------------
CREATE TABLE public.plans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text                NOT NULL,
  name              text                NOT NULL,
  description       text,
  billing_interval  public.plan_interval NOT NULL,
  -- ESPELHO do Price da Stripe (a fonte do preco e a Stripe). Nunca semeado.
  price_cents       integer             NOT NULL,
  currency          text                NOT NULL DEFAULT 'brl',
  stripe_product_id text,
  stripe_price_id   text,
  -- NULL = ilimitado.
  max_active_draws  integer,
  max_team_members  integer,
  features          text[]              NOT NULL DEFAULT '{}',
  status            public.plan_status  NOT NULL DEFAULT 'DRAFT',
  created_at        timestamptz         NOT NULL DEFAULT now(),
  updated_at        timestamptz         NOT NULL DEFAULT now(),
  CONSTRAINT plans_code_format CHECK (code ~ '^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$' AND char_length(code) BETWEEN 3 AND 40),
  CONSTRAINT plans_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT plans_price_non_negative CHECK (price_cents >= 0),
  CONSTRAINT plans_currency_format CHECK (currency ~ '^[a-z]{3}$'),
  CONSTRAINT plans_limits_valid CHECK (
    (max_active_draws IS NULL OR max_active_draws >= 0)
    AND (max_team_members IS NULL OR max_team_members >= 1)
  ),
  CONSTRAINT plans_features_size CHECK (cardinality(features) <= 50),
  -- So se vende plano que existe na Stripe.
  CONSTRAINT plans_available_needs_stripe CHECK (
    status <> 'AVAILABLE' OR (stripe_product_id IS NOT NULL AND stripe_price_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX plans_code_key ON public.plans (code);
CREATE UNIQUE INDEX plans_stripe_price_key ON public.plans (stripe_price_id) WHERE stripe_price_id IS NOT NULL;

CREATE TRIGGER plans_touch_updated_at BEFORE UPDATE ON public.plans
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE FUNCTION app.plans_price_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.stripe_price_id IS NOT NULL AND (
       NEW.stripe_price_id IS DISTINCT FROM OLD.stripe_price_id
    OR NEW.price_cents     IS DISTINCT FROM OLD.price_cents
    OR NEW.billing_interval IS DISTINCT FROM OLD.billing_interval
    OR NEW.currency        IS DISTINCT FROM OLD.currency
  ) THEN
    RAISE EXCEPTION 'preco, periodicidade e moeda de um plano sincronizado nao mudam: crie um plano novo (Price da Stripe e imutavel)'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER plans_price_immutable BEFORE UPDATE ON public.plans
  FOR EACH ROW EXECUTE FUNCTION app.plans_price_immutable();

-- ---------------------------------------------------------------------------
-- tenant_billing · o cliente Stripe de cada comunidade (1:1)
-- ---------------------------------------------------------------------------
CREATE TABLE public.tenant_billing (
  tenant_id          uuid PRIMARY KEY REFERENCES public.tenants (id) ON DELETE CASCADE,
  stripe_customer_id text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_billing_customer_format CHECK (stripe_customer_id ~ '^cus_'),
  -- Alvo da FK composta das assinaturas e faturas: amarra cliente <-> comunidade.
  CONSTRAINT tenant_billing_tenant_customer_key UNIQUE (tenant_id, stripe_customer_id)
);
CREATE UNIQUE INDEX tenant_billing_customer_key ON public.tenant_billing (stripe_customer_id);
CREATE TRIGGER tenant_billing_touch_updated_at BEFORE UPDATE ON public.tenant_billing
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- tenant_subscriptions · a assinatura pertence a COMUNIDADE, nao ao usuario
-- ---------------------------------------------------------------------------
CREATE TABLE public.tenant_subscriptions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL,
  plan_id                uuid NOT NULL REFERENCES public.plans (id) ON DELETE RESTRICT,
  stripe_customer_id     text NOT NULL,
  stripe_subscription_id text NOT NULL,
  status                 public.subscription_status NOT NULL,
  current_period_start   timestamptz,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean     NOT NULL DEFAULT false,
  cancel_at              timestamptz,
  canceled_at            timestamptz,
  trial_end              timestamptz,
  -- Referencia PERSISTENTE da tolerancia: quando a assinatura ENTROU em past_due.
  past_due_since         timestamptz,
  -- Quando o estado gravado foi OBSERVADO na Stripe. Ordena eventos concorrentes.
  stripe_synced_at       timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_subscriptions_sub_format CHECK (stripe_subscription_id ~ '^sub_'),
  CONSTRAINT tenant_subscriptions_past_due_reference CHECK (status <> 'past_due' OR past_due_since IS NOT NULL),
  -- A assinatura so pode citar o cliente da PROPRIA comunidade.
  CONSTRAINT tenant_subscriptions_customer_of_tenant
    FOREIGN KEY (tenant_id, stripe_customer_id)
    REFERENCES public.tenant_billing (tenant_id, stripe_customer_id) ON DELETE RESTRICT,
  CONSTRAINT tenant_subscriptions_tenant_id_key UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX tenant_subscriptions_stripe_key ON public.tenant_subscriptions (stripe_subscription_id);
-- UMA assinatura viva por comunidade. `incomplete` fica de fora: a Stripe a expira
-- em ~23 h, e um Checkout abandonado nao pode trancar a comunidade.
CREATE UNIQUE INDEX tenant_subscriptions_one_live
  ON public.tenant_subscriptions (tenant_id)
  WHERE status IN ('trialing', 'active', 'past_due', 'unpaid', 'paused');
CREATE INDEX tenant_subscriptions_tenant_idx ON public.tenant_subscriptions (tenant_id, updated_at DESC);
CREATE TRIGGER tenant_subscriptions_touch_updated_at BEFORE UPDATE ON public.tenant_subscriptions
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- billing_invoices · faturas da PLATAFORMA (nao sao pedidos nem pagamentos)
-- ---------------------------------------------------------------------------
CREATE TABLE public.billing_invoices (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL,
  subscription_id        uuid,
  -- Referencia crua: a fatura pode chegar ANTES da assinatura (evento fora de ordem).
  stripe_subscription_ref text,
  stripe_invoice_id      text NOT NULL,
  stripe_customer_id     text NOT NULL,
  status                 public.invoice_status NOT NULL,
  currency               text NOT NULL,
  amount_due_cents       bigint NOT NULL,
  amount_paid_cents      bigint NOT NULL DEFAULT 0,
  amount_remaining_cents bigint NOT NULL DEFAULT 0,
  attempt_count          integer NOT NULL DEFAULT 0,
  period_start           timestamptz,
  period_end             timestamptz,
  paid_at                timestamptz,
  hosted_invoice_url     text,
  stripe_created_at      timestamptz,
  stripe_synced_at       timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_invoices_id_format CHECK (stripe_invoice_id ~ '^in_'),
  CONSTRAINT billing_invoices_amounts_valid CHECK (amount_due_cents >= 0 AND amount_paid_cents >= 0 AND amount_remaining_cents >= 0),
  CONSTRAINT billing_invoices_customer_of_tenant
    FOREIGN KEY (tenant_id, stripe_customer_id)
    REFERENCES public.tenant_billing (tenant_id, stripe_customer_id) ON DELETE RESTRICT,
  CONSTRAINT billing_invoices_subscription_of_tenant
    FOREIGN KEY (tenant_id, subscription_id)
    REFERENCES public.tenant_subscriptions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT billing_invoices_tenant_id_key UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX billing_invoices_stripe_key ON public.billing_invoices (stripe_invoice_id);
CREATE INDEX billing_invoices_tenant_idx ON public.billing_invoices (tenant_id, created_at DESC);
CREATE TRIGGER billing_invoices_touch_updated_at BEFORE UPDATE ON public.billing_invoices
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- billing_adjustments · reembolsos e disputas de ASSINATURA (nao de participante)
-- ---------------------------------------------------------------------------
CREATE TABLE public.billing_adjustments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  invoice_id       uuid,
  kind             public.billing_adjustment_kind NOT NULL,
  -- `re_...` (reembolso) ou `dp_...` (disputa).
  stripe_object_id text NOT NULL,
  amount_cents     bigint NOT NULL,
  currency         text   NOT NULL,
  status           text   NOT NULL,
  reason           text,
  stripe_synced_at timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_adjustments_amount_valid CHECK (amount_cents >= 0),
  CONSTRAINT billing_adjustments_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT billing_adjustments_invoice_of_tenant
    FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES public.billing_invoices (tenant_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX billing_adjustments_stripe_key ON public.billing_adjustments (stripe_object_id);
CREATE TRIGGER billing_adjustments_touch_updated_at BEFORE UPDATE ON public.billing_adjustments
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- stripe_webhook_events · idempotencia por evento, fila e RETENCAO LIMITADA
--
-- O que se guarda, e por que:
--   * `event_id`             chave de idempotencia (a Stripe reenvia por ate ~3 dias).
--   * `event_type`, ids do objeto/cliente/`stripe_created_at`   o minimo para rotear e
--                            reprocessar. NUNCA ordenam (dois eventos podem dividir o
--                            mesmo segundo): quem ordena e o estado atual buscado na
--                            Stripe + o lock por objeto + `stripe_synced_at`.
--   * `payload`              SO um resumo MINIMO montado pela aplicacao (ids e status),
--                            sem e-mail, nome, endereco nem cartao. O teto de 4 KB e do
--                            banco: um payload cru da Stripe nao cabe.
--   * `lease_*`              posse temporaria do processamento (ver `claim_stripe_event`).
--
-- RETENCAO (`purge_stripe_events`, job diario do worker):
--   * `payload` de evento terminal .... zerado apos 30 dias (constante no shared);
--   * a linha (ids de idempotencia) ... mantida por 90 dias, alem da janela de reenvio
--     da Stripe, e entao removida. `PROCESSING/FAILED/RECEIVED` nunca sao apagados.
-- O `tenant_id` fica nulo ate o evento ser resolvido.
-- ---------------------------------------------------------------------------
CREATE TABLE public.stripe_webhook_events (
  event_id          text PRIMARY KEY,
  event_type        text        NOT NULL,
  livemode          boolean     NOT NULL,
  stripe_created_at timestamptz NOT NULL,
  object_type       text,
  object_id         text,
  customer_id       text,
  tenant_id         uuid REFERENCES public.tenants (id) ON DELETE SET NULL,
  status            public.stripe_event_status NOT NULL DEFAULT 'RECEIVED',
  attempts          integer     NOT NULL DEFAULT 0,
  last_error        text,
  payload           jsonb,
  payload_purged_at timestamptz,
  -- Posse do processamento: quem PEGA o evento recebe um token secreto; so ele conclui.
  lease_token       uuid,
  lease_expires_at  timestamptz,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  CONSTRAINT stripe_webhook_events_id_format CHECK (event_id ~ '^evt_'),
  CONSTRAINT stripe_webhook_events_error_size CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  CONSTRAINT stripe_webhook_events_payload_minimal CHECK (payload IS NULL OR pg_column_size(payload) <= 4096),
  CONSTRAINT stripe_webhook_events_lease_coherent CHECK (
    (status = 'PROCESSING') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);
CREATE INDEX stripe_webhook_events_due_idx
  ON public.stripe_webhook_events (next_attempt_at)
  WHERE status IN ('RECEIVED', 'FAILED', 'PROCESSING');
CREATE INDEX stripe_webhook_events_retention_idx
  ON public.stripe_webhook_events (received_at) WHERE status IN ('PROCESSED', 'IGNORED', 'DEAD');

-- ---------------------------------------------------------------------------
-- RLS e grants. Leitura por comunidade; escrita SO pelas funcoes abaixo.
-- ---------------------------------------------------------------------------
ALTER TABLE public.billing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_billing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;

-- Configuracao: so plataforma.
CREATE POLICY billing_settings_select ON public.billing_settings FOR SELECT USING (app.has_platform_access());
CREATE POLICY billing_settings_update ON public.billing_settings FOR UPDATE
  USING (app.has_platform_access()) WITH CHECK (app.has_platform_access());
GRANT SELECT, UPDATE ON public.billing_settings TO app_user;

-- Catalogo: quem compra ve o que esta A VENDA; a comunidade ve tambem o plano que
-- ja contratou (mesmo arquivado); a plataforma ve e edita tudo.
CREATE POLICY plans_select ON public.plans FOR SELECT USING (
  status = 'AVAILABLE'
  OR app.has_platform_access()
  OR EXISTS (
    SELECT 1 FROM public.tenant_subscriptions s
     WHERE s.plan_id = plans.id AND s.tenant_id = app.current_tenant_id()
  )
);
CREATE POLICY plans_insert ON public.plans FOR INSERT WITH CHECK (app.has_platform_access());
CREATE POLICY plans_update ON public.plans FOR UPDATE
  USING (app.has_platform_access()) WITH CHECK (app.has_platform_access());
GRANT SELECT, INSERT, UPDATE ON public.plans TO app_user;

-- Dados da comunidade: ela le os PROPRIOS; plataforma e worker leem todos.
CREATE POLICY tenant_billing_select ON public.tenant_billing FOR SELECT USING (
  tenant_id = app.current_tenant_id() OR app.has_platform_access() OR session_user = 'app_worker');
CREATE POLICY tenant_subscriptions_select ON public.tenant_subscriptions FOR SELECT USING (
  tenant_id = app.current_tenant_id() OR app.has_platform_access() OR session_user = 'app_worker');
CREATE POLICY billing_invoices_select ON public.billing_invoices FOR SELECT USING (
  tenant_id = app.current_tenant_id() OR app.has_platform_access() OR session_user = 'app_worker');
CREATE POLICY billing_adjustments_select ON public.billing_adjustments FOR SELECT USING (
  tenant_id = app.current_tenant_id() OR app.has_platform_access() OR session_user = 'app_worker');
GRANT SELECT ON public.tenant_billing, public.tenant_subscriptions,
                public.billing_invoices, public.billing_adjustments TO app_user, app_worker;

-- Eventos: o payload traz dado de cliente. Comunidade NAO le; plataforma e worker sim.
CREATE POLICY stripe_webhook_events_select ON public.stripe_webhook_events FOR SELECT USING (
  app.has_platform_access() OR session_user = 'app_worker');
GRANT SELECT ON public.stripe_webhook_events TO app_user, app_worker;

-- ---------------------------------------------------------------------------
-- Fila de eventos: registrar, PEGAR (lease), concluir, listar, expurgar
--
-- 1. `record_stripe_event`  grava DURAVELMENTE (idempotente por `event_id`). O endpoint
--    so responde 2xx depois disto.
-- 2. `claim_stripe_event`   pega o evento para processar. Devolve um TOKEN de posse,
--    valido ate o fim do lease. Sem token, ninguem conclui o evento.
-- 3. `finish_stripe_event`  so quem tem o token do lease VIGENTE conclui. Um processo
--    que perdeu o lease (travou, demorou) nao consegue sobrescrever o resultado de
--    quem o assumiu. Falhas viram retry com recuo; passou de 10 tentativas, DEAD.
-- 4. `list_stripe_events_due` / `purge_stripe_events`  so o worker.
-- ---------------------------------------------------------------------------

-- 'NEW' | 'DUPLICATE_DONE' (concluido: nada a fazer)
--       | 'DUPLICATE_PENDING' (ja gravado, ainda nao concluido).
CREATE FUNCTION app.record_stripe_event(
  p_event_id    text,
  p_type        text,
  p_created     timestamptz,
  p_livemode    boolean,
  p_object_type text,
  p_object_id   text,
  p_customer_id text,
  p_payload     jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  atual public.stripe_event_status;
BEGIN
  INSERT INTO public.stripe_webhook_events
    (event_id, event_type, livemode, stripe_created_at, object_type, object_id, customer_id, payload)
  VALUES (p_event_id, p_type, p_livemode, p_created, p_object_type, p_object_id, p_customer_id, p_payload)
  ON CONFLICT (event_id) DO NOTHING;

  IF FOUND THEN
    RETURN 'NEW';
  END IF;

  SELECT status INTO atual FROM public.stripe_webhook_events WHERE event_id = p_event_id;
  RETURN CASE WHEN atual IN ('PROCESSED', 'IGNORED') THEN 'DUPLICATE_DONE' ELSE 'DUPLICATE_PENDING' END;
END;
$$;

-- Pega o evento. Vazio = nao esta pronto (ja concluido, em andamento com lease
-- vigente, ou aguardando o recuo do retry).
CREATE FUNCTION app.claim_stripe_event(p_event_id text, p_lease_seconds integer)
RETURNS TABLE (
  lease_token uuid, event_type text, object_type text, object_id text,
  customer_id text, stripe_created_at timestamptz, attempts integer, payload jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 10 OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'lease fora do intervalo permitido (10 a 900 s)' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  UPDATE public.stripe_webhook_events e
     SET status           = 'PROCESSING',
         lease_token      = gen_random_uuid(),
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts         = e.attempts + 1
   WHERE e.event_id = p_event_id
     AND (
          (e.status IN ('RECEIVED', 'FAILED') AND e.next_attempt_at <= now())
       OR (e.status = 'PROCESSING' AND e.lease_expires_at < now())
     )
  RETURNING e.lease_token, e.event_type, e.object_type, e.object_id, e.customer_id,
            e.stripe_created_at, e.attempts, e.payload;
END;
$$;

-- Conclui. Retorna true so se o TOKEN confere e o evento ainda esta PROCESSING.
--   PROCESSED / IGNORED  terminal;
--   FAILED               volta para a fila com recuo (15 s x 2^tentativas, teto de 1 h);
--                        na 10a tentativa vira DEAD (inspecao humana);
--   DEAD                 terminal, sem retry (ex.: cliente/assinatura de outra comunidade).
-- Se o evento ja tem comunidade, `p_tenant` precisa ser a MESMA.
CREATE FUNCTION app.finish_stripe_event(
  p_event_id    text,
  p_lease_token uuid,
  p_status      public.stripe_event_status,
  p_tenant      uuid,
  p_error       text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ev        public.stripe_webhook_events%ROWTYPE;
  v_status  public.stripe_event_status := p_status;
  max_tent  constant integer := 10;
BEGIN
  IF p_status NOT IN ('PROCESSED', 'IGNORED', 'FAILED', 'DEAD') THEN
    RAISE EXCEPTION 'estado final invalido: %', p_status USING ERRCODE = '22023';
  END IF;
  IF p_lease_token IS NULL THEN
    RETURN false;
  END IF;

  SELECT * INTO ev FROM public.stripe_webhook_events
   WHERE event_id = p_event_id AND status = 'PROCESSING' AND lease_token = p_lease_token
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF p_tenant IS NOT NULL THEN
    IF NOT app.caller_can_touch_tenant(p_tenant) THEN
      RAISE EXCEPTION 'sem acesso a comunidade' USING ERRCODE = '42501';
    END IF;
    IF ev.tenant_id IS NOT NULL AND ev.tenant_id <> p_tenant THEN
      RAISE EXCEPTION 'o evento pertence a outra comunidade' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_status = 'FAILED' AND ev.attempts >= max_tent THEN
    v_status := 'DEAD';
  END IF;

  UPDATE public.stripe_webhook_events
     SET status           = v_status,
         last_error       = left(p_error, 500),
         tenant_id        = COALESCE(tenant_id, p_tenant),
         lease_token      = NULL,
         lease_expires_at = NULL,
         next_attempt_at  = CASE WHEN v_status = 'FAILED'
                                 THEN now() + make_interval(secs => LEAST(15 * power(2, ev.attempts), 3600)::integer)
                                 ELSE next_attempt_at END,
         processed_at     = CASE WHEN v_status IN ('PROCESSED', 'IGNORED') THEN now() ELSE processed_at END
   WHERE event_id = p_event_id;
  RETURN true;
END;
$$;

-- Worker: os eventos que estao na hora de (re)processar — novos, falhos ja liberados
-- pelo recuo, e os que ficaram PROCESSING com o lease vencido (processo interrompido).
CREATE FUNCTION app.list_stripe_events_due(p_limit integer)
RETURNS TABLE (event_id text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF session_user <> 'app_worker' THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT e.event_id FROM public.stripe_webhook_events e
   WHERE (e.status IN ('RECEIVED', 'FAILED') AND e.next_attempt_at <= now())
      OR (e.status = 'PROCESSING' AND e.lease_expires_at < now())
   ORDER BY e.received_at
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
END;
$$;

-- Worker: aplica a politica de retencao. Devolve (payloads zerados, linhas removidas).
CREATE FUNCTION app.purge_stripe_events(p_payload_days integer, p_row_days integer)
RETURNS TABLE (payloads_cleared integer, rows_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  a integer;
  b integer;
BEGIN
  IF session_user <> 'app_worker' THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;
  IF p_payload_days < 1 OR p_row_days < p_payload_days THEN
    RAISE EXCEPTION 'retencao invalida: a linha nao pode sair antes do payload' USING ERRCODE = '22023';
  END IF;

  UPDATE public.stripe_webhook_events
     SET payload = NULL, payload_purged_at = now()
   WHERE payload IS NOT NULL
     AND status IN ('PROCESSED', 'IGNORED', 'DEAD')
     AND received_at < now() - make_interval(days => p_payload_days);
  GET DIAGNOSTICS a = ROW_COUNT;

  DELETE FROM public.stripe_webhook_events
   WHERE status IN ('PROCESSED', 'IGNORED')
     AND received_at < now() - make_interval(days => p_row_days);
  GET DIAGNOSTICS b = ROW_COUNT;

  RETURN QUERY SELECT a, b;
END;
$$;

-- Serializa o processamento de UM objeto Stripe e devolve o instante do RELOGIO DO
-- BANCO em que o lock foi obtido. Quem sincroniza chama isto ANTES de consultar a
-- Stripe, na mesma transacao que aplica: consulta e gravacao ficam sob o mesmo lock,
-- e a ordem vem de um unico relogio — nao do `created` do evento.
CREATE FUNCTION app.begin_stripe_object_sync(p_kind text, p_object_id text)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_kind NOT IN ('sub', 'inv', 'adj') THEN
    RAISE EXCEPTION 'tipo de objeto invalido' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('stripe-' || p_kind || ':' || p_object_id, 0));
  RETURN clock_timestamp();
END;
$$;

-- ---------------------------------------------------------------------------
-- Identificacao SEGURA da comunidade: pelo cliente Stripe que NOS criamos, nunca
-- por um campo que o navegador ou o payload mandem.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.resolve_tenant_by_stripe_customer(p_customer text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT tenant_id FROM public.tenant_billing WHERE stripe_customer_id = p_customer;
$$;

-- Registra o cliente Stripe da comunidade. Uma comunidade tem UM cliente; um
-- cliente pertence a UMA comunidade.
-- Retorna 'linked' | 'already_linked' | 'forbidden' | 'tenant_has_other_customer'
--       | 'customer_of_other_tenant'
CREATE FUNCTION app.link_stripe_customer(p_tenant uuid, p_customer text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  atual text;
  dono  uuid;
BEGIN
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN
    RETURN 'forbidden';
  END IF;

  SELECT stripe_customer_id INTO atual FROM public.tenant_billing WHERE tenant_id = p_tenant FOR UPDATE;
  IF FOUND THEN
    RETURN CASE WHEN atual = p_customer THEN 'already_linked' ELSE 'tenant_has_other_customer' END;
  END IF;

  SELECT tenant_id INTO dono FROM public.tenant_billing WHERE stripe_customer_id = p_customer;
  IF FOUND THEN
    RETURN 'customer_of_other_tenant';
  END IF;

  INSERT INTO public.tenant_billing (tenant_id, stripe_customer_id) VALUES (p_tenant, p_customer);
  INSERT INTO public.audit_events (tenant_id, actor_user_id, actor_type, action, target_type, target_id)
  VALUES (p_tenant, NULL, 'SYSTEM', 'billing.customer_linked', 'tenant', p_tenant::text);
  RETURN 'linked';
END;
$$;

-- ---------------------------------------------------------------------------
-- apply_stripe_subscription · a UNICA porta de escrita da assinatura
--
-- Retorna 'applied' | 'stale' | 'forbidden' | 'customer_mismatch' | 'unknown_plan'.
--   stale             o estado observado e MAIS ANTIGO que o gravado: ignorado.
--   customer_mismatch o cliente/assinatura nao pertence a esta comunidade: nada
--                     e gravado e a tentativa fica na auditoria.
--   unknown_plan      o Price nao esta no catalogo: o evento deve ficar FAILED
--                     para reprocessar depois que o plano for sincronizado.
-- Um `unique_violation` (segunda assinatura VIVA) NAO e engolido: sobe e o evento
-- fica FAILED — e um caso para a operacao (duas cobrancas para uma comunidade).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.apply_stripe_subscription(
  p_tenant                 uuid,
  p_stripe_subscription_id text,
  p_stripe_customer_id     text,
  p_stripe_price_id        text,
  p_status                 public.subscription_status,
  p_period_start           timestamptz,
  p_period_end             timestamptz,
  p_cancel_at_period_end   boolean,
  p_cancel_at              timestamptz,
  p_canceled_at            timestamptz,
  p_trial_end              timestamptz,
  p_past_due_at            timestamptz,
  p_observed_at            timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  cur      public.tenant_subscriptions%ROWTYPE;
  achou    boolean;
  v_plan   uuid;
  v_since  timestamptz;
  v_code   text;
BEGIN
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN
    RETURN 'forbidden';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_billing
     WHERE tenant_id = p_tenant AND stripe_customer_id = p_stripe_customer_id
  ) THEN
    INSERT INTO public.audit_events (tenant_id, actor_user_id, actor_type, action, target_type, target_id, after)
    VALUES (p_tenant, NULL, 'SYSTEM', 'billing.customer_mismatch', 'subscription', p_stripe_subscription_id,
            jsonb_build_object('customer', p_stripe_customer_id));
    RETURN 'customer_mismatch';
  END IF;

  SELECT id INTO v_plan FROM public.plans WHERE stripe_price_id = p_stripe_price_id;
  IF v_plan IS NULL THEN
    RETURN 'unknown_plan';
  END IF;

  -- Serializa QUALQUER processamento da mesma assinatura (inclusive a primeira
  -- insercao, em que ainda nao ha linha para travar).
  PERFORM pg_advisory_xact_lock(hashtextextended('stripe-sub:' || p_stripe_subscription_id, 0));

  SELECT * INTO cur FROM public.tenant_subscriptions
   WHERE stripe_subscription_id = p_stripe_subscription_id FOR UPDATE;
  achou := FOUND;

  IF achou THEN
    IF cur.tenant_id <> p_tenant THEN
      INSERT INTO public.audit_events (tenant_id, actor_user_id, actor_type, action, target_type, target_id, after)
      VALUES (p_tenant, NULL, 'SYSTEM', 'billing.subscription_mismatch', 'subscription', p_stripe_subscription_id,
              jsonb_build_object('customer', p_stripe_customer_id));
      RETURN 'customer_mismatch';
    END IF;
    IF p_observed_at < cur.stripe_synced_at THEN
      RETURN 'stale';
    END IF;
  END IF;

  -- Referencia PERSISTENTE da tolerancia. Entrou em past_due agora: grava; ja
  -- estava: MANTEM (webhook repetido nao reinicia a contagem); saiu: limpa.
  IF p_status = 'past_due' THEN
    v_since := CASE
      WHEN achou AND cur.status = 'past_due' THEN cur.past_due_since
      ELSE COALESCE(p_past_due_at, p_observed_at)
    END;
  ELSE
    v_since := NULL;
  END IF;

  INSERT INTO public.tenant_subscriptions (
    tenant_id, plan_id, stripe_customer_id, stripe_subscription_id, status,
    current_period_start, current_period_end, cancel_at_period_end, cancel_at,
    canceled_at, trial_end, past_due_since, stripe_synced_at
  ) VALUES (
    p_tenant, v_plan, p_stripe_customer_id, p_stripe_subscription_id, p_status,
    p_period_start, p_period_end, COALESCE(p_cancel_at_period_end, false), p_cancel_at,
    p_canceled_at, p_trial_end, v_since, p_observed_at
  )
  ON CONFLICT (stripe_subscription_id) DO UPDATE SET
    plan_id              = EXCLUDED.plan_id,
    status               = EXCLUDED.status,
    current_period_start = EXCLUDED.current_period_start,
    current_period_end   = EXCLUDED.current_period_end,
    cancel_at_period_end = EXCLUDED.cancel_at_period_end,
    cancel_at            = EXCLUDED.cancel_at,
    canceled_at          = EXCLUDED.canceled_at,
    trial_end            = EXCLUDED.trial_end,
    past_due_since       = EXCLUDED.past_due_since,
    stripe_synced_at     = EXCLUDED.stripe_synced_at
  WHERE public.tenant_subscriptions.stripe_synced_at <= EXCLUDED.stripe_synced_at;

  -- Faturas que chegaram ANTES da assinatura passam a apontar para ela.
  UPDATE public.billing_invoices bi
     SET subscription_id = (SELECT id FROM public.tenant_subscriptions WHERE stripe_subscription_id = p_stripe_subscription_id)
   WHERE bi.tenant_id = p_tenant
     AND bi.subscription_id IS NULL
     AND bi.stripe_subscription_ref = p_stripe_subscription_id;

  -- Auditoria so quando algo MUDOU (evento repetido nao polui a trilha).
  IF NOT achou OR cur.status IS DISTINCT FROM p_status OR cur.plan_id IS DISTINCT FROM v_plan
     OR cur.cancel_at_period_end IS DISTINCT FROM COALESCE(p_cancel_at_period_end, false) THEN
    SELECT code INTO v_code FROM public.plans WHERE id = v_plan;
    INSERT INTO public.audit_events (tenant_id, actor_user_id, actor_type, action, target_type, target_id, before, after)
    VALUES (p_tenant, NULL, 'SYSTEM', 'billing.subscription_synced', 'subscription', p_stripe_subscription_id,
            CASE WHEN achou THEN jsonb_build_object('status', cur.status) ELSE NULL END,
            jsonb_build_object('status', p_status, 'plan', v_code,
                               'cancelAtPeriodEnd', COALESCE(p_cancel_at_period_end, false)));
  END IF;

  RETURN 'applied';
END;
$$;

-- ---------------------------------------------------------------------------
-- apply_stripe_invoice · fatura da plataforma. Mesmas garantias.
-- Retorna 'applied' | 'stale' | 'forbidden' | 'customer_mismatch'.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.apply_stripe_invoice(
  p_tenant                 uuid,
  p_stripe_invoice_id      text,
  p_stripe_customer_id     text,
  p_stripe_subscription_id text,
  p_status                 public.invoice_status,
  p_currency               text,
  p_amount_due_cents       bigint,
  p_amount_paid_cents      bigint,
  p_amount_remaining_cents bigint,
  p_attempt_count          integer,
  p_period_start           timestamptz,
  p_period_end             timestamptz,
  p_paid_at                timestamptz,
  p_hosted_invoice_url     text,
  p_stripe_created_at      timestamptz,
  p_observed_at            timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  cur     public.billing_invoices%ROWTYPE;
  v_sub   uuid;
  existia boolean;
BEGIN
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN
    RETURN 'forbidden';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_billing
     WHERE tenant_id = p_tenant AND stripe_customer_id = p_stripe_customer_id
  ) THEN
    INSERT INTO public.audit_events (tenant_id, actor_user_id, actor_type, action, target_type, target_id, after)
    VALUES (p_tenant, NULL, 'SYSTEM', 'billing.customer_mismatch', 'invoice', p_stripe_invoice_id,
            jsonb_build_object('customer', p_stripe_customer_id));
    RETURN 'customer_mismatch';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('stripe-inv:' || p_stripe_invoice_id, 0));

  SELECT * INTO cur FROM public.billing_invoices WHERE stripe_invoice_id = p_stripe_invoice_id FOR UPDATE;
  existia := FOUND;
  IF existia THEN
    IF cur.tenant_id <> p_tenant THEN
      RETURN 'customer_mismatch';
    END IF;
    IF p_observed_at < cur.stripe_synced_at THEN
      RETURN 'stale';
    END IF;
  END IF;

  SELECT id INTO v_sub FROM public.tenant_subscriptions
   WHERE tenant_id = p_tenant AND stripe_subscription_id = p_stripe_subscription_id;

  INSERT INTO public.billing_invoices (
    tenant_id, subscription_id, stripe_subscription_ref, stripe_invoice_id, stripe_customer_id,
    status, currency, amount_due_cents, amount_paid_cents, amount_remaining_cents, attempt_count,
    period_start, period_end, paid_at, hosted_invoice_url, stripe_created_at, stripe_synced_at
  ) VALUES (
    p_tenant, v_sub, p_stripe_subscription_id, p_stripe_invoice_id, p_stripe_customer_id,
    p_status, lower(p_currency), p_amount_due_cents, p_amount_paid_cents, p_amount_remaining_cents,
    COALESCE(p_attempt_count, 0), p_period_start, p_period_end, p_paid_at, p_hosted_invoice_url,
    p_stripe_created_at, p_observed_at
  )
  ON CONFLICT (stripe_invoice_id) DO UPDATE SET
    subscription_id        = COALESCE(EXCLUDED.subscription_id, public.billing_invoices.subscription_id),
    status                 = EXCLUDED.status,
    amount_due_cents       = EXCLUDED.amount_due_cents,
    amount_paid_cents      = EXCLUDED.amount_paid_cents,
    amount_remaining_cents = EXCLUDED.amount_remaining_cents,
    attempt_count          = EXCLUDED.attempt_count,
    period_start           = EXCLUDED.period_start,
    period_end             = EXCLUDED.period_end,
    paid_at                = EXCLUDED.paid_at,
    hosted_invoice_url     = EXCLUDED.hosted_invoice_url,
    stripe_synced_at       = EXCLUDED.stripe_synced_at
  WHERE public.billing_invoices.stripe_synced_at <= EXCLUDED.stripe_synced_at;

  IF NOT existia OR cur.status IS DISTINCT FROM p_status THEN
    INSERT INTO public.audit_events (tenant_id, actor_user_id, actor_type, action, target_type, target_id, before, after)
    VALUES (p_tenant, NULL, 'SYSTEM', 'billing.invoice_synced', 'invoice', p_stripe_invoice_id,
            NULL, jsonb_build_object('status', p_status, 'amountDueCents', p_amount_due_cents));
  END IF;

  RETURN 'applied';
END;
$$;

-- ---------------------------------------------------------------------------
-- apply_stripe_adjustment · reembolso / disputa de assinatura
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.apply_stripe_adjustment(
  p_tenant                 uuid,
  p_stripe_customer_id     text,
  p_stripe_invoice_id      text,
  p_kind                   public.billing_adjustment_kind,
  p_stripe_object_id       text,
  p_amount_cents           bigint,
  p_currency               text,
  p_status                 text,
  p_reason                 text,
  p_observed_at            timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  cur   public.billing_adjustments%ROWTYPE;
  v_inv uuid;
BEGIN
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN
    RETURN 'forbidden';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_billing
     WHERE tenant_id = p_tenant AND stripe_customer_id = p_stripe_customer_id
  ) THEN
    RETURN 'customer_mismatch';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('stripe-adj:' || p_stripe_object_id, 0));

  SELECT * INTO cur FROM public.billing_adjustments WHERE stripe_object_id = p_stripe_object_id FOR UPDATE;
  IF FOUND THEN
    IF cur.tenant_id <> p_tenant THEN RETURN 'customer_mismatch'; END IF;
    IF p_observed_at < cur.stripe_synced_at THEN RETURN 'stale'; END IF;
  END IF;

  SELECT id INTO v_inv FROM public.billing_invoices
   WHERE tenant_id = p_tenant AND stripe_invoice_id = p_stripe_invoice_id;

  INSERT INTO public.billing_adjustments
    (tenant_id, invoice_id, kind, stripe_object_id, amount_cents, currency, status, reason, stripe_synced_at)
  VALUES
    (p_tenant, v_inv, p_kind, p_stripe_object_id, p_amount_cents, lower(p_currency), p_status, p_reason, p_observed_at)
  ON CONFLICT (stripe_object_id) DO UPDATE SET
    invoice_id       = COALESCE(EXCLUDED.invoice_id, public.billing_adjustments.invoice_id),
    amount_cents     = EXCLUDED.amount_cents,
    status           = EXCLUDED.status,
    reason           = EXCLUDED.reason,
    stripe_synced_at = EXCLUDED.stripe_synced_at
  WHERE public.billing_adjustments.stripe_synced_at <= EXCLUDED.stripe_synced_at;

  RETURN 'applied';
END;
$$;

-- ---------------------------------------------------------------------------
-- billing_checkout_sessions · UM Checkout aberto por comunidade
--
-- Evita contratacao duplicada por repeticao ou concorrencia: o indice parcial so
-- admite uma sessao ABERTA por comunidade. Escrita so pelas funcoes abaixo.
-- Voltar da Stripe (success_url) NAO muda nada aqui: a sessao so vira COMPLETED
-- quando o webhook `checkout.session.completed` e processado — e mesmo assim quem
-- concede acesso e a ASSINATURA sincronizada, nao esta linha.
-- ---------------------------------------------------------------------------
CREATE TABLE public.billing_checkout_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  plan_id           uuid NOT NULL REFERENCES public.plans (id) ON DELETE RESTRICT,
  stripe_session_id text NOT NULL,
  status            text NOT NULL DEFAULT 'OPEN',
  url               text NOT NULL,
  expires_at        timestamptz NOT NULL,
  created_by        uuid REFERENCES public.users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  CONSTRAINT billing_checkout_status_valid CHECK (status IN ('OPEN', 'COMPLETED', 'EXPIRED')),
  CONSTRAINT billing_checkout_session_format CHECK (stripe_session_id ~ '^cs_')
);
CREATE UNIQUE INDEX billing_checkout_stripe_key ON public.billing_checkout_sessions (stripe_session_id);
CREATE UNIQUE INDEX billing_checkout_one_open ON public.billing_checkout_sessions (tenant_id) WHERE status = 'OPEN';

ALTER TABLE public.billing_checkout_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_checkout_select ON public.billing_checkout_sessions FOR SELECT USING (
  tenant_id = app.current_tenant_id() OR app.has_platform_access() OR session_user = 'app_worker');
GRANT SELECT ON public.billing_checkout_sessions TO app_user, app_worker;

-- Registra o Checkout recem-criado na Stripe. Fecha (EXPIRED) os abertos que ja
-- venceram; se ainda houver outro ABERTO, o indice unico recusa (23505).
CREATE FUNCTION app.record_checkout_session(
  p_tenant uuid, p_plan uuid, p_user uuid, p_stripe_session_id text, p_url text, p_expires_at timestamptz
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

  UPDATE public.billing_checkout_sessions SET status = 'EXPIRED'
   WHERE tenant_id = p_tenant AND status = 'OPEN' AND expires_at < now();

  INSERT INTO public.billing_checkout_sessions (tenant_id, plan_id, stripe_session_id, url, expires_at, created_by)
  VALUES (p_tenant, p_plan, p_stripe_session_id, p_url, p_expires_at, p_user)
  RETURNING id INTO v_id;

  INSERT INTO public.audit_events (tenant_id, actor_user_id, actor_type, action, target_type, target_id, after)
  VALUES (p_tenant, p_user, CASE WHEN p_user IS NULL THEN 'SYSTEM' ELSE 'USER' END,
          'billing.checkout_created', 'checkout_session', p_stripe_session_id,
          jsonb_build_object('planId', p_plan));
  RETURN v_id;
END;
$$;

-- 'updated' | 'forbidden' | 'unknown_session'. So a comunidade DONA da sessao a muda.
CREATE FUNCTION app.set_checkout_session_status(p_tenant uuid, p_stripe_session_id text, p_status text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_status NOT IN ('COMPLETED', 'EXPIRED') THEN
    RAISE EXCEPTION 'estado invalido' USING ERRCODE = '22023';
  END IF;
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN
    RETURN 'forbidden';
  END IF;
  UPDATE public.billing_checkout_sessions
     SET status = p_status,
         completed_at = CASE WHEN p_status = 'COMPLETED' THEN now() ELSE completed_at END
   WHERE tenant_id = p_tenant AND stripe_session_id = p_stripe_session_id
     AND status = 'OPEN';
  IF FOUND THEN RETURN 'updated'; END IF;
  RETURN CASE WHEN EXISTS (SELECT 1 FROM public.billing_checkout_sessions
                            WHERE tenant_id = p_tenant AND stripe_session_id = p_stripe_session_id)
              THEN 'updated' ELSE 'unknown_session' END;
END;
$$;

-- Comunidade da sessao (para o webhook `checkout.session.completed`): pelo que NOS
-- gravamos, nunca pelo payload.
CREATE FUNCTION app.resolve_tenant_by_checkout_session(p_stripe_session_id text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT tenant_id FROM public.billing_checkout_sessions WHERE stripe_session_id = p_stripe_session_id;
$$;

-- ---------------------------------------------------------------------------
-- CONTROLE DE ACESSO POR PLANO (entitlements)
--
-- DUAS CAMADAS, para nao duplicar regra:
--   * funcoes `*_unchecked` .... a REGRA, uma vez so. Nao conferem o chamador e NAO tem
--                                GRANT: so outras funcoes definer (gatilhos, aceite de
--                                convite) as chamam, onde o tenant ja vem do proprio dado.
--   * funcoes publicas ......... `caller_can_touch_tenant` + (quando o uso e de AUTORIZAR
--                                uma mutacao) o lock por comunidade. Sao o que a API le.
--
-- Toda mutacao comercial e barrada AQUI, no banco, na MESMA transacao do UPDATE/INSERT:
--   * enviar sorteio para revisao ....... gatilho `draws_06_entitlement_guard`;
--   * aceitar convite de equipe ......... `accept_invitation` -> `enforce_team_capacity`.
-- Nada disso depende de a API "lembrar" de checar, e uma resposta anterior de leitura
-- (GET /entitlements) nunca autoriza nada: quem autoriza e o lock + a contagem.
--
-- Com `enforcement_enabled = false` NADA e barrado (o padrao).
-- ---------------------------------------------------------------------------

-- Estado de cobranca da comunidade, um destes valores:
--   NO_SUBSCRIPTION  nenhuma assinatura (ou so `incomplete_expired`)
--   PENDING          `incomplete`: contratacao iniciada, pagamento nao confirmado
--   TRIALING | ACTIVE
--   PAST_DUE_GRACE   past_due DENTRO da tolerancia
--   PAST_DUE_BLOCKED past_due FORA da tolerancia
--   UNPAID | PAUSED | CANCELED
CREATE FUNCTION app.billing_state_unchecked(p_tenant uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s public.tenant_subscriptions%ROWTYPE;
BEGIN
  -- A "atual": as vivas primeiro; depois a mais recente.
  SELECT * INTO s FROM public.tenant_subscriptions
   WHERE tenant_id = p_tenant
   ORDER BY (status IN ('trialing', 'active', 'past_due', 'unpaid', 'paused')) DESC, updated_at DESC
   LIMIT 1;
  IF NOT FOUND THEN RETURN 'NO_SUBSCRIPTION'; END IF;

  RETURN CASE s.status
    WHEN 'active'             THEN 'ACTIVE'
    WHEN 'trialing'           THEN 'TRIALING'
    WHEN 'incomplete'         THEN 'PENDING'
    WHEN 'incomplete_expired' THEN 'NO_SUBSCRIPTION'
    WHEN 'unpaid'             THEN 'UNPAID'
    WHEN 'paused'             THEN 'PAUSED'
    WHEN 'canceled'           THEN 'CANCELED'
    WHEN 'past_due' THEN (
      SELECT CASE WHEN now() < s.past_due_since + make_interval(days => bs.past_due_grace_days)
                  THEN 'PAST_DUE_GRACE' ELSE 'PAST_DUE_BLOCKED' END
        FROM public.billing_settings bs
    )
  END;
END;
$$;

CREATE FUNCTION app.tenant_billing_state(p_tenant uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN
    RETURN NULL;
  END IF;
  RETURN app.billing_state_unchecked(p_tenant);
END;
$$;

-- Quantos sorteios OCUPAM a franquia: REVISAO, AGENDADA, ATIVA e PAUSADA.
-- Rascunho nao consome (criar e editar rascunho e livre). PAUSADA -> ATIVA nao muda a
-- conta: os dois estados ja sao contados.
CREATE FUNCTION app.active_draw_count_unchecked(p_tenant uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::integer FROM public.draws
   WHERE tenant_id = p_tenant
     AND status IN ('REVISÃO COMPLIANCE', 'AGENDADA', 'ATIVA', 'PAUSADA');
$$;

-- Quantas PESSOAS compoem a equipe ADICIONAL: membros vigentes, SEM o proprietario
-- principal (quem tem dois papeis conta uma vez). `max_team_members` e o numero de
-- membros ALEM do proprietario: a comunidade existe e e administrada por ele mesmo sem
-- assinatura. Convite pendente NAO consome vaga; o aceite reconfere a franquia.
CREATE FUNCTION app.team_member_count_unchecked(p_tenant uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT GREATEST(
    count(DISTINCT m.user_id)::integer
      - CASE WHEN bool_or(m.role = 'OWNER') THEN 1 ELSE 0 END,
    0)
    FROM public.memberships m
   WHERE m.tenant_id = p_tenant AND m.revoked_at IS NULL;
$$;

CREATE FUNCTION app.tenant_active_draw_count(p_tenant uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN RETURN NULL; END IF;
  RETURN app.active_draw_count_unchecked(p_tenant);
END;
$$;

CREATE FUNCTION app.tenant_team_member_count(p_tenant uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN RETURN NULL; END IF;
  RETURN app.team_member_count_unchecked(p_tenant);
END;
$$;

-- O plano vigente, os limites e o CONSUMO. Sem assinatura viva, nao ha plano.
-- `grace_ends_at`: ate quando dura a tolerancia de past_due (nulo fora desse estado).
CREATE FUNCTION app.entitlements_unchecked(p_tenant uuid)
RETURNS TABLE (
  state               text,
  plan_code           text,
  max_active_draws    integer,
  max_team_members    integer,
  features            text[],
  enforcement_enabled boolean,
  grace_ends_at       timestamptz,
  draws_used          integer,
  team_used           integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT app.billing_state_unchecked(p_tenant),
         p.code, p.max_active_draws, p.max_team_members, p.features,
         (SELECT bs.enforcement_enabled FROM public.billing_settings bs),
         (SELECT sub.past_due_since + make_interval(days => bs2.past_due_grace_days)
            FROM public.tenant_subscriptions sub, public.billing_settings bs2
           WHERE sub.tenant_id = p_tenant AND sub.status = 'past_due'
           ORDER BY sub.updated_at DESC LIMIT 1),
         app.active_draw_count_unchecked(p_tenant),
         app.team_member_count_unchecked(p_tenant)
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (
      SELECT pl.* FROM public.tenant_subscriptions s
        JOIN public.plans pl ON pl.id = s.plan_id
       WHERE s.tenant_id = p_tenant AND s.status IN ('trialing', 'active', 'past_due', 'unpaid', 'paused')
       ORDER BY s.updated_at DESC LIMIT 1
    ) p ON true;
$$;

CREATE FUNCTION app.tenant_entitlements(p_tenant uuid)
RETURNS TABLE (
  state               text,
  plan_code           text,
  max_active_draws    integer,
  max_team_members    integer,
  features            text[],
  enforcement_enabled boolean,
  grace_ends_at       timestamptz,
  draws_used          integer,
  team_used           integer
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
  RETURN QUERY SELECT * FROM app.entitlements_unchecked(p_tenant);
END;
$$;

-- O veredito do envio de sorteio para revisao, SEM lock e sem conferir o chamador.
--   * sem assinatura, pendente, cancelada, sem pagamento ou atrasada FORA da tolerancia:
--     bloqueia o ENVIO (rascunhos seguem livres; pagamentos, devolucoes, encerramento,
--     apuracao e resultados de sorteios existentes nao passam por aqui);
--   * acima do limite (downgrade): nada e cancelado, mas NADA NOVO entra.
CREATE FUNCTION app.draw_verdict_unchecked(p_tenant uuid)
RETURNS TABLE (allowed boolean, reason text, used integer, max_allowed integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  e record;
BEGIN
  SELECT * INTO e FROM app.entitlements_unchecked(p_tenant);

  IF NOT e.enforcement_enabled THEN
    RETURN QUERY SELECT true, 'ENFORCEMENT_OFF', e.draws_used, e.max_active_draws;
    RETURN;
  END IF;
  IF e.state NOT IN ('ACTIVE', 'TRIALING', 'PAST_DUE_GRACE') THEN
    RETURN QUERY SELECT false, 'SUBSCRIPTION_' || e.state, e.draws_used, e.max_active_draws;
    RETURN;
  END IF;
  IF e.max_active_draws IS NOT NULL AND e.draws_used >= e.max_active_draws THEN
    RETURN QUERY SELECT false, 'DRAW_LIMIT_REACHED', e.draws_used, e.max_active_draws;
    RETURN;
  END IF;
  RETURN QUERY SELECT true, 'OK', e.draws_used, e.max_active_draws;
END;
$$;

-- Versao de LEITURA (telas): confere o chamador, sem lock.
CREATE FUNCTION app.draw_submission_verdict(p_tenant uuid)
RETURNS TABLE (allowed boolean, reason text, used integer, max_allowed integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN
    RETURN QUERY SELECT false, 'FORBIDDEN', 0, NULL::integer;
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM app.draw_verdict_unchecked(p_tenant);
END;
$$;

-- Versao que AUTORIZA: lock de transacao POR COMUNIDADE, contagem DEPOIS de te-lo. Quem
-- chama faz a checagem e o UPDATE de estado NA MESMA transacao: a segunda solicitacao
-- concorrente espera o commit da primeira e ja enxerga a contagem nova.
CREATE FUNCTION app.check_draw_submission(p_tenant uuid)
RETURNS TABLE (allowed boolean, reason text, used integer, max_allowed integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN
    RETURN QUERY SELECT false, 'FORBIDDEN', 0, NULL::integer;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('draw-slots:' || p_tenant::text, 0));
  RETURN QUERY SELECT * FROM app.draw_verdict_unchecked(p_tenant);
END;
$$;

-- ENFORCAMENTO no banco: RASCUNHO -> REVISAO COMPLIANCE e a UNICA transicao que AUMENTA o
-- consumo de sorteios (a maquina do 0017 nao deixa nenhuma outra entrar nos estados
-- contados). O gatilho roda na transacao do proprio UPDATE, sob o lock da comunidade.
-- Retomar PAUSADA -> ATIVA, aprovar REVISAO -> ATIVA/AGENDADA, encerrar, apurar e publicar
-- nao passam por aqui: nao ocupam vaga nova, e a comunidade precisa poder concluir o que ja
-- vendeu.
CREATE FUNCTION app.draws_entitlement_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v record;
BEGIN
  -- Fora do runtime da API (dono do schema, migrations, worker) nao ha o que barrar.
  IF session_user <> 'app_user' THEN
    RETURN NEW;
  END IF;
  IF NOT (OLD.status = 'RASCUNHO' AND NEW.status = 'REVISÃO COMPLIANCE') THEN
    RETURN NEW;
  END IF;
  -- Cobranca desligada: caminho barato, sem lock.
  IF NOT (SELECT bs.enforcement_enabled FROM public.billing_settings bs) THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('draw-slots:' || NEW.tenant_id::text, 0));
  SELECT * INTO v FROM app.draw_verdict_unchecked(NEW.tenant_id);
  IF NOT v.allowed THEN
    RAISE EXCEPTION 'ENTITLEMENT:%', v.reason
      USING ERRCODE = 'P0001', DETAIL = format('used=%s;max=%s', v.used, COALESCE(v.max_allowed::text, ''));
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER draws_06_entitlement_guard
  BEFORE UPDATE OF status ON public.draws
  FOR EACH ROW EXECUTE FUNCTION app.draws_entitlement_guard();

-- Equipe: veredito SEM lock. `p_user` (opcional) e quem entraria.
--   * quem ja e membro vigente nao ocupa vaga nova (so ganha um papel);
--   * o PROPRIETARIO nao conta na franquia e a comunidade sem proprietario ainda aceita o
--     primeiro (o dono): sem ele ninguem chegaria a administrar a assinatura;
--   * sem plano vigente e com a cobranca ligada, nao ha franquia para conceder (NO_PLAN).
CREATE FUNCTION app.team_verdict_unchecked(p_tenant uuid, p_user uuid)
RETURNS TABLE (allowed boolean, reason text, used integer, max_allowed integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  e record;
BEGIN
  SELECT * INTO e FROM app.entitlements_unchecked(p_tenant);

  IF NOT e.enforcement_enabled THEN
    RETURN QUERY SELECT true, 'ENFORCEMENT_OFF', e.team_used, e.max_team_members;
    RETURN;
  END IF;
  -- Sem proprietario ainda: quem entra E o proprietario (convite de dono de comunidade nova).
  IF NOT EXISTS (SELECT 1 FROM public.memberships m
                  WHERE m.tenant_id = p_tenant AND m.role = 'OWNER' AND m.revoked_at IS NULL)
     OR (p_user IS NOT NULL AND EXISTS (
           SELECT 1 FROM public.memberships m
            WHERE m.tenant_id = p_tenant AND m.user_id = p_user AND m.revoked_at IS NULL)) THEN
    RETURN QUERY SELECT true, 'OK', e.team_used, e.max_team_members;
    RETURN;
  END IF;
  IF e.plan_code IS NULL THEN
    RETURN QUERY SELECT false, 'NO_PLAN', e.team_used, NULL::integer;
    RETURN;
  END IF;
  IF e.max_team_members IS NOT NULL AND e.team_used >= e.max_team_members THEN
    RETURN QUERY SELECT false, 'MEMBER_LIMIT_REACHED', e.team_used, e.max_team_members;
    RETURN;
  END IF;
  RETURN QUERY SELECT true, 'OK', e.team_used, e.max_team_members;
END;
$$;

-- Versao de LEITURA/consulta para a API (com lock, para quem vai agir logo em seguida).
CREATE FUNCTION app.check_team_member_addition(p_tenant uuid)
RETURNS TABLE (allowed boolean, reason text, used integer, max_allowed integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN
    RETURN QUERY SELECT false, 'FORBIDDEN', 0, NULL::integer;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('team-slots:' || p_tenant::text, 0));
  RETURN QUERY SELECT * FROM app.team_verdict_unchecked(p_tenant, NULL);
END;
$$;

-- Chamada por `accept_invitation`, na transacao do aceite: lock por comunidade, contagem
-- depois do lock, e RAISE se nao couber. Sem GRANT: so a funcao definer do aceite a chama.
CREATE FUNCTION app.enforce_team_capacity(p_tenant uuid, p_user uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v record;
BEGIN
  IF NOT (SELECT bs.enforcement_enabled FROM public.billing_settings bs) THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('team-slots:' || p_tenant::text, 0));
  SELECT * INTO v FROM app.team_verdict_unchecked(p_tenant, p_user);
  IF NOT v.allowed THEN
    RAISE EXCEPTION 'ENTITLEMENT:%', v.reason
      USING ERRCODE = 'P0001', DETAIL = format('used=%s;max=%s', v.used, COALESCE(v.max_allowed::text, ''));
  END IF;
END;
$$;

-- Aceite de convite: igual ao da 0016 (mesmos passos, mesmas respostas), com UM passo a
-- mais — a franquia da equipe e reconferida SOB LOCK antes de criar o vinculo. Dois aceites
-- simultaneos para a ultima vaga: um entra, o outro recebe MEMBER_LIMIT_REACHED e nada
-- fica gravado (a transacao inteira desfaz, inclusive o convite continua aberto).
CREATE OR REPLACE FUNCTION app.accept_invitation(p_token_hash text)
RETURNS TABLE (
  out_tenant_id     uuid,
  out_tenant_slug   text,
  out_tenant_name   text,
  out_role          public.membership_role,
  out_membership_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  inv  public.invitations%ROWTYPE;
  usr  public.users%ROWTYPE;
  slug text;
  nome text;
  mid  uuid;
BEGIN
  SELECT * INTO usr FROM public.users WHERE id = app.current_user_id();
  IF NOT FOUND OR usr.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'sessao invalida' USING ERRCODE = 'P0003';
  END IF;

  SELECT * INTO inv FROM public.invitations WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'convite inexistente' USING ERRCODE = 'P0002';
  END IF;
  IF inv.accepted_at IS NOT NULL OR inv.revoked_at IS NOT NULL OR inv.expires_at <= now() THEN
    RAISE EXCEPTION 'convite encerrado' USING ERRCODE = 'P0001';
  END IF;
  IF lower(usr.email) <> inv.email THEN
    -- Mesma resposta de "inexistente": nao confirma a quem o convite pertence.
    RAISE EXCEPTION 'convite inexistente' USING ERRCODE = 'P0002';
  END IF;

  SELECT t.slug, t.name INTO slug, nome FROM public.tenants t WHERE t.id = inv.tenant_id;

  -- A vaga e conferida AGORA, sob lock: convite pendente nao reservou nada.
  PERFORM app.enforce_team_capacity(inv.tenant_id, usr.id);

  INSERT INTO public.memberships (tenant_id, user_id, role, accepted_at, created_by)
  VALUES (inv.tenant_id, usr.id, inv.role, now(), inv.invited_by)
  ON CONFLICT (tenant_id, user_id, role) WHERE revoked_at IS NULL DO NOTHING
  RETURNING id INTO mid;

  IF mid IS NULL THEN
    SELECT m.id INTO mid FROM public.memberships m
     WHERE m.tenant_id = inv.tenant_id AND m.user_id = usr.id AND m.role = inv.role AND m.revoked_at IS NULL;
  END IF;

  UPDATE public.invitations SET accepted_at = now(), accepted_by = usr.id WHERE id = inv.id;

  INSERT INTO public.audit_events
    (tenant_id, actor_user_id, actor_type, action, target_type, target_id, after)
  VALUES (inv.tenant_id, usr.id, 'USER', 'team.invitation_accepted', 'membership', mid::text,
          jsonb_build_object('role', inv.role, 'invitationId', inv.id));

  INSERT INTO public.outbox (tenant_id, event_type, payload)
  VALUES (inv.tenant_id, 'membership.granted', jsonb_build_object(
    'tenantId', inv.tenant_id, 'membershipId', mid, 'userId', usr.id,
    'role', inv.role, 'grantedByUserId', inv.invited_by));

  RETURN QUERY SELECT inv.tenant_id, slug, nome, inv.role, mid;
END;
$$;

-- Funcionalidade do plano. Duas condicoes INDEPENDENTES: o papel do usuario (matriz de
-- permissoes, na API) e o direito COMERCIAL da comunidade (aqui). Uma nao substitui a outra.
CREATE FUNCTION app.tenant_feature_verdict(p_tenant uuid, p_feature text)
RETURNS TABLE (allowed boolean, reason text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  e record;
BEGIN
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN
    RETURN QUERY SELECT false, 'FORBIDDEN';
    RETURN;
  END IF;
  SELECT * INTO e FROM app.entitlements_unchecked(p_tenant);
  IF NOT e.enforcement_enabled THEN
    RETURN QUERY SELECT true, 'ENFORCEMENT_OFF';
    RETURN;
  END IF;
  IF e.state NOT IN ('ACTIVE', 'TRIALING', 'PAST_DUE_GRACE') THEN
    RETURN QUERY SELECT false, 'SUBSCRIPTION_' || e.state;
    RETURN;
  END IF;
  IF p_feature = ANY (COALESCE(e.features, '{}')) THEN
    RETURN QUERY SELECT true, 'OK';
  ELSE
    RETURN QUERY SELECT false, 'FEATURE_NOT_IN_PLAN';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Permissoes de execucao: nada e publico.
--
-- As funcoes `*_unchecked`, `enforce_team_capacity` e o gatilho NAO tem GRANT: rodam como
-- dono, chamadas por outras funcoes definer (o tenant vem do dado, nao do chamador).
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  app.record_stripe_event(text, text, timestamptz, boolean, text, text, text, jsonb),
  app.claim_stripe_event(text, integer),
  app.finish_stripe_event(text, uuid, public.stripe_event_status, uuid, text),
  app.list_stripe_events_due(integer),
  app.purge_stripe_events(integer, integer),
  app.begin_stripe_object_sync(text, text),
  app.resolve_tenant_by_stripe_customer(text),
  app.link_stripe_customer(uuid, text),
  app.record_checkout_session(uuid, uuid, uuid, text, text, timestamptz),
  app.set_checkout_session_status(uuid, text, text),
  app.resolve_tenant_by_checkout_session(text),
  app.apply_stripe_subscription(uuid, text, text, text, public.subscription_status, timestamptz, timestamptz, boolean, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz),
  app.apply_stripe_invoice(uuid, text, text, text, public.invoice_status, text, bigint, bigint, bigint, integer, timestamptz, timestamptz, timestamptz, text, timestamptz, timestamptz),
  app.apply_stripe_adjustment(uuid, text, text, public.billing_adjustment_kind, text, bigint, text, text, text, timestamptz),
  app.tenant_billing_state(uuid),
  app.tenant_team_member_count(uuid),
  app.tenant_active_draw_count(uuid),
  app.tenant_entitlements(uuid),
  app.draw_submission_verdict(uuid),
  app.check_draw_submission(uuid),
  app.check_team_member_addition(uuid),
  app.tenant_feature_verdict(uuid, text),
  app.billing_state_unchecked(uuid),
  app.active_draw_count_unchecked(uuid),
  app.team_member_count_unchecked(uuid),
  app.entitlements_unchecked(uuid),
  app.draw_verdict_unchecked(uuid),
  app.team_verdict_unchecked(uuid, uuid),
  app.enforce_team_capacity(uuid, uuid),
  app.draws_entitlement_guard()
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  app.record_stripe_event(text, text, timestamptz, boolean, text, text, text, jsonb),
  app.claim_stripe_event(text, integer),
  app.finish_stripe_event(text, uuid, public.stripe_event_status, uuid, text),
  app.list_stripe_events_due(integer),
  app.purge_stripe_events(integer, integer),
  app.begin_stripe_object_sync(text, text),
  app.resolve_tenant_by_stripe_customer(text),
  app.link_stripe_customer(uuid, text),
  app.record_checkout_session(uuid, uuid, uuid, text, text, timestamptz),
  app.set_checkout_session_status(uuid, text, text),
  app.resolve_tenant_by_checkout_session(text),
  app.apply_stripe_subscription(uuid, text, text, text, public.subscription_status, timestamptz, timestamptz, boolean, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz),
  app.apply_stripe_invoice(uuid, text, text, text, public.invoice_status, text, bigint, bigint, bigint, integer, timestamptz, timestamptz, timestamptz, text, timestamptz, timestamptz),
  app.apply_stripe_adjustment(uuid, text, text, public.billing_adjustment_kind, text, bigint, text, text, text, timestamptz),
  app.tenant_billing_state(uuid),
  app.tenant_team_member_count(uuid),
  app.tenant_active_draw_count(uuid),
  app.tenant_entitlements(uuid),
  app.draw_submission_verdict(uuid),
  app.check_draw_submission(uuid),
  app.check_team_member_addition(uuid),
  app.tenant_feature_verdict(uuid, text)
TO app_user, app_worker;
