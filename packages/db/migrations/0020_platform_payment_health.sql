-- 0020 · Saude operacional dos recebimentos para o Super Admin (Fase 7 · Etapa 5).
--
-- O console precisa saber quantas autorizacoes do Mercado Pago estao com erro ou revogadas,
-- quantas contas estao desconectando e quais pagamentos ficaram sem como ser consultados
-- (`PAYMENT_AUTHORIZATION_UNAVAILABLE`). Os papeis de runtime NAO tem privilegio algum sobre
-- `payment_provider_authorizations` (0019), entao a consulta agregada e uma funcao
-- SECURITY DEFINER: so quem tem acesso de plataforma recebe algo, e o retorno so carrega
-- contagens e referencias curtas — nunca credencial, nunca ID de conta do vendedor.

CREATE FUNCTION app.platform_payment_health(p_limit integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_count integer;
  v_items jsonb;
BEGIN
  IF NOT app.has_platform_access() THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO v_count
    FROM public.payment_reconciliation_issues
   WHERE kind = 'PAYMENT_AUTHORIZATION_UNAVAILABLE' AND resolved_at IS NULL;

  SELECT COALESCE(jsonb_agg(item ORDER BY (item->>'detectedAt')), '[]'::jsonb) INTO v_items
    FROM (
      SELECT jsonb_build_object(
               'id', i.id,
               'tenantName', t.name,
               'tenantSlug', t.slug,
               'reference', left(COALESCE(i.order_id, i.payment_id)::text, 8),
               'detectedAt', i.detected_at
             ) AS item
        FROM public.payment_reconciliation_issues i
        JOIN public.tenants t ON t.id = i.tenant_id
       WHERE i.kind = 'PAYMENT_AUTHORIZATION_UNAVAILABLE' AND i.resolved_at IS NULL
       ORDER BY i.detected_at
       LIMIT v_limit
    ) x;

  RETURN jsonb_build_object(
    'authorizationsError',     (SELECT count(*) FROM public.payment_provider_authorizations WHERE status = 'ERROR'),
    'authorizationsRevoked',   (SELECT count(*) FROM public.payment_provider_authorizations WHERE status = 'REVOKED'),
    'accountsDisconnecting',   (SELECT count(*) FROM public.tenant_payment_accounts WHERE status = 'DISCONNECTING'),
    'unavailableIssuesCount',  v_count,
    'unavailableIssues',       v_items
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION app.platform_payment_health(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.platform_payment_health(integer) TO app_user;

-- ---------------------------------------------------------------------------
-- Estado de cobranca de UMA comunidade, para a consulta de assinaturas do Super Admin.
-- `tenant_billing_state` so responde a quem esta no contexto daquela comunidade; o console
-- atua em nome da plataforma, sem comunidade corrente, e precisa da mesma leitura de negocio
-- (com a tolerancia de `past_due` ja aplicada). Somente leitura; nulo fora da plataforma.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.platform_billing_state(p_tenant uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app.has_platform_access() THEN
    RETURN NULL;
  END IF;
  RETURN app.billing_state_unchecked(p_tenant);
END;
$$;

REVOKE EXECUTE ON FUNCTION app.platform_billing_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.platform_billing_state(uuid) TO app_user;
