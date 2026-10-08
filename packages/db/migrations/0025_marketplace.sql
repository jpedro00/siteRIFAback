-- 0025 · marketplace universal (leitura publica entre comunidades).
--
-- O isolamento por comunidade (RLS) NAO muda. O marketplace precisa listar rifas de varias
-- comunidades sem sessao e sem tenant resolvido, e `app_user` nao le tabelas de negocio
-- fora do contexto de uma comunidade. Em vez de abrir SELECT global ou dar BYPASSRLS, ha duas
-- funcoes SECURITY DEFINER com search_path fixo e PROJECAO MINIMA:
--
--   * `app.marketplace_page`      -> so identificadores e ordem de paginacao (nunca dado de
--                                    comprador, pedido, pagamento ou contato);
--   * `app.marketplace_creators`  -> so nome, logo, descricao e contagem de rifas publicas.
--
-- Os detalhes de cada rifa sao lidos depois, POR COMUNIDADE, dentro do contexto da propria
-- comunidade (RLS normal), pelo mesmo codigo da vitrine por comunidade.
--
-- Publico = comunidade ACTIVE + rifa num dos estados que a vitrine ja mostra
-- (ATIVA, PAUSADA, VENDAS ENCERRADAS, APURACAO, RESULTADO PUBLICADO). Rascunho, revisao,
-- agendada, arquivada e cancelada nunca saem daqui.
--
-- Nao altera nenhuma migration anterior.

-- Apoio a ordem da listagem global (faixa -> mais recentes).
CREATE INDEX IF NOT EXISTS draws_marketplace_idx
  ON public.draws (created_at DESC, id DESC)
  WHERE status IN ('ATIVA', 'PAUSADA', 'VENDAS ENCERRADAS', 'APURAÇÃO', 'RESULTADO PUBLICADO');

CREATE FUNCTION app.marketplace_page(
  p_search      text,
  p_tenant_slug text,
  p_band        integer,
  p_created_t   text,
  p_id          uuid,
  p_limit       integer
)
RETURNS TABLE (
  tenant_id   uuid,
  tenant_slug text,
  tenant_name text,
  logo_url    text,
  draw_id     uuid,
  band        integer,
  cursor_t    text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT t.id, t.slug, COALESCE(NULLIF(btrim(b.public_name), ''), t.name), b.logo_light_url,
         d.id,
         CASE WHEN d.status = 'ATIVA' THEN 0 ELSE 1 END,
         d.created_at::text
    FROM public.draws d
    JOIN public.tenants t ON t.id = d.tenant_id AND t.status = 'ACTIVE'
    LEFT JOIN public.tenant_branding b ON b.tenant_id = t.id
   WHERE d.status IN ('ATIVA', 'PAUSADA', 'VENDAS ENCERRADAS', 'APURAÇÃO', 'RESULTADO PUBLICADO')
     AND (p_tenant_slug IS NULL OR t.slug = p_tenant_slug)
     AND (
       p_search IS NULL OR p_search = ''
       OR d.title ILIKE '%' || p_search || '%' ESCAPE '\'
       OR d.prize_name ILIKE '%' || p_search || '%' ESCAPE '\'
       OR t.name ILIKE '%' || p_search || '%' ESCAPE '\'
       OR b.public_name ILIKE '%' || p_search || '%' ESCAPE '\'
     )
     AND (
       p_band IS NULL
       OR (CASE WHEN d.status = 'ATIVA' THEN 0 ELSE 1 END) > p_band
       OR ((CASE WHEN d.status = 'ATIVA' THEN 0 ELSE 1 END) = p_band
           AND (d.created_at, d.id) < (p_created_t::timestamptz, p_id))
     )
   ORDER BY 6, d.created_at DESC, d.id DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 24), 1), 61);
$$;

CREATE FUNCTION app.marketplace_creators(
  p_search     text,
  p_after_name text,
  p_after_slug text,
  p_limit      integer
)
RETURNS TABLE (
  tenant_slug  text,
  display_name text,
  logo_url     text,
  description  text,
  public_draws integer,
  active_draws integer
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT x.slug, x.display_name, x.logo_url, x.description, x.public_draws, x.active_draws
    FROM (
      SELECT t.slug,
             COALESCE(NULLIF(btrim(b.public_name), ''), t.name) AS display_name,
             b.logo_light_url AS logo_url,
             b.description,
             count(d.id)::int AS public_draws,
             (count(d.id) FILTER (WHERE d.status = 'ATIVA'))::int AS active_draws
        FROM public.tenants t
        LEFT JOIN public.tenant_branding b ON b.tenant_id = t.id
        JOIN public.draws d ON d.tenant_id = t.id
         AND d.status IN ('ATIVA', 'PAUSADA', 'VENDAS ENCERRADAS', 'APURAÇÃO', 'RESULTADO PUBLICADO')
       WHERE t.status = 'ACTIVE'
         AND (
           p_search IS NULL OR p_search = ''
           OR t.name ILIKE '%' || p_search || '%' ESCAPE '\'
           OR b.public_name ILIKE '%' || p_search || '%' ESCAPE '\'
         )
       GROUP BY t.slug, t.name, b.public_name, b.logo_light_url, b.description
    ) x
   WHERE p_after_name IS NULL OR (x.display_name, x.slug) > (p_after_name, p_after_slug)
   ORDER BY x.display_name, x.slug
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 24), 1), 61);
$$;

REVOKE EXECUTE ON FUNCTION app.marketplace_page(text, text, integer, text, uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.marketplace_creators(text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.marketplace_page(text, text, integer, text, uuid, integer) TO app_user;
GRANT EXECUTE ON FUNCTION app.marketplace_creators(text, text, text, integer) TO app_user;
