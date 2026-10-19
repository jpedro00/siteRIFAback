-- 0031 · Obrigacoes abertas da conta: pagamento ja ESTORNADO nao prende mais a desconexao.
-- O estorno automatico da Stripe nao desliga `needs_manual_refund`; contado como obrigacao, o
-- pagamento estornado deixava a conta presa em DISCONNECTING para sempre. Nova migration (e nao
-- edicao da 0019) porque a 0019 pode ja estar aplicada no banco de staging.
-- CREATE OR REPLACE: mesma assinatura, linguagem, SECURITY DEFINER, search_path e STABLE da 0019.

-- Pagamentos que AINDA dependem da credencial da conta: pendentes, com devolucao manual em
-- aberto (e ainda nao estornados), ou recem-encerrados (a conciliacao ainda pode descobrir um
-- pagamento tardio).
CREATE OR REPLACE FUNCTION app.payment_account_open_obligations(p_account uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::integer FROM public.payments p
   WHERE p.payment_account_id = p_account
     AND (p.status = 'PENDENTE'
          OR (p.needs_manual_refund AND p.status <> 'ESTORNADO')
          OR (p.status IN ('EXPIRADO', 'CANCELADO') AND p.created_at > now() - interval '3 days'));
$$;

-- Privilegios identicos aos da 0019 (o CREATE OR REPLACE ja os preserva; reafirmados por seguranca):
-- funcao interna, nada e publico e nao ha GRANT.
REVOKE EXECUTE ON FUNCTION app.payment_account_open_obligations(uuid) FROM PUBLIC;
