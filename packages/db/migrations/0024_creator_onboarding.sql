-- 0024 · onboarding self-service de criadores.
--
-- Nao existe segunda tabela de login: "virar criador" e criar uma comunidade e receber o
-- vinculo OWNER sobre a MESMA conta global. Hoje so o Super Admin cria comunidade (a policy
-- de INSERT em `tenants` exige acesso de plataforma). Esta funcao abre um caminho ESTREITO
-- para o proprio usuario, sem abrir a tabela:
--   * so cria para o usuario informado, que precisa estar ACTIVE (a API passa o da SESSAO);
--   * o vinculo e sempre OWNER do PROPRIO usuario — nao atribui a ninguem mais;
--   * tenant + vinculo + marca inicial + auditoria + evento de outbox, na MESMA transacao;
--   * idempotente: repetir o pedido de quem ja e dono do slug devolve a comunidade existente;
--   * limite de comunidades por criador (parametro), contra criacao em massa.
--
-- Nao altera nenhuma migration anterior.

CREATE FUNCTION app.create_own_community(
  p_user_id   uuid,
  p_slug      text,
  p_name      text,
  p_contact   jsonb,
  p_max_owned integer
)
RETURNS TABLE (tenant_id uuid, slug text, name text, status text, created_at timestamptz, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  usr   public.users%ROWTYPE;
  ten   public.tenants%ROWTYPE;
  owned integer;
BEGIN
  SELECT * INTO usr FROM public.users u WHERE u.id = p_user_id;
  IF NOT FOUND OR usr.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'conta inativa ou inexistente' USING ERRCODE = '42501';
  END IF;
  IF p_contact IS NULL OR jsonb_typeof(p_contact) <> 'object' THEN
    RAISE EXCEPTION 'contato invalido' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO ten FROM public.tenants t WHERE t.slug = p_slug;
  IF FOUND THEN
    -- Repeticao do mesmo pedido (duplo clique, retry de rede): quem ja e dono recebe o que ja existe.
    IF EXISTS (
      SELECT 1 FROM public.memberships m
       WHERE m.tenant_id = ten.id AND m.user_id = p_user_id AND m.role = 'OWNER' AND m.revoked_at IS NULL
    ) THEN
      RETURN QUERY SELECT ten.id, ten.slug, ten.name, ten.status::text, ten.created_at, false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'identificador de comunidade ja em uso' USING ERRCODE = '23505', CONSTRAINT = 'tenants_slug_key';
  END IF;

  SELECT count(*) INTO owned
    FROM public.memberships m
   WHERE m.user_id = p_user_id AND m.role = 'OWNER' AND m.revoked_at IS NULL;
  IF owned >= p_max_owned THEN
    RAISE EXCEPTION 'limite de comunidades por criador atingido' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    INSERT INTO public.tenants (slug, name) VALUES (p_slug, btrim(p_name)) RETURNING * INTO ten;
  EXCEPTION WHEN unique_violation THEN
    -- Duplo clique CONCORRENTE: a outra transacao venceu a corrida e ja confirmou. Quem e dono
    -- do slug recebe a comunidade existente; qualquer outro, conflito.
    SELECT * INTO ten FROM public.tenants t WHERE t.slug = p_slug;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.memberships m
       WHERE m.tenant_id = ten.id AND m.user_id = p_user_id AND m.role = 'OWNER' AND m.revoked_at IS NULL
    ) THEN
      RETURN QUERY SELECT ten.id, ten.slug, ten.name, ten.status::text, ten.created_at, false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'identificador de comunidade ja em uso' USING ERRCODE = '23505', CONSTRAINT = 'tenants_slug_key';
  END;

  INSERT INTO public.memberships (tenant_id, user_id, role, accepted_at, created_by)
  VALUES (ten.id, p_user_id, 'OWNER', now(), p_user_id);

  -- A marca inicial ja nasce com o nome e o contato informados; o consumidor do evento abaixo
  -- usa ON CONFLICT DO NOTHING e nao sobrescreve.
  INSERT INTO public.tenant_branding (tenant_id, public_name, contact)
  VALUES (ten.id, btrim(p_name), p_contact);

  INSERT INTO public.audit_events (tenant_id, actor_user_id, actor_type, action, target_type, target_id, after)
  VALUES (NULL, p_user_id, 'USER', 'tenant.created_self_service', 'tenant', ten.id::text,
          jsonb_build_object('slug', ten.slug, 'name', ten.name, 'role', 'OWNER'));

  INSERT INTO public.outbox (tenant_id, event_type, payload)
  VALUES (NULL, 'tenant.created',
          jsonb_build_object('tenantId', ten.id, 'slug', ten.slug, 'name', ten.name,
                             'createdByUserId', p_user_id, 'selfService', true));

  RETURN QUERY SELECT ten.id, ten.slug, ten.name, ten.status::text, ten.created_at, true;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.create_own_community(uuid, text, text, jsonb, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_own_community(uuid, text, text, jsonb, integer) TO app_user;
