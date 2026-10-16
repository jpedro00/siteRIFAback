-- 0032 · Estorno que FALHOU depois de aceito: divergencia de conciliacao REFUND_FAILED.
--
-- Um estorno PIX pode falhar de forma assincrona depois de a Stripe te-lo aceito (p.ex. a conta
-- do comprador foi encerrada). O pagamento ja esta ESTORNADO, que e TERMINAL para a Stripe
-- (apply_psp_payment, 0029): o banco diz "devolvido" e o comprador nao recebeu nada. Nada aqui
-- muda o status nem tenta estornar de novo: so abre a divergencia para o operador.
--
-- Nova migration (e nao edicao da 0015/0019) porque a constraint `payment_recon_kind_known` pode
-- ja estar aplicada no banco de staging. Aditiva: a lista de tipos so ganha um valor.

ALTER TABLE public.payment_reconciliation_issues DROP CONSTRAINT payment_recon_kind_known;
ALTER TABLE public.payment_reconciliation_issues
  ADD CONSTRAINT payment_recon_kind_known CHECK (kind IN (
    'APPROVED_ORDER_NOT_PAID',
    'ORDER_PAID_PAYMENT_NOT_APPROVED',
    'PSP_APPROVED_LOCAL_PENDING',
    'MANUAL_REFUND_OPEN',
    'PAYMENT_AUTHORIZATION_UNAVAILABLE',
    'REFUND_FAILED'
  ));

-- ---------------------------------------------------------------------------
-- record_psp_refund_failed · o webhook Connect RELEU na Stripe (RN06) que um estorno do
-- pagamento falhou. Chamada no contexto da comunidade do pagamento (como apply_psp_payment):
--   'unknown_payment' -> ausente ou de OUTRA comunidade (para quem chama, e a mesma coisa);
--   'mismatch'        -> a consulta foi feita com outra conta que a do pagamento;
--   'opened'          -> divergencia aberta agora (e auditada);
--   'already_open'    -> ja havia uma aberta deste tipo (entrega repetida, outro tipo de evento).
-- `detail` sem dado pessoal: id do estorno, codigo do motivo (`failure_reason`) e valor.
-- O status do pagamento NAO muda; worker_reconcile_local nao fecha este tipo (so o operador).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.record_psp_refund_failed(
  p_provider            text,
  p_provider_payment_id text,
  p_payment_account_id  uuid,
  p_refund_id           text,
  p_failure_reason      text,
  p_amount_cents        integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  pay public.payments%ROWTYPE;
BEGIN
  IF p_refund_id IS NULL OR p_refund_id !~ '^(re|pyr)_[A-Za-z0-9]{1,250}$' THEN
    RAISE EXCEPTION 'identificador de estorno invalido' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO pay
    FROM public.payments
   WHERE provider = p_provider AND provider_payment_id = p_provider_payment_id;

  IF NOT FOUND OR NOT app.caller_can_touch_tenant(pay.tenant_id) THEN
    RETURN 'unknown_payment';
  END IF;

  IF p_payment_account_id IS DISTINCT FROM pay.payment_account_id THEN
    INSERT INTO public.audit_events
      (tenant_id, actor_user_id, actor_type, action, target_type, target_id)
    VALUES (pay.tenant_id, NULL, 'SYSTEM', 'payment.account_mismatch', 'payment', pay.id::text);
    RETURN 'mismatch';
  END IF;

  INSERT INTO public.payment_reconciliation_issues (tenant_id, payment_id, order_id, kind, detail)
  VALUES (pay.tenant_id, pay.id, pay.order_id, 'REFUND_FAILED',
          jsonb_build_object(
            'refundId', p_refund_id,
            'failureReason', CASE WHEN p_failure_reason ~ '^[a-z][a-z0-9_]{0,63}$' THEN p_failure_reason END,
            'amountCents', GREATEST(COALESCE(p_amount_cents, 0), 0)))
  ON CONFLICT (payment_id, kind) WHERE resolved_at IS NULL DO NOTHING;
  IF NOT FOUND THEN
    RETURN 'already_open';
  END IF;

  INSERT INTO public.audit_events
    (tenant_id, actor_user_id, actor_type, action, target_type, target_id)
  VALUES (pay.tenant_id, NULL, 'SYSTEM', 'payment.refund_failed', 'payment', pay.id::text);
  RETURN 'opened';
END;
$$;

REVOKE EXECUTE ON FUNCTION app.record_psp_refund_failed(text, text, uuid, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_psp_refund_failed(text, text, uuid, text, text, integer) TO app_user, app_worker;
