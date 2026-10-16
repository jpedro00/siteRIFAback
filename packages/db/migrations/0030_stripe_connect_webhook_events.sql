-- =============================================================================
-- 0030 · Stripe Connect: idempotencia do webhook por `event.id`.
--
-- A Stripe reenvia o mesmo evento (ate ~3 dias) e pode entregar fora de ordem. O endpoint
-- `/api/webhooks/stripe-connect` grava o `event_id` ANTES de processar e so o marca como
-- processado DEPOIS de concluir:
--   * evento novo, ou gravado mas nunca concluido (o processamento falhou e a Stripe reenviou)
--     -> processa;
--   * evento ja concluido -> nada a fazer (200 sem efeito);
--   * evento em andamento (outra entrega o reivindicou ha menos de 60 s) -> nada a fazer agora (200
--     sem trabalho): a primeira entrega cuida dele. Se ela falhar, devolve a SUA reivindicacao
--     (`release_connect_webhook_event`, pelo token) e responde 5xx; se morrer no meio, o lease vence em 60 s.
--     Em ambos os casos o reenvio da Stripe processa.
-- O efeito em si tambem e idempotente (o estado da conta e RELIDO da Stripe; o pagamento passa
-- por `app.apply_psp_payment`, que trava a linha); o lease so evita a consulta dobrada a Stripe.
--
-- Retencao: o evento CONCLUIDO sai depois da janela de reenvio da Stripe
-- (`purge_connect_webhook_events`, job diario do worker); o nao concluido nunca e apagado.
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
  -- Ultima reivindicacao (lease de 60 s) de uma entrega em andamento, e o token de quem a tem: so
  -- o dono devolve (uma entrega lenta cujo lease venceu nao derruba o da entrega seguinte).
  claimed_at   timestamptz,
  claim_token  uuid,
  CONSTRAINT stripe_connect_webhook_events_id_format CHECK (event_id ~ '^evt_[A-Za-z0-9_]{1,255}$'),
  CONSTRAINT stripe_connect_webhook_events_type_size CHECK (char_length(type) BETWEEN 1 AND 200),
  CONSTRAINT stripe_connect_webhook_events_account_format CHECK (account IS NULL OR account ~ '^acct_[A-Za-z0-9]{1,64}$')
);
CREATE INDEX stripe_connect_webhook_events_received_idx ON public.stripe_connect_webhook_events (received_at);

ALTER TABLE public.stripe_connect_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.stripe_connect_webhook_events FROM PUBLIC, app_user, app_worker;

-- Registra e REIVINDICA o evento. Devolve o TOKEN da reivindicacao quando esta entrega deve
-- processa-lo: primeira vez, ou gravado antes, nunca concluido e sem reivindicacao viva (lease de
-- 60 s). NULL = ja concluido ou outra entrega em andamento. Atomico: duas entregas simultaneas, uma
-- so leva o token.
CREATE FUNCTION app.record_connect_webhook_event(p_event_id text, p_type text, p_account text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_token uuid := gen_random_uuid();
  v_claimed uuid;
BEGIN
  INSERT INTO public.stripe_connect_webhook_events AS e (event_id, type, account, claimed_at, claim_token)
  VALUES (p_event_id, p_type, p_account, now(), v_token)
  ON CONFLICT (event_id) DO UPDATE
     SET claimed_at = now(), claim_token = v_token
   WHERE e.processed_at IS NULL
     AND (e.claimed_at IS NULL OR e.claimed_at < now() - interval '60 seconds')
  RETURNING e.claim_token INTO v_claimed;
  RETURN v_claimed;
END;
$$;

-- Devolve a reivindicacao de uma entrega que falhou (o reenvio pode processar ja). So o DONO do
-- lease devolve (token igual) e so em evento nao concluido. TRUE = devolveu.
CREATE FUNCTION app.release_connect_webhook_event(p_event_id text, p_token uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.stripe_connect_webhook_events
     SET claimed_at = NULL, claim_token = NULL
   WHERE event_id = p_event_id AND claim_token = p_token AND processed_at IS NULL;
  RETURN FOUND;
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

-- Retencao (job diario do worker): apaga o evento CONCLUIDO ha mais de `p_days` dias. O nao
-- concluido nunca sai. Devolve quantos apagou; fora do `app_worker`, nao apaga nada.
CREATE FUNCTION app.purge_connect_webhook_events(p_days integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF session_user <> 'app_worker' THEN RETURN 0; END IF;
  IF p_days IS NULL OR p_days < 7 THEN
    -- A Stripe reenvia por ate ~3 dias: abaixo de uma semana a idempotencia ficaria curta demais.
    RAISE EXCEPTION 'retencao invalida' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.stripe_connect_webhook_events
   WHERE processed_at IS NOT NULL
     AND processed_at < now() - make_interval(days => p_days);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE EXECUTE ON FUNCTION
  app.record_connect_webhook_event(text, text, text),
  app.release_connect_webhook_event(text, uuid),
  app.finish_connect_webhook_event(text),
  app.purge_connect_webhook_events(integer)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  app.record_connect_webhook_event(text, text, text),
  app.release_connect_webhook_event(text, uuid),
  app.finish_connect_webhook_event(text)
TO app_user, app_worker;

-- So o worker purga (a guarda de `session_user` e a segunda barreira).
GRANT EXECUTE ON FUNCTION app.purge_connect_webhook_events(integer) TO app_worker;
