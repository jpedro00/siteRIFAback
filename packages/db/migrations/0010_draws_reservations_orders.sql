-- ============================================================================
-- 0010 · Sorteios, numeros, reservas e pedidos
--
-- Modulo: M02 (sorteio e grade) · M03 (reserva) · M04 (pedido)
-- Regras: RN01 (isolamento), RN05 (reserva de 30 min), RN13 (grades permitidas),
--         RN18 (somente PAGO conta como vendido)
--
-- Primeira fatia funcional da Fase 2. NAO inclui pagamento real, cativos,
-- apuracao nem automacoes: essas partes tem fase propria e inventar tabela
-- vazia para elas so criaria esquema que ninguem usa.
--
-- ----------------------------------------------------------------------------
-- DECISAO CENTRAL: `draw_numbers` E ESPARSA
--
-- Nao existe linha para numero LIVRE. A ausencia de linha E o estado livre.
--
-- A alternativa — materializar as 1000 linhas na criacao do sorteio — parece
-- mais simples e custa caro no lugar errado: a grade da vitrine passaria a
-- trafegar 1000 registros para mostrar que 995 nao aconteceram. Aqui, um
-- sorteio com 40 numeros vendidos devolve 40 linhas, e o telefone do
-- participante agradece.
--
-- A consequencia que importa: a UNICIDADE de `(draw_id, number)` deixa de ser
-- um detalhe e vira A garantia de concorrencia. Duas requisicoes simultaneas
-- pedindo o mesmo numero disputam o indice, e o PostgreSQL decide — nao a
-- aplicacao, nao o React, nao um SELECT anterior.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Vocabulario proprio desta fatia
--
-- `draw_status` e `draw_number_status` JA EXISTEM (migration 0002) e sao
-- constantes protegidas por teste: 'RASCUNHO', 'ATIVA', 'PAUSADA',
-- 'VENDAS ENCERRADAS' (com espaco), 'LIVRE', 'RESERVADO', 'PENDENTE', 'PAGO'.
-- Criar um vocabulario paralelo em ingles aqui produziria exatamente o erro E3
-- que a fundacao existe para impedir: duas listas evoluindo em separado.
--
-- Os dois enums abaixo sao NOVOS porque nao existia nada equivalente.
-- ---------------------------------------------------------------------------
CREATE TYPE reservation_status AS ENUM (
  'ATIVA',        -- dentro do prazo, segurando os numeros
  'CONVERTIDA',   -- virou pedido
  'EXPIRADA',     -- prazo vencido
  'CANCELADA'     -- desfeita deliberadamente
);

CREATE TYPE order_status AS ENUM (
  'PENDENTE',     -- aguardando pagamento
  'PAGO',
  'CANCELADO'
);

-- ---------------------------------------------------------------------------
-- draws · o sorteio
-- ---------------------------------------------------------------------------
CREATE TABLE draws (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  slug              text NOT NULL,
  title             text NOT NULL,
  description       text,
  prize_name        text NOT NULL,
  prize_description text,
  prize_image_url   text,
  unit_price_cents  integer NOT NULL,
  total_numbers     integer NOT NULL,
  status            draw_status NOT NULL DEFAULT 'RASCUNHO',
  draw_date         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- RN13: a grade e 100, 500 ou 1000. Nao e configuracao livre — o rotulo do
  -- numero (00-99, 000-499, 000-999) deriva dela, e um valor fora da lista
  -- produziria rotulos errados na grade inteira.
  CONSTRAINT draws_grid_size CHECK (total_numbers IN (100, 500, 1000)),

  -- Preco em CENTAVOS, inteiro. Ponto flutuante para dinheiro acumula erro de
  -- arredondamento que so aparece na conciliacao, quando ja e tarde.
  CONSTRAINT draws_price_positive CHECK (unit_price_cents > 0),

  CONSTRAINT draws_slug_format CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$'),
  CONSTRAINT draws_slug_length CHECK (char_length(slug) BETWEEN 3 AND 80),
  CONSTRAINT draws_title_not_blank CHECK (btrim(title) <> ''),
  CONSTRAINT draws_prize_not_blank CHECK (btrim(prize_name) <> '')
);

-- O slug e unico DENTRO da comunidade, nao na plataforma: duas comunidades
-- podem ter o proprio sorteio "natal-2026" sem se atrapalharem.
CREATE UNIQUE INDEX draws_tenant_slug_key ON draws (tenant_id, slug);
CREATE INDEX draws_tenant_status_idx ON draws (tenant_id, status, created_at DESC);

-- Chave composta: as tabelas filhas referenciam (tenant_id, id) em conjunto,
-- para que uma linha da comunidade A nao consiga apontar para um sorteio de B.
-- Um FK simples por id deixaria o cruzamento passar.
ALTER TABLE draws ADD CONSTRAINT draws_tenant_scoped_key UNIQUE (tenant_id, id);

CREATE TRIGGER draws_touch_updated_at
  BEFORE UPDATE ON draws
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- buyers · quem compra
--
-- Separado de `users`: o participante compra sem criar conta. Exigir cadastro
-- antes de escolher o numero derruba conversao, e a Fase 1 ja decidiu que
-- `users` e identidade de EQUIPE.
-- ---------------------------------------------------------------------------
CREATE TABLE buyers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name       text NOT NULL,
  phone      text NOT NULL,
  email      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT buyers_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT buyers_phone_not_blank CHECK (btrim(phone) <> ''),
  CONSTRAINT buyers_email_format
    CHECK (email IS NULL OR email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

CREATE INDEX buyers_tenant_phone_idx ON buyers (tenant_id, phone);
ALTER TABLE buyers ADD CONSTRAINT buyers_tenant_scoped_key UNIQUE (tenant_id, id);

CREATE TRIGGER buyers_touch_updated_at
  BEFORE UPDATE ON buyers
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- reservations · o prazo
--
-- RN05: 30 minutos. O prazo e CONSTANTE DE NEGOCIO, nao configuracao de
-- ambiente — vive em packages/shared e e protegido por teste. `expires_at` e
-- persistido para que o contador exibido ao participante e a regra do servidor
-- descrevam o mesmo instante.
-- ---------------------------------------------------------------------------
CREATE TABLE reservations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  draw_id    uuid NOT NULL,
  status     reservation_status NOT NULL DEFAULT 'ATIVA',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT reservations_draw_fk
    FOREIGN KEY (tenant_id, draw_id) REFERENCES draws (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT reservations_expires_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX reservations_draw_idx ON reservations (draw_id, status);
-- Varredura de expiracao: so as que ainda estao segurando numero.
CREATE INDEX reservations_expiring_idx
  ON reservations (expires_at) WHERE status = 'ATIVA';

ALTER TABLE reservations ADD CONSTRAINT reservations_tenant_scoped_key UNIQUE (tenant_id, id);

CREATE TRIGGER reservations_touch_updated_at
  BEFORE UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- orders · o pedido
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  draw_id           uuid NOT NULL,
  buyer_id          uuid NOT NULL,
  reservation_id    uuid,
  status            order_status NOT NULL DEFAULT 'PENDENTE',

  -- Preco COPIADO no momento da compra, nao lido do sorteio depois.
  -- Se o organizador mudar o preco amanha, o que foi vendido hoje continua
  -- valendo o que valia. Sem isto, todo historico financeiro reescreveria a si
  -- mesmo a cada edicao.
  unit_price_cents  integer NOT NULL,
  quantity          integer NOT NULL,
  total_cents       integer NOT NULL,

  accepted_terms_at timestamptz NOT NULL,
  paid_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT orders_draw_fk
    FOREIGN KEY (tenant_id, draw_id) REFERENCES draws (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT orders_buyer_fk
    FOREIGN KEY (tenant_id, buyer_id) REFERENCES buyers (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT orders_reservation_fk
    FOREIGN KEY (tenant_id, reservation_id) REFERENCES reservations (tenant_id, id) ON DELETE SET NULL,

  CONSTRAINT orders_quantity_positive CHECK (quantity > 0),
  CONSTRAINT orders_price_positive CHECK (unit_price_cents > 0),
  -- O total e conferido pelo BANCO. Um total divergente do preco x quantidade
  -- so apareceria na conciliacao, e ai ja teria virado dinheiro errado.
  CONSTRAINT orders_total_matches CHECK (total_cents = unit_price_cents * quantity),
  CONSTRAINT orders_paid_has_timestamp
    CHECK ((status = 'PAGO') = (paid_at IS NOT NULL))
);

CREATE INDEX orders_tenant_created_idx ON orders (tenant_id, created_at DESC);
CREATE INDEX orders_draw_status_idx ON orders (draw_id, status);
ALTER TABLE orders ADD CONSTRAINT orders_tenant_scoped_key UNIQUE (tenant_id, id);

CREATE TRIGGER orders_touch_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- order_items · o que foi vendido, pelo preco do dia
--
-- Poderia ser derivado de `draw_numbers WHERE order_id = X`. Nao e a mesma
-- coisa: `draw_numbers` guarda o ESTADO ATUAL do numero, e `order_items` guarda
-- o FATO da venda — inclusive o preco unitario praticado naquele pedido. Um
-- estorno muda o estado do numero; nao muda o que foi vendido.
-- ---------------------------------------------------------------------------
CREATE TABLE order_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  order_id         uuid NOT NULL,
  number           integer NOT NULL,
  unit_price_cents integer NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT order_items_order_fk
    FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT order_items_number_non_negative CHECK (number >= 0),
  CONSTRAINT order_items_price_positive CHECK (unit_price_cents > 0)
);

-- O mesmo numero nao entra duas vezes no mesmo pedido.
CREATE UNIQUE INDEX order_items_order_number_key ON order_items (order_id, number);

-- ---------------------------------------------------------------------------
-- draw_numbers · ESPARSA. Ausencia de linha = LIVRE.
--
-- A UNICIDADE ABAIXO E A TRAVA DE CONCORRENCIA. Nao ha `if` na aplicacao capaz
-- de substitui-la: entre um `SELECT` que diz "esta livre" e o `INSERT` que
-- reserva cabe outra transacao inteira. Quem decide o empate e o indice.
-- ---------------------------------------------------------------------------
CREATE TABLE draw_numbers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  draw_id        uuid NOT NULL,
  number         integer NOT NULL,
  status         draw_number_status NOT NULL,
  reservation_id uuid,
  order_id       uuid,
  -- Espelha `reservations.expires_at`. Duplicado de proposito: a consulta da
  -- grade e a reserva atomica precisam decidir "vencido?" sem juntar tabela, no
  -- caminho mais quente do produto.
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT draw_numbers_draw_fk
    FOREIGN KEY (tenant_id, draw_id) REFERENCES draws (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT draw_numbers_reservation_fk
    FOREIGN KEY (tenant_id, reservation_id) REFERENCES reservations (tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT draw_numbers_order_fk
    FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id) ON DELETE SET NULL,

  CONSTRAINT draw_numbers_non_negative CHECK (number >= 0),

  -- Linha com estado LIVRE nao existe: livre e a AUSENCIA de linha. Permitir as
  -- duas representacoes criaria dois jeitos de dizer a mesma coisa, e consultas
  -- que concordam em um ambiente e divergem no outro.
  CONSTRAINT draw_numbers_never_free CHECK (status <> 'LIVRE'),

  -- Reserva sem prazo seria reserva eterna.
  CONSTRAINT draw_numbers_reserved_has_deadline
    CHECK (status <> 'RESERVADO' OR expires_at IS NOT NULL),

  -- Numero PAGO pertence a um pedido. Sem isso, existiria venda sem dono.
  CONSTRAINT draw_numbers_paid_has_order
    CHECK (status <> 'PAGO' OR order_id IS NOT NULL)
);

-- A TRAVA. Um numero, um dono, por sorteio.
CREATE UNIQUE INDEX draw_numbers_draw_number_key ON draw_numbers (draw_id, number);

-- Leitura da grade: o caminho mais percorrido do produto.
CREATE INDEX draw_numbers_draw_status_idx ON draw_numbers (draw_id, status);
-- Varredura de expiracao.
CREATE INDEX draw_numbers_expiring_idx
  ON draw_numbers (expires_at) WHERE status = 'RESERVADO';
CREATE INDEX draw_numbers_order_idx ON draw_numbers (order_id) WHERE order_id IS NOT NULL;

CREATE TRIGGER draw_numbers_touch_updated_at
  BEFORE UPDATE ON draw_numbers
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RN18 · numero PAGO nao volta sozinho para livre
--
-- A transicao PAGO -> ESTORNADO existe e e deliberada (DOC-01). O que este
-- gatilho impede e o acidente: uma varredura de expiracao mal escrita, um
-- UPDATE sem WHERE, um retry de job que "limpa" o que ja foi vendido.
--
-- Apagar a linha tambem e barrado: a ausencia de linha significa LIVRE, entao
-- DELETE de um numero PAGO e a mesma perda por outro caminho.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.protect_paid_numbers()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'PAGO' THEN
      RAISE EXCEPTION
        'numero % do sorteio % esta PAGO e nao pode ser removido (RN18)',
        OLD.number, OLD.draw_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'PAGO' AND NEW.status <> 'PAGO' AND NEW.status <> 'ESTORNADO' THEN
    RAISE EXCEPTION
      'numero % do sorteio % esta PAGO: a unica saida e ESTORNADO, nunca % (RN18)',
      OLD.number, OLD.draw_id, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER draw_numbers_protect_paid
  BEFORE UPDATE OR DELETE ON draw_numbers
  FOR EACH ROW EXECUTE FUNCTION app.protect_paid_numbers();

-- ============================================================================
-- RLS · o mesmo criterio da fundacao
--
-- A vitrine e PUBLICA e mesmo assim passa por aqui: o middleware de comunidade
-- abre o contexto a partir do dominio ANTES de qualquer consulta, e sem
-- contexto `app.current_tenant_id()` e NULL e nenhuma linha passa. Publico nao
-- significa "de todo mundo": significa "desta comunidade, sem exigir sessao".
-- ============================================================================
ALTER TABLE draws ENABLE ROW LEVEL SECURITY;
ALTER TABLE buyers ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE draw_numbers ENABLE ROW LEVEL SECURITY;

CREATE POLICY draws_select ON draws FOR SELECT
  USING (tenant_id = app.current_tenant_id() OR app.has_platform_access());
CREATE POLICY draws_insert ON draws FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY draws_update ON draws FOR UPDATE
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY buyers_select ON buyers FOR SELECT
  USING (tenant_id = app.current_tenant_id() OR app.has_platform_access());
CREATE POLICY buyers_insert ON buyers FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY buyers_update ON buyers FOR UPDATE
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY reservations_select ON reservations FOR SELECT
  USING (tenant_id = app.current_tenant_id() OR app.has_platform_access());
CREATE POLICY reservations_insert ON reservations FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY reservations_update ON reservations FOR UPDATE
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY orders_select ON orders FOR SELECT
  USING (tenant_id = app.current_tenant_id() OR app.has_platform_access());
CREATE POLICY orders_insert ON orders FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY orders_update ON orders FOR UPDATE
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY order_items_select ON order_items FOR SELECT
  USING (tenant_id = app.current_tenant_id() OR app.has_platform_access());
CREATE POLICY order_items_insert ON order_items FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY draw_numbers_select ON draw_numbers FOR SELECT
  USING (tenant_id = app.current_tenant_id() OR app.has_platform_access());
CREATE POLICY draw_numbers_insert ON draw_numbers FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY draw_numbers_update ON draw_numbers FOR UPDATE
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Sem policy de DELETE em nenhuma delas: venda nao se apaga.

-- ============================================================================
-- Privilegios · mesmo criterio de 0006
-- ============================================================================
GRANT SELECT, INSERT, UPDATE ON
  draws, buyers, reservations, orders, draw_numbers
TO app_user;

-- `order_items` e o registro do que foi vendido: escreve-se uma vez.
GRANT SELECT, INSERT ON order_items TO app_user;

-- O worker so precisa LER para a varredura de expiracao e UPDATE para libera-la.
-- Nao recebe acesso a `buyers`: dado pessoal do comprador nao participa de
-- nenhum trabalho de fila desta fase.
GRANT SELECT, UPDATE ON reservations, draw_numbers TO app_worker;
GRANT SELECT ON draws TO app_worker;

CREATE POLICY reservations_worker ON reservations FOR ALL TO app_worker
  USING (true) WITH CHECK (true);
CREATE POLICY draw_numbers_worker ON draw_numbers FOR ALL TO app_worker
  USING (true) WITH CHECK (true);
CREATE POLICY draws_worker_select ON draws FOR SELECT TO app_worker USING (true);

-- ============================================================================
-- Superficie da Data API: a 0009 fechou o que existia NAQUELE momento.
-- Estas tabelas nasceram agora, e os DEFAULT PRIVILEGES ja corrigidos por ela
-- impedem que herdem acesso. A revogacao abaixo e cinto e suspensorio: custa
-- nada e protege contra um default restaurado por engano entre as duas.
-- ============================================================================
DO $$
DECLARE
  papel text;
BEGIN
  FOREACH papel IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = papel) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON draws, buyers, reservations, orders, order_items, draw_numbers FROM %I',
        papel);
    END IF;
  END LOOP;
END;
$$;
