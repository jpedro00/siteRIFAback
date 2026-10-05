-- ============================================================================
-- 0015 · Automacao do back: pagamento como funcao unica, jobs do worker,
--        heartbeat, notificacoes registradas e conciliacao
-- ----------------------------------------------------------------------------
-- POR QUE O PAGAMENTO VIROU FUNCAO NO BANCO
--   Ate a 0014, "concluir a venda" era TypeScript na API. O worker tambem precisa
--   concluir vendas (PIX aprovado que o webhook perdeu, conciliacao) e liberar
--   pedidos (PIX vencido). Duas implementacoes da mesma transicao — uma na API,
--   outra no worker — e exatamente como o mesmo numero acaba vendido duas vezes.
--
--   Estado vive no PostgreSQL. `app.settle_order_paid` e `app.apply_psp_payment`
--   sao a UNICA porta para PAGO; a API e o worker as CHAMAM. A consulta ao PSP
--   continua fora do banco (rede de terceiro nao entra em transacao): quem chama
--   consulta o PSP, e o que o PSP respondeu e o argumento.
--
-- SEGURANCA DAS FUNCOES (SECURITY DEFINER)
--   `session_user` identifica quem CHAMOU. O worker (`app_worker`) opera sobre
--   todas as comunidades; qualquer outro papel so enxerga a comunidade do seu
--   contexto (`app.current_tenant_id()`), como a RLS ja garantia.
-- ============================================================================

-- O chamador pode agir sobre esta comunidade?
CREATE FUNCTION app.caller_can_touch_tenant(p_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  -- COALESCE: sem contexto de comunidade `current_tenant_id()` e NULL, e
  -- `NOT (x = NULL)` seria NULL — o IF nao dispararia e a chamada passaria.
  -- A funcao SEMPRE devolve true ou false.
  SELECT session_user = 'app_worker'
      OR COALESCE(p_tenant = app.current_tenant_id(), false);
$$;
REVOKE EXECUTE ON FUNCTION app.caller_can_touch_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.caller_can_touch_tenant(uuid) TO app_user, app_worker;

-- ---------------------------------------------------------------------------
-- settle_order_paid · a UNICA porta para PAGO. RN06 · RN07.
--
-- Retorna 'PAID' | 'ALREADY_PAID' | 'REFUND_REQUIRED'.
--
-- Os numeros do pedido ja sao dele (PENDENTE) no caminho normal. Se o PIX foi
-- pago DEPOIS de a varredura devolver os numeros a grade:
--   * todos ainda livres            -> a venda se conclui (Suposicao S4);
--   * algum com outro dono          -> nada muda, pagamento marcado para estorno
--                                      MANUAL e evento publicado;
--   * sorteio ja apurado (snapshot) -> idem: o retrato congelado nao muda (RN20).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.settle_order_paid(p_order_id uuid, p_payment_id uuid, p_via text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  o             public.orders%ROWTYPE;
  d_status      public.draw_status;
  numeros       integer[];
  necessarios   integer;
  reivindicados integer := 0;
  n             integer;
  motivo        text;
  perdidos      integer[];
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR NOT app.caller_can_touch_tenant(o.tenant_id) THEN
    RAISE EXCEPTION 'pedido inexistente' USING ERRCODE = 'P0002';
  END IF;

  IF o.status = 'PAGO' THEN
    RETURN 'ALREADY_PAID';
  END IF;

  SELECT status INTO d_status FROM public.draws WHERE id = o.draw_id;
  SELECT array_agg(number ORDER BY number) INTO numeros
    FROM public.order_items WHERE order_id = p_order_id;
  necessarios := COALESCE(cardinality(numeros), 0);

  IF necessarios = 0 THEN
    RAISE EXCEPTION 'pedido sem itens' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM public.draw_snapshots WHERE draw_id = o.draw_id)
     OR d_status NOT IN ('ATIVA', 'PAUSADA', 'VENDAS ENCERRADAS') THEN
    perdidos := numeros;
    motivo := 'Pagamento aprovado depois de o sorteio ter sido apurado; a venda nao pode mais ser concluida.';
  ELSE
    -- Tudo-ou-nada: a sub-transacao desfaz as reivindicacoes se faltar qualquer numero.
    BEGIN
      UPDATE public.draw_numbers
         SET status = 'PAGO', expires_at = NULL
       WHERE order_id = p_order_id AND status = 'PENDENTE';
      GET DIAGNOSTICS n = ROW_COUNT;
      reivindicados := reivindicados + n;

      -- Devolvidos a grade por uma reserva vencida: retomaveis.
      UPDATE public.draw_numbers dn
         SET status = 'PAGO', order_id = p_order_id, reservation_id = NULL, expires_at = NULL
       WHERE dn.draw_id = o.draw_id
         AND dn.number = ANY (numeros)
         AND dn.status = 'RESERVADO'
         AND dn.expires_at <= now();
      GET DIAGNOSTICS n = ROW_COUNT;
      reivindicados := reivindicados + n;

      -- Sem nenhuma linha = livre de verdade: ocupa.
      INSERT INTO public.draw_numbers (tenant_id, draw_id, number, status, order_id)
      SELECT o.tenant_id, o.draw_id, x, 'PAGO', p_order_id
        FROM unnest(numeros) AS x
       WHERE NOT EXISTS (
         SELECT 1 FROM public.draw_numbers dn WHERE dn.draw_id = o.draw_id AND dn.number = x
       )
      ON CONFLICT (draw_id, number) DO NOTHING;
      GET DIAGNOSTICS n = ROW_COUNT;
      reivindicados := reivindicados + n;

      IF reivindicados <> necessarios THEN
        RAISE EXCEPTION 'reivindicacao incompleta' USING ERRCODE = 'P0099';
      END IF;
    EXCEPTION WHEN SQLSTATE 'P0099' THEN
      -- As reivindicacoes acima foram desfeitas. Quais numeros tem outro dono?
      SELECT array_agg(x ORDER BY x) INTO perdidos
        FROM unnest(numeros) AS x
        JOIN public.draw_numbers dn ON dn.draw_id = o.draw_id AND dn.number = x
       WHERE NOT (dn.status = 'RESERVADO' AND dn.expires_at <= now())
         AND dn.order_id IS DISTINCT FROM p_order_id;
      motivo := 'Pagamento aprovado depois de os numeros '
                || COALESCE(array_to_string(perdidos, ', '), '?') || ' terem outro dono.';
    END;
  END IF;

  IF motivo IS NOT NULL THEN
    IF p_payment_id IS NULL THEN
      -- Confirmacao sem pagamento (so em desenvolvimento): nao ha o que estornar.
      RAISE EXCEPTION 'os numeros deste pedido nao estao mais disponiveis' USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.payments
       SET needs_manual_refund = true, refund_reason = motivo
     WHERE id = p_payment_id AND NOT needs_manual_refund;

    -- Evento e auditoria so na PRIMEIRA vez: repetir o aviso nao duplica.
    IF FOUND THEN
      INSERT INTO public.audit_events
        (tenant_id, actor_user_id, actor_type, action, target_type, target_id, after)
      VALUES (o.tenant_id, NULL, 'SYSTEM', 'payment.refund_required', 'order', o.id::text,
              jsonb_build_object('paymentId', p_payment_id, 'numbers', to_jsonb(perdidos)));
      INSERT INTO public.outbox (tenant_id, event_type, payload)
      VALUES (o.tenant_id, 'payment.refund_required', jsonb_build_object(
        'tenantId', o.tenant_id, 'orderId', o.id, 'drawId', o.draw_id,
        'paymentId', p_payment_id, 'amountCents', o.total_cents, 'reason', motivo));
    END IF;
    RETURN 'REFUND_REQUIRED';
  END IF;

  UPDATE public.orders SET status = 'PAGO', paid_at = now() WHERE id = p_order_id;

  INSERT INTO public.audit_events
    (tenant_id, actor_user_id, actor_type, action, target_type, target_id, before, after)
  VALUES (o.tenant_id, NULL, 'SYSTEM', 'order.paid', 'order', o.id::text,
          jsonb_build_object('status', o.status),
          jsonb_build_object('status', 'PAGO', 'via', p_via, 'paymentId', p_payment_id));
  INSERT INTO public.outbox (tenant_id, event_type, payload)
  VALUES (o.tenant_id, 'order.paid', jsonb_build_object(
    'tenantId', o.tenant_id, 'orderId', o.id, 'drawId', o.draw_id,
    'paymentId', p_payment_id, 'quantity', o.quantity, 'totalCents', o.total_cents));

  RETURN 'PAID';
END;
$$;

-- ---------------------------------------------------------------------------
-- apply_psp_payment · aplica o que o PSP DISSE sobre uma cobranca. RN06 · RN07.
--
-- Os argumentos vem de uma CONSULTA a API do provedor, nunca do corpo de um
-- webhook. Idempotente: aplicar de novo o mesmo estado e no-op.
-- Retorna: paid | refund_required | already_processed | pending | closed |
--          refunded | mismatch | unknown_payment
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.apply_psp_payment(
  p_provider             text,
  p_provider_payment_id  text,
  p_status               text,
  p_amount_cents         integer,
  p_external_reference   text,
  p_paid_at              timestamptz,
  p_raw                  jsonb
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

-- ---------------------------------------------------------------------------
-- worker_release_order · devolve os numeros de um pedido vencido a grade.
--
-- "Livre" e ausencia de linha, e o worker nao apaga: o numero volta como
-- RESERVADO ja vencido, que a grade trata como livre e a proxima reserva retoma.
-- Nunca toca em PAGO. So o worker executa.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.worker_release_order(p_order_id uuid, p_reason text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  o public.orders%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'NOT_FOUND';
  END IF;
  IF o.status <> 'PENDENTE' THEN
    RETURN 'NOT_PENDING';
  END IF;

  UPDATE public.draw_numbers
     SET status = 'RESERVADO', expires_at = now() - interval '1 second',
         order_id = NULL, reservation_id = NULL
   WHERE order_id = p_order_id AND status = 'PENDENTE';

  UPDATE public.orders SET status = 'CANCELADO' WHERE id = p_order_id;
  UPDATE public.payments SET status = 'EXPIRADO' WHERE order_id = p_order_id AND status = 'PENDENTE';

  INSERT INTO public.audit_events
    (tenant_id, actor_user_id, actor_type, action, target_type, target_id, before, after)
  VALUES (o.tenant_id, NULL, 'SYSTEM', 'order.expired', 'order', o.id::text,
          jsonb_build_object('status', 'PENDENTE'),
          jsonb_build_object('status', 'CANCELADO', 'reason', p_reason));

  RETURN 'RELEASED';
END;
$$;

-- ---------------------------------------------------------------------------
-- worker_expire_reservations · reserva ATIVA vencida -> EXPIRADA. P8.
--
-- A grade ja tratava o numero vencido como livre pelo relogio; isto faz o STATUS
-- da reserva deixar de mentir. Em lotes, com SKIP LOCKED. Nao toca em numero.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.worker_expire_reservations(p_limit integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  WITH alvo AS (
    SELECT id FROM public.reservations
     WHERE status = 'ATIVA' AND expires_at <= now()
     ORDER BY expires_at
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.reservations r SET status = 'EXPIRADA' FROM alvo WHERE r.id = alvo.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- ---------------------------------------------------------------------------
-- outbox_archive · eventos publicados ha mais de N dias saem da tabela quente.
-- Nunca apaga `audit_events`. Dead-letter NAO e arquivado: precisa de inspecao.
-- ---------------------------------------------------------------------------
CREATE TABLE outbox_archive (
  LIKE outbox INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
ALTER TABLE outbox_archive ENABLE ROW LEVEL SECURITY;
CREATE POLICY outbox_archive_select ON outbox_archive FOR SELECT
  USING (
    (tenant_id IS NOT NULL AND tenant_id = app.current_tenant_id())
    OR app.has_platform_access()
  );
GRANT SELECT ON outbox_archive TO app_user;

CREATE FUNCTION app.worker_archive_outbox(p_days integer DEFAULT 30, p_limit integer DEFAULT 5000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  WITH movidos AS (
    DELETE FROM public.outbox
     WHERE id IN (
       SELECT id FROM public.outbox
        WHERE published_at IS NOT NULL
          AND published_at < now() - make_interval(days => p_days)
        ORDER BY published_at
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
     )
    RETURNING *
  )
  INSERT INTO public.outbox_archive SELECT movidos.*, now() FROM movidos;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- ---------------------------------------------------------------------------
-- job_heartbeats · o ultimo ciclo de cada job (saude do worker).
-- Tabela GLOBAL (sem tenant_id): descreve o processo, nao a comunidade.
-- ---------------------------------------------------------------------------
CREATE TABLE job_heartbeats (
  job_name             text PRIMARY KEY,
  interval_seconds     integer NOT NULL,
  last_started_at      timestamptz,
  last_finished_at     timestamptz,
  last_success_at      timestamptz,
  last_duration_ms     integer,
  last_count           integer,
  last_error           text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_heartbeats_name_not_blank CHECK (btrim(job_name) <> ''),
  CONSTRAINT job_heartbeats_interval_positive CHECK (interval_seconds > 0)
);
ALTER TABLE job_heartbeats ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_heartbeats_select ON job_heartbeats FOR SELECT USING (true);
GRANT SELECT ON job_heartbeats TO app_user, app_worker;

CREATE FUNCTION app.worker_record_job_run(
  p_job      text,
  p_interval integer,
  p_started  timestamptz,
  p_finished timestamptz,
  p_count    integer,
  p_error    text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.job_heartbeats AS h
    (job_name, interval_seconds, last_started_at, last_finished_at, last_success_at,
     last_duration_ms, last_count, last_error, consecutive_failures)
  VALUES
    (p_job, p_interval, p_started, p_finished,
     CASE WHEN p_error IS NULL THEN p_finished END,
     (EXTRACT(EPOCH FROM (p_finished - p_started)) * 1000)::integer,
     p_count, left(p_error, 500), CASE WHEN p_error IS NULL THEN 0 ELSE 1 END)
  ON CONFLICT (job_name) DO UPDATE SET
    interval_seconds     = EXCLUDED.interval_seconds,
    last_started_at      = EXCLUDED.last_started_at,
    last_finished_at     = EXCLUDED.last_finished_at,
    last_success_at      = CASE WHEN p_error IS NULL THEN EXCLUDED.last_finished_at ELSE h.last_success_at END,
    last_duration_ms     = EXCLUDED.last_duration_ms,
    last_count           = EXCLUDED.last_count,
    last_error           = EXCLUDED.last_error,
    consecutive_failures = CASE WHEN p_error IS NULL THEN 0 ELSE h.consecutive_failures + 1 END,
    updated_at           = now();
END;
$$;

-- ---------------------------------------------------------------------------
-- notifications_sent · registro de aviso, com dedupe. NAO envia nada.
--
-- O envio real (WhatsApp, e-mail) e da Fase 8. Aqui so fica o REGISTRO de que um
-- aviso deveria ter saido, uma unica vez: `dedupe_key` e unica.
-- ---------------------------------------------------------------------------
CREATE TABLE notifications_sent (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  draw_id    uuid,
  kind       text NOT NULL,
  dedupe_key text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_sent_draw_fk
    FOREIGN KEY (tenant_id, draw_id) REFERENCES draws (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT notifications_sent_dedupe_key UNIQUE (dedupe_key),
  CONSTRAINT notifications_sent_kind_known CHECK (kind IN (
    'DRAW_REMAINING_THRESHOLD', 'DRAW_SOLD_OUT', 'DRAW_ACTIVATED', 'RESULT_PUBLISHED'
  )),
  CONSTRAINT notifications_sent_payload_no_secrets CHECK (app.assert_no_secrets(payload))
);
CREATE INDEX notifications_sent_tenant_idx ON notifications_sent (tenant_id, created_at DESC);

ALTER TABLE notifications_sent ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_sent_select ON notifications_sent FOR SELECT
  USING (tenant_id = app.current_tenant_id() OR app.has_platform_access());
CREATE POLICY notifications_sent_worker ON notifications_sent FOR ALL TO app_worker
  USING (true) WITH CHECK (true);
GRANT SELECT ON notifications_sent TO app_user;
GRANT SELECT, INSERT ON notifications_sent TO app_worker;

-- ---------------------------------------------------------------------------
-- payment_reconciliation_issues · divergencias PSP x pedidos (conciliacao).
-- ---------------------------------------------------------------------------
CREATE TABLE payment_reconciliation_issues (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  payment_id  uuid NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  order_id    uuid,
  kind        text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT payment_recon_kind_known CHECK (kind IN (
    'APPROVED_ORDER_NOT_PAID',
    'ORDER_PAID_PAYMENT_NOT_APPROVED',
    'PSP_APPROVED_LOCAL_PENDING',
    'MANUAL_REFUND_OPEN'
  ))
);
-- Uma divergencia ABERTA por pagamento e tipo: rodar a conciliacao de novo nao duplica.
CREATE UNIQUE INDEX payment_recon_open_key
  ON payment_reconciliation_issues (payment_id, kind) WHERE resolved_at IS NULL;
CREATE INDEX payment_recon_tenant_idx ON payment_reconciliation_issues (tenant_id, detected_at DESC);

ALTER TABLE payment_reconciliation_issues ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_recon_select ON payment_reconciliation_issues FOR SELECT
  USING (tenant_id = app.current_tenant_id() OR app.has_platform_access());
GRANT SELECT ON payment_reconciliation_issues TO app_user;

CREATE FUNCTION app.worker_record_reconciliation_issue(p_payment_id uuid, p_kind text, p_detail jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  pay public.payments%ROWTYPE;
BEGIN
  SELECT * INTO pay FROM public.payments WHERE id = p_payment_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO public.payment_reconciliation_issues (tenant_id, payment_id, order_id, kind, detail)
  VALUES (pay.tenant_id, pay.id, pay.order_id, p_kind, COALESCE(p_detail, '{}'::jsonb))
  ON CONFLICT (payment_id, kind) WHERE resolved_at IS NULL DO NOTHING;
  RETURN FOUND;
END;
$$;

-- Conciliacao LOCAL: pagamentos x pedidos, sem falar com o PSP. Registra o que
-- diverge e FECHA o que deixou de divergir. Devolve quantas divergencias novas.
CREATE FUNCTION app.worker_reconcile_local(p_since interval DEFAULT interval '7 days')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  novas integer := 0;
  n     integer;
BEGIN
  -- Pagamento APROVADO cujo pedido nao esta PAGO (e nao e o caso de estorno manual).
  INSERT INTO public.payment_reconciliation_issues (tenant_id, payment_id, order_id, kind, detail)
  SELECT p.tenant_id, p.id, p.order_id, 'APPROVED_ORDER_NOT_PAID',
         jsonb_build_object('orderStatus', o.status, 'amountCents', p.amount_cents)
    FROM public.payments p
    JOIN public.orders o ON o.id = p.order_id
   WHERE p.status = 'APROVADO' AND o.status <> 'PAGO' AND NOT p.needs_manual_refund
     AND p.created_at >= now() - p_since
  ON CONFLICT (payment_id, kind) WHERE resolved_at IS NULL DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; novas := novas + n;

  -- Pedido PAGO por um pagamento que NAO esta aprovado.
  INSERT INTO public.payment_reconciliation_issues (tenant_id, payment_id, order_id, kind, detail)
  SELECT p.tenant_id, p.id, p.order_id, 'ORDER_PAID_PAYMENT_NOT_APPROVED',
         jsonb_build_object('paymentStatus', p.status, 'amountCents', p.amount_cents)
    FROM public.payments p
    JOIN public.orders o ON o.id = p.order_id
   WHERE o.status = 'PAGO' AND p.status <> 'APROVADO'
     AND NOT EXISTS (SELECT 1 FROM public.payments q WHERE q.order_id = o.id AND q.status = 'APROVADO')
     AND p.created_at >= now() - p_since
  ON CONFLICT (payment_id, kind) WHERE resolved_at IS NULL DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; novas := novas + n;

  -- Estorno manual em aberto: nao some sozinho.
  INSERT INTO public.payment_reconciliation_issues (tenant_id, payment_id, order_id, kind, detail)
  SELECT p.tenant_id, p.id, p.order_id, 'MANUAL_REFUND_OPEN',
         jsonb_build_object('reason', p.refund_reason, 'amountCents', p.amount_cents)
    FROM public.payments p
   WHERE p.needs_manual_refund AND p.status <> 'ESTORNADO'
  ON CONFLICT (payment_id, kind) WHERE resolved_at IS NULL DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; novas := novas + n;

  -- Fecha o que deixou de divergir.
  UPDATE public.payment_reconciliation_issues i
     SET resolved_at = now()
   WHERE i.resolved_at IS NULL
     AND (
       (i.kind = 'APPROVED_ORDER_NOT_PAID'
         AND EXISTS (SELECT 1 FROM public.orders o WHERE o.id = i.order_id AND o.status = 'PAGO'))
       OR (i.kind = 'ORDER_PAID_PAYMENT_NOT_APPROVED'
         AND EXISTS (SELECT 1 FROM public.payments q WHERE q.order_id = i.order_id AND q.status = 'APROVADO'))
       OR (i.kind = 'PSP_APPROVED_LOCAL_PENDING'
         AND EXISTS (SELECT 1 FROM public.payments q WHERE q.id = i.payment_id AND q.status = 'APROVADO'))
       OR (i.kind = 'MANUAL_REFUND_OPEN'
         AND EXISTS (SELECT 1 FROM public.payments q WHERE q.id = i.payment_id
                        AND (NOT q.needs_manual_refund OR q.status = 'ESTORNADO')))
     );

  RETURN novas;
END;
$$;

-- ---------------------------------------------------------------------------
-- Quem executa o que.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION app.settle_order_paid(uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.apply_psp_payment(text, text, text, integer, text, timestamptz, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.worker_release_order(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.worker_expire_reservations(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.worker_archive_outbox(integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.worker_record_job_run(text, integer, timestamptz, timestamptz, integer, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.worker_record_reconciliation_issue(uuid, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.worker_reconcile_local(interval) FROM PUBLIC;

-- API e worker concluem venda e aplicam o que o PSP disse: MESMA funcao.
GRANT EXECUTE ON FUNCTION app.settle_order_paid(uuid, uuid, text) TO app_user, app_worker;
GRANT EXECUTE ON FUNCTION app.apply_psp_payment(text, text, text, integer, text, timestamptz, jsonb)
  TO app_user, app_worker;

-- So o worker libera pedido, expira reserva, arquiva, registra ciclo e concilia.
GRANT EXECUTE ON FUNCTION app.worker_release_order(uuid, text) TO app_worker;
GRANT EXECUTE ON FUNCTION app.worker_expire_reservations(integer) TO app_worker;
GRANT EXECUTE ON FUNCTION app.worker_archive_outbox(integer, integer) TO app_worker;
GRANT EXECUTE ON FUNCTION app.worker_record_job_run(text, integer, timestamptz, timestamptz, integer, text)
  TO app_worker;
GRANT EXECUTE ON FUNCTION app.worker_record_reconciliation_issue(uuid, text, jsonb) TO app_worker;
GRANT EXECUTE ON FUNCTION app.worker_reconcile_local(interval) TO app_worker;

-- O worker le o que precisa para decidir o que fazer (nao para alterar). `buyers`
-- fica de fora: dado pessoal do comprador nao participa de nenhum job.
GRANT SELECT ON orders, payments, order_items TO app_worker;
CREATE POLICY orders_worker_select ON orders FOR SELECT TO app_worker USING (true);
CREATE POLICY payments_worker_select ON payments FOR SELECT TO app_worker USING (true);
CREATE POLICY order_items_worker_select ON order_items FOR SELECT TO app_worker USING (true);

-- Superficie da Data API.
DO $$
DECLARE
  papel text;
BEGIN
  FOREACH papel IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = papel) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON outbox_archive, job_heartbeats, notifications_sent, payment_reconciliation_issues FROM %I',
        papel);
    END IF;
  END LOOP;
END;
$$;
