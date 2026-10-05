-- ============================================================================
-- 0014 · Fechamento, snapshot (RN20) e resultado (M06 · RN09)
-- ----------------------------------------------------------------------------
-- O QUE ENTRA
--   * `draws.no_winner_policy`: o que fazer quando o numero apurado nao foi
--     vendido (Suposicao S5, configuravel).
--   * `draw_snapshots`: o retrato CONGELADO do sorteio quando as vendas fecham e
--     nao ha pendencia — numeros pagos, compradores mascarados, preco, regulamento —
--     com hash. So-insercao.
--   * `draw_results`: o resultado, VERSIONADO. Corrigir cria uma versao nova e a
--     anterior fica visivel como RETIFICADA (RN09); nenhuma versao se apaga.
--   * Duas funcoes de SISTEMA para o worker (fechar vendas, iniciar apuracao,
--     ativar agendado, gerar o snapshot). Sao SECURITY DEFINER e so `app_worker`
--     as executa: o worker nao ganha UPDATE em `draws`.
--
-- A calculo do ganhador e a publicacao do resultado sao da API (o organizador
-- informa o numero da Loteria Federal e a evidencia). O banco garante a FORMA:
-- versoes unicas, uma so vigente, evidencia obrigatoria, nada apagado.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- draws · politica quando o numero apurado nao foi vendido (S5)
-- ---------------------------------------------------------------------------
ALTER TABLE draws
  ADD COLUMN no_winner_policy text NOT NULL DEFAULT 'PROXIMO_VENDIDO_ACIMA',
  ADD CONSTRAINT draws_no_winner_policy_known
    CHECK (no_winner_policy IN ('PROXIMO_VENDIDO_ACIMA', 'SEM_CONTEMPLADO'));

-- ---------------------------------------------------------------------------
-- Mascara de nome para exibicao publica: "Maria Souza" -> "M*** S***".
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.mask_name(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(string_agg(left(w.word, 1) || '***', ' ' ORDER BY w.n), '')
    FROM regexp_split_to_table(btrim(COALESCE(p, '')), '\s+') WITH ORDINALITY AS w(word, n)
   WHERE w.word <> '';
$$;

-- ---------------------------------------------------------------------------
-- draw_snapshots · o retrato congelado (RN20)
-- ---------------------------------------------------------------------------
CREATE TABLE draw_snapshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  draw_id     uuid NOT NULL,
  payload     jsonb NOT NULL,
  -- SHA-256 do `payload::text`. jsonb serializa com chaves em ordem estavel, entao
  -- o mesmo conteudo gera sempre o mesmo hash.
  sha256      text NOT NULL,
  paid_count  integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT draw_snapshots_draw_fk
    FOREIGN KEY (tenant_id, draw_id) REFERENCES draws (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT draw_snapshots_one_per_draw UNIQUE (draw_id),
  CONSTRAINT draw_snapshots_sha_format CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT draw_snapshots_paid_non_negative CHECK (paid_count >= 0),
  CONSTRAINT draw_snapshots_payload_no_secrets CHECK (app.assert_no_secrets(payload))
);

-- So-insercao: o retrato nao muda nem some, nem para o dono da tabela.
CREATE FUNCTION app.forbid_snapshot_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'draw_snapshots e somente-insercao (RN20): % nao e permitido.', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER draw_snapshots_immutable
  BEFORE UPDATE OR DELETE ON draw_snapshots
  FOR EACH ROW EXECUTE FUNCTION app.forbid_snapshot_change();

ALTER TABLE draw_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY draw_snapshots_select ON draw_snapshots FOR SELECT
  USING (tenant_id = app.current_tenant_id() OR app.has_platform_access());
CREATE POLICY draw_snapshots_worker_select ON draw_snapshots FOR SELECT TO app_worker USING (true);

-- Sem INSERT para ninguem: quem grava e a funcao SECURITY DEFINER abaixo.
GRANT SELECT ON draw_snapshots TO app_user, app_worker;

-- ---------------------------------------------------------------------------
-- draw_results · o resultado, versionado (RN09)
-- ---------------------------------------------------------------------------
CREATE TABLE draw_results (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  draw_id           uuid NOT NULL,
  version           integer NOT NULL,
  status            text NOT NULL,
  source            text NOT NULL,
  -- Numero do primeiro premio da Loteria Federal, so digitos.
  federal_number    text NOT NULL,
  federal_contest   text,
  -- Evidencia: texto e/ou link https. Sem nenhuma das duas o resultado nao existe.
  evidence_text     text,
  evidence_url      text,
  label_digits      smallint NOT NULL,
  candidate_number  integer NOT NULL,
  -- NULO = ninguem contemplado (politica SEM_CONTEMPLADO ou nenhum numero vendido).
  winning_number    integer,
  winner_order_id   uuid,
  winner_masked     text,
  -- Cada numero conferido, em ordem: a "prova de calculo".
  attempts          jsonb NOT NULL,
  snapshot_sha256   text NOT NULL,
  proof_sha256      text NOT NULL,
  correction_reason text,
  published_by      uuid REFERENCES users (id) ON DELETE RESTRICT,
  published_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT draw_results_draw_fk
    FOREIGN KEY (tenant_id, draw_id) REFERENCES draws (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT draw_results_order_fk
    FOREIGN KEY (tenant_id, winner_order_id) REFERENCES orders (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT draw_results_version_key UNIQUE (draw_id, version),
  CONSTRAINT draw_results_version_positive CHECK (version >= 1),
  CONSTRAINT draw_results_status_known CHECK (status IN ('VIGENTE', 'RETIFICADA')),
  CONSTRAINT draw_results_source_known CHECK (source IN ('LOTERIA_FEDERAL')),
  CONSTRAINT draw_results_federal_digits CHECK (federal_number ~ '^[0-9]{2,10}$'),
  CONSTRAINT draw_results_evidence_present CHECK (evidence_text IS NOT NULL OR evidence_url IS NOT NULL),
  CONSTRAINT draw_results_evidence_https CHECK (evidence_url IS NULL OR evidence_url ~* '^https://'),
  CONSTRAINT draw_results_label_digits CHECK (label_digits IN (2, 3)),
  CONSTRAINT draw_results_winner_consistent CHECK (
    (winning_number IS NULL) = (winner_order_id IS NULL)
  ),
  CONSTRAINT draw_results_hashes CHECK (
    snapshot_sha256 ~ '^[0-9a-f]{64}$' AND proof_sha256 ~ '^[0-9a-f]{64}$'
  ),
  -- A partir da versao 2 e correcao: o motivo e obrigatorio.
  CONSTRAINT draw_results_correction_reason CHECK (
    version = 1 OR (correction_reason IS NOT NULL AND btrim(correction_reason) <> '')
  )
);

-- UMA versao vigente por sorteio.
CREATE UNIQUE INDEX draw_results_one_current ON draw_results (draw_id) WHERE status = 'VIGENTE';
CREATE INDEX draw_results_tenant_idx ON draw_results (tenant_id, draw_id, version DESC);

-- O unico UPDATE permitido: VIGENTE -> RETIFICADA. Nada mais muda, nada se apaga.
CREATE FUNCTION app.draw_results_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'resultado nao se apaga (RN09): publique uma correcao.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.status = 'RETIFICADA' AND OLD.status = 'VIGENTE'
     AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'resultado e imutavel (RN09): so VIGENTE -> RETIFICADA e permitido.'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER draw_results_guard
  BEFORE UPDATE OR DELETE ON draw_results
  FOR EACH ROW EXECUTE FUNCTION app.draw_results_guard();

ALTER TABLE draw_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY draw_results_select ON draw_results FOR SELECT
  USING (tenant_id = app.current_tenant_id() OR app.has_platform_access());
CREATE POLICY draw_results_insert ON draw_results FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY draw_results_update ON draw_results FOR UPDATE
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

GRANT SELECT, INSERT ON draw_results TO app_user;
GRANT UPDATE (status) ON draw_results TO app_user;

-- ---------------------------------------------------------------------------
-- Funcoes de SISTEMA para o worker.
--
-- SECURITY DEFINER com `search_path` fixo. Sao a UNICA porta de mudanca de
-- estado do sorteio pelo sistema (regra: toda transicao e uma funcao unica que
-- confere o estado na transacao e grava auditoria + outbox juntos).
-- ---------------------------------------------------------------------------

-- Ha pendencia enquanto algum numero aguarda pagamento ou segura reserva viva.
CREATE FUNCTION app.draw_has_pending_numbers(p_draw_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.draw_numbers
     WHERE draw_id = p_draw_id
       AND (status IN ('PENDENTE', 'CATIVO PENDENTE')
            OR (status = 'RESERVADO' AND expires_at > now()))
  );
$$;

CREATE FUNCTION app.worker_create_draw_snapshot(p_draw_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  d       public.draws%ROWTYPE;
  sid     uuid;
  itens   jsonb;
  payload jsonb;
  h       text;
BEGIN
  SELECT * INTO d FROM public.draws WHERE id = p_draw_id FOR UPDATE;
  IF NOT FOUND OR d.status <> 'VENDAS ENCERRADAS' THEN
    RETURN NULL;
  END IF;

  -- Idempotente: um so retrato por sorteio.
  SELECT id INTO sid FROM public.draw_snapshots WHERE draw_id = p_draw_id;
  IF sid IS NOT NULL THEN
    RETURN sid;
  END IF;

  -- Com pendencia, o retrato ainda nao esta fechado.
  IF app.draw_has_pending_numbers(p_draw_id) THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'number', n.number,
             'orderId', n.order_id,
             'unitPriceCents', i.unit_price_cents,
             'buyer', app.mask_name(b.name),
             'phoneLast4', right(regexp_replace(b.phone, '\D', '', 'g'), 4)
           ) ORDER BY n.number), '[]'::jsonb)
    INTO itens
    FROM public.draw_numbers n
    JOIN public.orders o ON o.id = n.order_id
    JOIN public.buyers b ON b.id = o.buyer_id
    JOIN public.order_items i ON i.order_id = o.id AND i.number = n.number
   WHERE n.draw_id = p_draw_id AND n.status = 'PAGO';

  payload := jsonb_build_object(
    'drawId', d.id,
    'title', d.title,
    -- Suposicao S-REG1: ate existir campo proprio, o regulamento e a descricao.
    'regulation', COALESCE(d.description, ''),
    'totalNumbers', d.total_numbers,
    'labelDigits', d.label_digits,
    'ticketPriceCents', d.ticket_price_cents,
    'resultSource', d.result_source,
    'noWinnerPolicy', d.no_winner_policy,
    'drawDate', d.draw_date,
    'closedAt', now(),
    'paidCount', jsonb_array_length(itens),
    'paidNumbers', itens
  );
  h := encode(sha256(convert_to(payload::text, 'UTF8')), 'hex');

  INSERT INTO public.draw_snapshots (tenant_id, draw_id, payload, sha256, paid_count)
  VALUES (d.tenant_id, d.id, payload, h, jsonb_array_length(itens))
  RETURNING id INTO sid;

  INSERT INTO public.audit_events (tenant_id, actor_user_id, actor_type, action, target_type, target_id, after)
  VALUES (d.tenant_id, NULL, 'SYSTEM', 'draw.snapshot_created', 'draw', d.id::text,
          jsonb_build_object('sha256', h, 'paidCount', jsonb_array_length(itens)));

  RETURN sid;
END;
$$;

CREATE FUNCTION app.worker_transition_draw(
  p_draw_id uuid,
  p_to      public.draw_status,
  p_reason  text DEFAULT NULL
)
RETURNS public.draw_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  d      public.draws%ROWTYPE;
  eventos text[];
  ev     text;
BEGIN
  SELECT * INTO d FROM public.draws WHERE id = p_draw_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sorteio % inexistente', p_draw_id USING ERRCODE = 'P0002';
  END IF;

  -- O que o SISTEMA pode fazer: fechar vendas, ativar agendado, iniciar apuracao.
  IF d.status IN ('ATIVA', 'PAUSADA') AND p_to = 'VENDAS ENCERRADAS' THEN
    eventos := ARRAY['draw.sales_closed'];
  ELSIF d.status = 'AGENDADA' AND p_to = 'ATIVA' THEN
    IF d.sales_start_at IS NULL OR d.sales_start_at > now() THEN
      RAISE EXCEPTION 'sorteio % ainda nao chegou a hora de abrir as vendas', p_draw_id
        USING ERRCODE = 'P0001';
    END IF;
    eventos := ARRAY['draw.activated'];
  ELSIF d.status = 'VENDAS ENCERRADAS' AND p_to = 'APURAÇÃO' THEN
    -- RN20: a apuracao parte do retrato congelado.
    IF NOT EXISTS (SELECT 1 FROM public.draw_snapshots WHERE draw_id = p_draw_id) THEN
      RAISE EXCEPTION 'APURACAO exige o snapshot do sorteio (RN20)' USING ERRCODE = 'P0001';
    END IF;
    eventos := ARRAY['draw.apuration_started'];
  ELSE
    RAISE EXCEPTION 'o sistema nao pode levar um sorteio de "%" para "%"', d.status, p_to
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.draws SET status = p_to WHERE id = p_draw_id;

  INSERT INTO public.audit_events
    (tenant_id, actor_user_id, actor_type, action, target_type, target_id, before, after)
  VALUES
    (d.tenant_id, NULL, 'SYSTEM', 'draw.status_changed', 'draw', d.id::text,
     jsonb_build_object('status', d.status),
     jsonb_build_object('status', p_to, 'reason', p_reason));

  FOREACH ev IN ARRAY eventos LOOP
    INSERT INTO public.outbox (tenant_id, event_type, payload)
    VALUES (d.tenant_id, ev, jsonb_build_object(
      'tenantId', d.tenant_id,
      'drawId', d.id,
      'from', d.status,
      'to', p_to,
      'actorUserId', NULL,
      'actorType', 'SYSTEM',
      'reason', p_reason
    ));
  END LOOP;

  RETURN p_to;
END;
$$;

-- Somente o worker executa as funcoes de sistema.
REVOKE EXECUTE ON FUNCTION app.worker_create_draw_snapshot(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.worker_transition_draw(uuid, public.draw_status, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.draw_has_pending_numbers(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_create_draw_snapshot(uuid) TO app_worker;
GRANT EXECUTE ON FUNCTION app.worker_transition_draw(uuid, public.draw_status, text) TO app_worker;
GRANT EXECUTE ON FUNCTION app.draw_has_pending_numbers(uuid) TO app_worker;

-- Superficie da Data API.
DO $$
DECLARE
  papel text;
BEGIN
  FOREACH papel IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = papel) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON draw_snapshots, draw_results FROM %I', papel);
    END IF;
  END LOOP;
END;
$$;
