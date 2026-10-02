-- 0022 · conteudo da comunidade, imagens e observacoes do Financeiro.
--
-- 1. Marca/paginas da comunidade: colunas novas em tenant_branding (a tabela e da 0003).
-- 2. media_files: imagens enviadas pelo organizador, guardadas no proprio banco ate haver
--    armazenamento de objetos definitivo. Limite de tamanho no CHECK; a API valida o tipo.
-- 3. Observacao/status de revisao nas divergencias da conciliacao (so o Super Admin escreve).
--
-- Nao altera nenhuma migration anterior.

-- ---------------------------------------------------------------------------
-- 1 · tenant_branding
-- ---------------------------------------------------------------------------
ALTER TABLE public.tenant_branding
  ADD COLUMN description text,
  ADD COLUMN footer_text text,
  ADD COLUMN banner_url  text,
  ADD COLUMN pages       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT tenant_branding_pages_object CHECK (jsonb_typeof(pages) = 'object');

-- ---------------------------------------------------------------------------
-- 2 · media_files
-- ---------------------------------------------------------------------------
CREATE TABLE public.media_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  content_type text NOT NULL,
  byte_size    integer NOT NULL,
  data         bytea NOT NULL,
  created_by   uuid REFERENCES public.users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_files_type_known CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT media_files_size_sane CHECK (byte_size > 0 AND byte_size <= 3145728 AND byte_size = octet_length(data))
);
CREATE INDEX media_files_tenant_idx ON public.media_files (tenant_id, created_at DESC);

ALTER TABLE public.media_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY media_files_select ON public.media_files FOR SELECT
  USING (tenant_id = app.current_tenant_id() OR app.has_platform_access());
CREATE POLICY media_files_insert ON public.media_files FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Sem UPDATE e sem DELETE: trocar a imagem e enviar outra.
GRANT SELECT, INSERT ON public.media_files TO app_user;

-- Leitura PUBLICA por id. A imagem aparece em <img>, que nao envia cookie nem
-- cabecalho de comunidade; por isso a leitura passa por uma funcao que devolve so o
-- conteudo e o tipo de UMA imagem pelo identificador (uuid aleatorio), nunca uma lista.
CREATE FUNCTION app.public_media(p_id uuid)
RETURNS TABLE (content_type text, data bytea)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT m.content_type, m.data FROM public.media_files m WHERE m.id = p_id;
$$;
REVOKE EXECUTE ON FUNCTION app.public_media(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.public_media(uuid) TO app_user;

-- ---------------------------------------------------------------------------
-- 3 · conciliacao: observacao e status de revisao
-- ---------------------------------------------------------------------------
ALTER TABLE public.payment_reconciliation_issues
  ADD COLUMN review_status text NOT NULL DEFAULT 'ABERTA',
  ADD COLUMN review_note   text,
  ADD COLUMN reviewed_by   uuid REFERENCES public.users (id),
  ADD COLUMN reviewed_at   timestamptz,
  ADD CONSTRAINT payment_recon_review_status_known
    CHECK (review_status IN ('ABERTA', 'EM_ANALISE', 'RESOLVIDA_MANUALMENTE')),
  ADD CONSTRAINT payment_recon_review_note_len
    CHECK (review_note IS NULL OR char_length(review_note) <= 2000);

-- Somente quem tem acesso de plataforma anota. A funcao confere isso por conta propria:
-- SECURITY DEFINER nao pode confiar no chamador.
CREATE FUNCTION app.platform_review_reconciliation(
  p_issue_id uuid,
  p_status   text,
  p_note     text,
  p_user_id  uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app.has_platform_access() THEN
    RAISE EXCEPTION 'acesso de plataforma exigido' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('ABERTA', 'EM_ANALISE', 'RESOLVIDA_MANUALMENTE') THEN
    RAISE EXCEPTION 'status de revisao invalido' USING ERRCODE = '22023';
  END IF;

  UPDATE public.payment_reconciliation_issues
     SET review_status = p_status,
         review_note   = NULLIF(btrim(COALESCE(p_note, '')), ''),
         reviewed_by   = p_user_id,
         reviewed_at   = now(),
         resolved_at   = CASE WHEN p_status = 'RESOLVIDA_MANUALMENTE' THEN COALESCE(resolved_at, now()) ELSE resolved_at END
   WHERE id = p_issue_id;
  RETURN FOUND;
END;
$$;
REVOKE EXECUTE ON FUNCTION app.platform_review_reconciliation(uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.platform_review_reconciliation(uuid, text, text, uuid) TO app_user;

-- ---------------------------------------------------------------------------
-- 4 · imagens de premio: https OU imagem enviada (`/api/public/media/<uuid>`)
-- ---------------------------------------------------------------------------
ALTER TABLE public.prizes DROP CONSTRAINT prizes_image_https;
ALTER TABLE public.prizes ADD CONSTRAINT prizes_image_ref CHECK (
  image_url IS NULL
  OR image_url ~* '^https://'
  OR image_url ~* '^/api/public/media/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
);

ALTER TABLE public.draws DROP CONSTRAINT draws_prize_image_https;
ALTER TABLE public.draws ADD CONSTRAINT draws_prize_image_ref CHECK (
  prize_image_url IS NULL
  OR prize_image_url ~* '^https://'
  OR prize_image_url ~* '^/api/public/media/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
) NOT VALID;
