-- ============================================================================
-- 0016 · Convites (equipe e dono da comunidade) e consentimento de mensagens
-- ----------------------------------------------------------------------------
-- CONVITES
--   Nao ha envio de e-mail nesta fase: o convite gera um TOKEN que quem convida
--   entrega por fora. So o HASH do token vai para o banco — quem ler a tabela nao
--   consegue aceitar convite alheio. Validade: 7 dias (Suposicao S-CONV1).
--
--   O convidado ainda NAO e membro, entao a RLS por comunidade nao o deixa ver o
--   convite. Ver e aceitar passam por funcoes SECURITY DEFINER que exigem o TOKEN
--   e, para aceitar, uma sessao cujo e-mail e o do convite.
--
-- CONSENTIMENTO
--   O aceite do regulamento (`accepted_terms_at`) e o consentimento para receber
--   mensagens sao DUAS decisoes. Juntar as duas num unico "aceito" tornaria o
--   consentimento de mensagem uma condicao para comprar — e nao pode ser.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- invitations
-- ---------------------------------------------------------------------------
CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  email       text NOT NULL,
  role        membership_role NOT NULL,
  -- SHA-256 hex do token. O token em si nunca e gravado.
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users (id) ON DELETE SET NULL,
  revoked_at  timestamptz,
  invited_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT invitations_email_lowercase CHECK (email = lower(btrim(email)) AND email <> ''),
  CONSTRAINT invitations_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT invitations_state_exclusive CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);

CREATE UNIQUE INDEX invitations_token_hash_key ON invitations (token_hash);
-- Um convite EM ABERTO por e-mail e comunidade. Reenviar revoga o anterior.
CREATE UNIQUE INDEX invitations_open_key
  ON invitations (tenant_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX invitations_tenant_idx ON invitations (tenant_id, created_at DESC);

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY invitations_select ON invitations FOR SELECT
  USING (tenant_id = app.current_tenant_id() OR app.has_platform_access());
CREATE POLICY invitations_insert ON invitations FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() OR app.has_platform_access());
CREATE POLICY invitations_update ON invitations FOR UPDATE
  USING (tenant_id = app.current_tenant_id() OR app.has_platform_access())
  WITH CHECK (tenant_id = app.current_tenant_id() OR app.has_platform_access());
-- Sem policy de DELETE: convite se revoga.

GRANT SELECT, INSERT ON invitations TO app_user;
GRANT UPDATE (revoked_at) ON invitations TO app_user;

-- ---------------------------------------------------------------------------
-- Ver o convite pelo TOKEN (tela de aceite; ainda nao ha sessao nem vinculo).
-- Projecao minima: nao devolve o e-mail inteiro nem o id da comunidade.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.invitation_preview(p_token_hash text)
RETURNS TABLE (
  tenant_name  text,
  role         public.membership_role,
  email_masked text,
  expires_at   timestamptz,
  state        text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.name,
         i.role,
         left(i.email, 1) || '***' || substr(i.email, strpos(i.email, '@')),
         i.expires_at,
         CASE
           WHEN i.accepted_at IS NOT NULL THEN 'ACCEPTED'
           WHEN i.revoked_at  IS NOT NULL THEN 'REVOKED'
           WHEN i.expires_at  <= now()    THEN 'EXPIRED'
           ELSE 'OPEN'
         END
    FROM public.invitations i
    JOIN public.tenants t ON t.id = i.tenant_id
   WHERE i.token_hash = p_token_hash;
$$;

-- ---------------------------------------------------------------------------
-- Aceitar o convite. Exige SESSAO (`app.current_user_id()`) cujo e-mail e o do
-- convite: o token sozinho nao basta, senao quem o interceptasse viraria membro.
--
-- Cria o vinculo, fecha o convite, audita e publica `membership.granted` na mesma
-- transacao. Devolve a comunidade e o papel.
--
-- As colunas de saida levam o prefixo `out_`: com o mesmo nome das colunas de
-- `memberships` (`tenant_id`, `role`), o PL/pgSQL acusaria referencia ambigua.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.accept_invitation(p_token_hash text)
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

REVOKE EXECUTE ON FUNCTION app.invitation_preview(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.accept_invitation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.invitation_preview(text) TO app_user;
GRANT EXECUTE ON FUNCTION app.accept_invitation(text) TO app_user;

-- ---------------------------------------------------------------------------
-- Consentimento de mensagens, separado do aceite do regulamento.
-- ---------------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN messaging_consent_at timestamptz;
COMMENT ON COLUMN orders.messaging_consent_at IS
  'Quando o comprador consentiu em receber mensagens sobre este pedido. Nulo = nao '
  'consentiu. Independe de accepted_terms_at: o consentimento nao e condicao da compra.';

-- Superficie da Data API.
DO $$
DECLARE
  papel text;
BEGIN
  FOREACH papel IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = papel) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON invitations FROM %I', papel);
    END IF;
  END LOOP;
END;
$$;
