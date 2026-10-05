-- ============================================================================
-- 0012 · Sorteio alinhado ao DOC-01 §18: preco, promocao, grade, cronograma,
--        apuracao e premios
-- ----------------------------------------------------------------------------
-- O QUE MUDA
--   * `draws` ganha as colunas que o DOC-01 §18 nomeia e a 0010 nao tinha.
--   * `ticket_price_cents` passa a ser o preco base. `unit_price_cents` FICA
--     por ora, espelhada, para que a versao anterior da API continue gravando
--     e lendo enquanto o deploy troca de uma para a outra; sai numa migration
--     posterior, com o codigo ja limpo.
--   * `prizes` (um ou mais premios por sorteio) substitui o premio unico em
--     `prize_name`/`prize_image_url`, que tambem ficam ate a limpeza.
--
-- O QUE NAO MUDA
--   * A 0001–0011 sao imutaveis. Os enums `draw_status` e `draw_number_status`
--     ficam como estao, com acentos e espacos.
--   * `total_numbers` continua sendo a coluna que o codigo le; `number_count`
--     e `label_digits` sao GERADAS a partir dela. Uma coluna gerada nao pode
--     divergir — e RN13 (rotulos 00–99 / 000–499 / 000–999) deixa de depender
--     de o chamador lembrar de gravar o valor certo.
--
-- IMAGEM (Suposicao temporaria S-IMG1): sem armazenamento de midia nesta fase,
-- o link do premio e uma URL https. `media_assets` (upload por URL assinada e
-- worker de processamento) fica para quando o armazenamento for escolhido.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Modo de fechamento das vendas. DOC-01 §4 passo 5.
-- ---------------------------------------------------------------------------
CREATE TYPE draw_close_mode AS ENUM (
  'POR_DATA',              -- fecha em `close_at`
  'AO_ESGOTAR',            -- fecha quando o ultimo numero for pago
  'O_QUE_VIER_PRIMEIRO'    -- fecha no que acontecer antes
);

-- Limiares de aviso ("faltam X"): 1 a 5 valores entre 1 e 99, em ordem
-- ESTRITAMENTE decrescente. O padrao {25,10} e constante protegida.
CREATE FUNCTION app.thresholds_valid(t integer[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT t IS NOT NULL
     AND cardinality(t) BETWEEN 1 AND 5
     AND NOT EXISTS (
       SELECT 1
         FROM generate_subscripts(t, 1) AS i
        WHERE t[i] < 1
           OR t[i] > 99
           OR (i > 1 AND t[i] >= t[i - 1])
     );
$$;

-- ---------------------------------------------------------------------------
-- draws · colunas novas
-- ---------------------------------------------------------------------------
ALTER TABLE draws
  ADD COLUMN ticket_price_cents      integer,
  ADD COLUMN promotional_price_cents integer,
  ADD COLUMN promo_until             timestamptz,
  -- Geradas: iguais a total_numbers e ao rotulo de RN13 POR CONSTRUCAO.
  ADD COLUMN number_count            integer
    GENERATED ALWAYS AS (total_numbers) STORED,
  ADD COLUMN label_digits            smallint
    GENERATED ALWAYS AS (CASE WHEN total_numbers = 100 THEN 2 ELSE 3 END) STORED,
  ADD COLUMN sales_start_at          timestamptz,
  -- Suposicao S-E1: sem escolha explicita, vende ate esgotar.
  ADD COLUMN close_mode              draw_close_mode NOT NULL DEFAULT 'AO_ESGOTAR',
  ADD COLUMN close_at                timestamptz,
  ADD COLUMN result_source           text NOT NULL DEFAULT 'LOTERIA_FEDERAL',
  ADD COLUMN thresholds              integer[] NOT NULL DEFAULT '{25,10}',
  -- Motivo da ultima reprovacao na revisao; o organizador precisa le-lo para
  -- saber o que corrigir. Nao e trilha de auditoria (essa continua so-insercao).
  ADD COLUMN review_note             text,
  ADD COLUMN reviewed_at             timestamptz;

-- Preco: copia sem perda.
UPDATE draws SET ticket_price_cents = unit_price_cents;
ALTER TABLE draws ALTER COLUMN ticket_price_cents SET NOT NULL;

ALTER TABLE draws
  ADD CONSTRAINT draws_ticket_price_positive CHECK (ticket_price_cents > 0),
  -- Promocional MENOR que o cheio (e positivo), e sempre acompanhado do prazo.
  ADD CONSTRAINT draws_promo_below_ticket CHECK (
    promotional_price_cents IS NULL
    OR (promotional_price_cents > 0 AND promotional_price_cents < ticket_price_cents)
  ),
  ADD CONSTRAINT draws_promo_pair CHECK (
    (promotional_price_cents IS NULL) = (promo_until IS NULL)
  ),
  ADD CONSTRAINT draws_label_digits_valid CHECK (label_digits IN (2, 3)),
  ADD CONSTRAINT draws_close_before_draw CHECK (
    close_at IS NULL OR draw_date IS NULL OR close_at < draw_date
  ),
  ADD CONSTRAINT draws_sales_start_before_close CHECK (
    sales_start_at IS NULL OR close_at IS NULL OR sales_start_at < close_at
  ),
  ADD CONSTRAINT draws_result_source_known CHECK (result_source IN ('LOTERIA_FEDERAL')),
  ADD CONSTRAINT draws_thresholds_valid CHECK (app.thresholds_valid(thresholds)),
  -- Linhas antigas nao sao reescritas; toda linha NOVA precisa de https.
  ADD CONSTRAINT draws_prize_image_https CHECK (
    prize_image_url IS NULL OR prize_image_url ~* '^https://'
  ) NOT VALID;

-- `close_mode <> AO_ESGOTAR` exige `close_at`, mas isso e checado no ENVIO PARA
-- REVISAO, nao aqui: o rascunho e salvo a cada passo do assistente, e uma CHECK
-- impediria gravar o modo antes da data.

-- ---------------------------------------------------------------------------
-- O preco fica TRAVADO NA RESERVA.
--
-- Com promocao com prazo, o preco efetivo pode mudar entre "reservei" e "fechei
-- o pedido": reservar a R$ 8 (promocional) e pagar a R$ 10 porque a promocao
-- venceu no meio dos 30 minutos seria trocar o valor que a pessoa viu. A reserva
-- guarda o preco praticado no instante em que segurou os numeros, e o pedido o
-- copia dela. NULA = reserva anterior a esta migration; o pedido cai no preco
-- efetivo do momento.
-- ---------------------------------------------------------------------------
ALTER TABLE reservations ADD COLUMN unit_price_cents integer;
ALTER TABLE reservations
  ADD CONSTRAINT reservations_unit_price_positive
  CHECK (unit_price_cents IS NULL OR unit_price_cents > 0);
UPDATE reservations r
   SET unit_price_cents = d.ticket_price_cents
  FROM draws d
 WHERE d.id = r.draw_id;

-- ---------------------------------------------------------------------------
-- Espelho do preco legado. Enquanto `unit_price_cents` existir, as duas colunas
-- nao podem divergir — nem para a API nova (que so escreve `ticket_price_cents`)
-- nem para a anterior (que so escreve `unit_price_cents`).
--
-- O prefixo `00` faz este gatilho rodar ANTES dos demais (ordem alfabetica).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.draws_sync_legacy_price()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.ticket_price_cents := COALESCE(NEW.ticket_price_cents, NEW.unit_price_cents);
    NEW.unit_price_cents := NEW.ticket_price_cents;
  ELSIF NEW.ticket_price_cents IS DISTINCT FROM OLD.ticket_price_cents THEN
    NEW.unit_price_cents := NEW.ticket_price_cents;
  ELSIF NEW.unit_price_cents IS DISTINCT FROM OLD.unit_price_cents THEN
    NEW.ticket_price_cents := NEW.unit_price_cents;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER draws_00_sync_legacy_price
  BEFORE INSERT OR UPDATE ON draws
  FOR EACH ROW EXECUTE FUNCTION app.draws_sync_legacy_price();

-- ---------------------------------------------------------------------------
-- RN14 · a grade e o preco base nao mudam depois da primeira reserva.
--
-- Trocar 100 por 1000 numeros com gente ja segurando o numero 57 invalida a
-- reserva; trocar o preco muda o que "reservei por R$ 15" significa. A trava e
-- do BANCO, para valer inclusive para quem nao passa pela API.
--
-- SECURITY DEFINER: precisa ver reservas independentemente da RLS do chamador.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.draws_protect_grid_and_price()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.total_numbers IS DISTINCT FROM OLD.total_numbers
     OR NEW.ticket_price_cents IS DISTINCT FROM OLD.ticket_price_cents THEN
    IF EXISTS (SELECT 1 FROM public.reservations WHERE draw_id = OLD.id) THEN
      RAISE EXCEPTION
        'RN14: a grade e o preco base nao mudam depois da primeira reserva (sorteio %).', OLD.id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION app.draws_protect_grid_and_price() FROM PUBLIC;

CREATE TRIGGER draws_10_protect_grid_and_price
  BEFORE UPDATE ON draws
  FOR EACH ROW EXECUTE FUNCTION app.draws_protect_grid_and_price();

-- ---------------------------------------------------------------------------
-- prizes · um ou mais premios por sorteio. DOC-01 §4 passo 2.
-- ---------------------------------------------------------------------------
CREATE TABLE prizes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  draw_id     uuid NOT NULL,
  position    smallint NOT NULL,
  name        text NOT NULL,
  description text,
  image_url   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT prizes_position_range CHECK (position BETWEEN 1 AND 20),
  CONSTRAINT prizes_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT prizes_image_https CHECK (image_url IS NULL OR image_url ~* '^https://'),
  -- FK composta: um premio da comunidade A nao aponta para sorteio de B.
  CONSTRAINT prizes_draw_fk FOREIGN KEY (tenant_id, draw_id)
    REFERENCES draws (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT prizes_draw_position_key UNIQUE (draw_id, position)
);

CREATE INDEX prizes_tenant_draw_idx ON prizes (tenant_id, draw_id, position);

CREATE TRIGGER prizes_touch_updated_at
  BEFORE UPDATE ON prizes
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Todo sorteio existente ganha o premio da posicao 1, a partir do premio unico.
-- Um link `http://` legado nao entra (a CHECK exige https): ele continua na
-- coluna antiga e o organizador reenvia o link.
INSERT INTO prizes (tenant_id, draw_id, position, name, description, image_url)
SELECT tenant_id,
       id,
       1,
       prize_name,
       prize_description,
       CASE WHEN prize_image_url ~* '^https://' THEN prize_image_url ELSE NULL END
  FROM draws;

-- Criado DEPOIS da copia acima: o gatilho barra premio fora de RASCUNHO, e a
-- migracao precisa preencher sorteios em qualquer estado.
CREATE FUNCTION app.prizes_only_in_draft()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  alvo   uuid := COALESCE(NEW.draw_id, OLD.draw_id);
  estado draw_status;
BEGIN
  SELECT status INTO estado FROM public.draws WHERE id = alvo;
  -- Sorteio ausente: e o CASCADE de uma remocao de comunidade; nada a barrar.
  IF estado IS NOT NULL AND estado <> 'RASCUNHO' THEN
    RAISE EXCEPTION
      'O premio so muda com o sorteio em RASCUNHO (sorteio % esta em %).', alvo, estado
      USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE EXECUTE ON FUNCTION app.prizes_only_in_draft() FROM PUBLIC;

CREATE TRIGGER prizes_only_in_draft
  BEFORE INSERT OR UPDATE OR DELETE ON prizes
  FOR EACH ROW EXECUTE FUNCTION app.prizes_only_in_draft();

-- ---------------------------------------------------------------------------
-- RLS · mesmo criterio de 0010
-- ---------------------------------------------------------------------------
ALTER TABLE prizes ENABLE ROW LEVEL SECURITY;

CREATE POLICY prizes_select ON prizes FOR SELECT
  USING (tenant_id = app.current_tenant_id() OR app.has_platform_access());
CREATE POLICY prizes_insert ON prizes FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY prizes_update ON prizes FOR UPDATE
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY prizes_delete ON prizes FOR DELETE
  USING (tenant_id = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON prizes TO app_user;
GRANT SELECT ON prizes TO app_worker;
CREATE POLICY prizes_worker_select ON prizes FOR SELECT TO app_worker USING (true);

-- Superficie da Data API (mesmo cinto e suspensorio da 0010).
DO $$
DECLARE
  papel text;
BEGIN
  FOREACH papel IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = papel) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON prizes FROM %I', papel);
    END IF;
  END LOOP;
END;
$$;
