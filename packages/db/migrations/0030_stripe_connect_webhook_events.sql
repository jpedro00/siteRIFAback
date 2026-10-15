-- =============================================================================
-- 0030 · Stripe Connect: idempotencia do webhook por `event.id`.
--
-- A Stripe reenvia o mesmo evento (ate ~3 dias) e pode entregar fora de ordem. O endpoint
-- `/api/webhooks/stripe-connect` grava o `event_id` ANTES de processar e so o marca como
-- processado DEPOIS de concluir:
--   * evento novo, ou gravado mas nunca concluido (o processamento falhou e a Stripe reenviou)
--     -> processa;
--   * evento ja concluido -> nada a fazer (200 sem efeito).
-- O efeito em si tambem e idempotente (o estado da conta e RELIDO da Stripe; o pagamento passa
-- por `app.apply_psp_payment`, que trava a linha): duas entregas simultaneas convergem.
--
-- O que se guarda: so o id, o tipo e a conta conectada (`acct_`). Nenhum corpo da Stripe, nenhum
-- dado pessoal. Nao tem tenant_id: o evento chega antes de se saber a comunidade, e
-- `account.updated` e da CONTA. Nenhum papel de runtime le ou escreve a tabela: so as funcoes
-- SECURITY DEFINER abaixo (padrao da 0018/0019).
-- =============================================================================

CREATE TABLE public.stripe_connect_webhook_events (
  event_id     text PRIMARY KEY,
  type         text        NOT NULL,
  account      text,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CONSTRAINT stripe_connect_webhook_events_id_format CHECK (event_id ~ '^evt_[A-Za-z0-9_]{1,255}$'),
  CONSTRAINT stripe_connect_webhook_events_type_size CHECK (char_length(type) BETWEEN 1 AND 200),
  CONSTRAINT stripe_connect_webhook_events_account_format CHECK (account IS NULL OR account ~ '^acct_[A-Za-z0-9]{1,64}$')
);
CREATE INDEX stripe_connect_webhook_events_received_idx ON public.stripe_connect_webhook_events (received_at);

ALTER TABLE public.stripe_connect_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.stripe_connect_webhook_events FROM PUBLIC, app_user, app_worker;

-- Registra o evento. Retorna TRUE quando ele ainda precisa ser processado (primeira vez, ou
-- gravado antes e nunca concluido); FALSE quando ja foi concluido.
CREATE FUNCTION app.record_connect_webhook_event(p_event_id text, p_type text, p_account text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_done timestamptz;
BEGIN
  INSERT INTO public.stripe_connect_webhook_events (event_id, type, account)
  VALUES (p_event_id, p_type, p_account)
  ON CONFLICT (event_id) DO NOTHING;

  IF FOUND THEN
    RETURN true;
  END IF;

  SELECT processed_at INTO v_done FROM public.stripe_connect_webhook_events WHERE event_id = p_event_id;
  RETURN v_done IS NULL;
END;
$$;

-- Marca o evento como concluido. TRUE = marcou agora; FALSE = desconhecido ou ja concluido.
CREATE FUNCTION app.finish_connect_webhook_event(p_event_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.stripe_connect_webhook_events
     SET processed_at = now()
   WHERE event_id = p_event_id AND processed_at IS NULL;
  RETURN FOUND;
END;
$$;

REVOKE EXECUTE ON FUNCTION
  app.record_connect_webhook_event(text, text, text),
  app.finish_connect_webhook_event(text)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  app.record_connect_webhook_event(text, text, text),
  app.finish_connect_webhook_event(text)
TO app_user, app_worker;
