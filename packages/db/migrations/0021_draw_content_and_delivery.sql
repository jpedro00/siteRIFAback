-- =============================================================================
-- 0021 · conteudo do sorteio (assistente de 9 passos) e entrega do premio
--
-- DOC-01 §4 (assistente), §6 (personalizacao), §15 (entrega e arquivamento).
--
-- O QUE ENTRA
--   * draws.subtitle / category / regulation / customization
--       subtitulo, categoria, REGULAMENTO proprio do sorteio (RN02, RN29) e os
--       ajustes de personalizacao que a vitrine realmente honra;
--   * prizes.estimated_value_cents       valor estimado opcional do premio;
--   * draw_deliveries                    registro da ENTREGA do premio (data, forma,
--                                        rastreio, autorizacao de imagem — RN30);
--   * RESULTADO PUBLICADO -> ARQUIVADA   o organizador arquiva, e so com entrega
--                                        registrada.
--
-- O QUE NAO ENTRA (sem infraestrutura, nao se finge comportamento)
--   * upload de imagens (media_assets, variantes, EXIF): depende de armazenamento;
--   * fotos da entrega: mesma dependencia — por isso so se registra se HA autorizacao
--     de imagem; nenhuma foto do ganhador e publicada (RN30 vale por construcao);
--   * cativos/pre-autorizacao: depende da Vindi.
--
-- NADA aqui muda comportamento de sorteio existente: todas as colunas novas sao
-- opcionais e `customization` nasce vazio ('{}' = herda o padrao da plataforma).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- draws · colunas novas
-- ---------------------------------------------------------------------------
ALTER TABLE public.draws
  ADD COLUMN subtitle      text,
  ADD COLUMN category      text,
  ADD COLUMN regulation    text,
  ADD COLUMN customization jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.draws
  ADD CONSTRAINT draws_subtitle_len CHECK (subtitle IS NULL OR char_length(btrim(subtitle)) BETWEEN 1 AND 160),
  ADD CONSTRAINT draws_category_len CHECK (category IS NULL OR char_length(btrim(category)) BETWEEN 1 AND 40),
  ADD CONSTRAINT draws_regulation_len CHECK (regulation IS NULL OR char_length(btrim(regulation)) BETWEEN 1 AND 20000),
  -- Objeto pequeno: a forma exata e conferida pela API (zod); o banco so impede lixo grande.
  ADD CONSTRAINT draws_customization_object CHECK (
    jsonb_typeof(customization) = 'object' AND pg_column_size(customization) <= 4096
  );

-- ---------------------------------------------------------------------------
-- prizes · valor estimado
-- ---------------------------------------------------------------------------
ALTER TABLE public.prizes
  ADD COLUMN estimated_value_cents integer,
  ADD CONSTRAINT prizes_estimated_value_range CHECK (
    estimated_value_cents IS NULL OR estimated_value_cents BETWEEN 0 AND 2000000000
  );

-- ---------------------------------------------------------------------------
-- draw_deliveries · entrega do premio (DOC-01 §15)
-- ---------------------------------------------------------------------------
CREATE TABLE public.draw_deliveries (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  draw_id                 uuid NOT NULL,
  method                  text NOT NULL,
  tracking_code           text,
  delivered_at            timestamptz NOT NULL,
  notes                   text,
  -- RN30: a foto do ganhador so seria publicada COM autorizacao anexada. Sem
  -- armazenamento de midia nao ha foto; o registro guarda se a autorizacao existe.
  winner_image_authorized boolean NOT NULL DEFAULT false,
  recorded_by             uuid REFERENCES public.users (id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT draw_deliveries_draw_fk FOREIGN KEY (tenant_id, draw_id)
    REFERENCES public.draws (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT draw_deliveries_one_per_draw UNIQUE (draw_id),
  CONSTRAINT draw_deliveries_method_known CHECK (method IN ('RETIRADA', 'ENVIO', 'TRANSFERENCIA')),
  CONSTRAINT draw_deliveries_tracking_len CHECK (tracking_code IS NULL OR char_length(btrim(tracking_code)) BETWEEN 1 AND 100),
  CONSTRAINT draw_deliveries_notes_len CHECK (notes IS NULL OR char_length(notes) <= 1000)
);
CREATE INDEX draw_deliveries_tenant_idx ON public.draw_deliveries (tenant_id, draw_id);

CREATE TRIGGER draw_deliveries_touch_updated_at
  BEFORE UPDATE ON public.draw_deliveries
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- A entrega so se registra (e so se corrige) com o resultado PUBLICADO. Depois de
-- ARQUIVADA tudo e somente leitura; antes, nao ha ganhador a quem entregar.
CREATE FUNCTION app.draw_deliveries_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  estado public.draw_status;
BEGIN
  SELECT status INTO estado FROM public.draws WHERE id = NEW.draw_id;
  IF estado IS DISTINCT FROM 'RESULTADO PUBLICADO' THEN
    RAISE EXCEPTION 'a entrega so se registra com o resultado publicado (sorteio em %)', estado
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION app.draw_deliveries_guard() FROM PUBLIC;
CREATE TRIGGER draw_deliveries_guard
  BEFORE INSERT OR UPDATE ON public.draw_deliveries
  FOR EACH ROW EXECUTE FUNCTION app.draw_deliveries_guard();

ALTER TABLE public.draw_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY draw_deliveries_select ON public.draw_deliveries FOR SELECT
  USING (tenant_id = app.current_tenant_id() OR app.has_platform_access());
CREATE POLICY draw_deliveries_insert ON public.draw_deliveries FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY draw_deliveries_update ON public.draw_deliveries FOR UPDATE
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

GRANT SELECT, INSERT ON public.draw_deliveries TO app_user;
-- Corrigir uma entrega nao muda a quem pertence nem o sorteio.
GRANT UPDATE (method, tracking_code, delivered_at, notes, winner_image_authorized, recorded_by)
  ON public.draw_deliveries TO app_user;
GRANT SELECT ON public.draw_deliveries TO app_worker;

-- ---------------------------------------------------------------------------
-- Arquivar: RESULTADO PUBLICADO -> ARQUIVADA pelo organizador, SO com entrega.
-- ---------------------------------------------------------------------------
INSERT INTO public.draw_status_transitions (from_status, to_status, actor)
VALUES ('RESULTADO PUBLICADO', 'ARQUIVADA', 'ORGANIZER');

CREATE FUNCTION app.draws_archive_needs_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'ARQUIVADA' AND OLD.status IS DISTINCT FROM 'ARQUIVADA' THEN
    IF NOT EXISTS (SELECT 1 FROM public.draw_deliveries WHERE draw_id = NEW.id) THEN
      RAISE EXCEPTION 'registre a entrega do premio antes de arquivar o sorteio'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION app.draws_archive_needs_delivery() FROM PUBLIC;
-- Depois do guarda de estado (draws_05_*) e antes dos de grade/preco (draws_10_*).
CREATE TRIGGER draws_07_archive_needs_delivery
  BEFORE UPDATE OF status ON public.draws
  FOR EACH ROW EXECUTE FUNCTION app.draws_archive_needs_delivery();
