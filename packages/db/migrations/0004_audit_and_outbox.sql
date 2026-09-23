-- ============================================================================
-- 0004 · Auditoria e outbox
--
-- Modulo: M12 (auditoria e observabilidade)
-- Regras: RN11 (auditoria imutavel), RN21 (eventos saem da outbox)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- audit_events — SOMENTE INSERCAO. RN11.
--
-- `tenant_id` e NULO para acoes de plataforma (criar comunidade, conceder
-- privilegio de Super Admin). Nao existe "tenant tecnico" para abrigar essas
-- linhas: inventar um seria criar um balde onde dados de varias comunidades
-- se encontrariam.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid REFERENCES tenants (id) ON DELETE RESTRICT,
  actor_user_id  uuid REFERENCES users (id) ON DELETE RESTRICT,
  actor_type     text NOT NULL DEFAULT 'USER',
  action         text NOT NULL,
  target_type    text,
  target_id      text,
  before         jsonb,
  after          jsonb,
  ip             inet,
  user_agent     text,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_events_actor_type
    CHECK (actor_type IN ('USER', 'PLATFORM', 'SYSTEM')),
  CONSTRAINT audit_events_action_not_blank CHECK (btrim(action) <> ''),
  -- Ator humano precisa estar identificado. Acao do sistema, nao.
  CONSTRAINT audit_events_human_actor_identified
    CHECK (actor_type = 'SYSTEM' OR actor_user_id IS NOT NULL),
  -- Segredo nao entra na trilha. Ver app.assert_no_secrets em 0001.
  CONSTRAINT audit_events_before_no_secrets CHECK (app.assert_no_secrets(before)),
  CONSTRAINT audit_events_after_no_secrets CHECK (app.assert_no_secrets(after))
);

CREATE INDEX audit_events_tenant_time_idx
  ON audit_events (tenant_id, occurred_at DESC);
CREATE INDEX audit_events_actor_time_idx
  ON audit_events (actor_user_id, occurred_at DESC);
CREATE INDEX audit_events_platform_time_idx
  ON audit_events (occurred_at DESC) WHERE tenant_id IS NULL;

COMMENT ON TABLE audit_events IS
  'RN11 · trilha imutavel. UPDATE e DELETE sao bloqueados por trigger (abaixo) '
  'e por ausencia de GRANT ao papel da aplicacao (0006). O trigger cobre ate o '
  'dono das tabelas; o GRANT sozinho nao cobriria.';

-- Bloqueio de alteracao e exclusao.
-- Defesa dupla, de proposito: os GRANTs de 0006 impedem o papel da aplicacao,
-- e este trigger impede tambem quem for dono do schema. Se o GRANT for
-- afrouxado por engano numa migration futura, o trigger continua de pe.
CREATE OR REPLACE FUNCTION app.deny_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'audit_events e somente insercao: % nao e permitido (RN11)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_events_deny_update
  BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION app.deny_audit_mutation();

CREATE TRIGGER audit_events_deny_delete
  BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION app.deny_audit_mutation();

-- TRUNCATE nao dispara trigger de linha; precisa do gatilho de statement.
CREATE TRIGGER audit_events_deny_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.deny_audit_mutation();

-- ---------------------------------------------------------------------------
-- outbox — registro transacional de eventos. RN21.
--
-- A OUTBOX NAO E A FILA. Ela e o registro de que algo aconteceu, gravado na
-- MESMA transacao da alteracao que o originou. Se a transacao sofrer rollback,
-- o evento desaparece junto: nao existe evento de uma mudanca que nao houve.
--
-- Um relay separado (apps/worker) le as linhas nao publicadas e as entrega a
-- fila de execucao (pg-boss). Sao responsabilidades distintas e marcadas em
-- colunas distintas:
--   published_at  = o relay conseguiu entregar o evento a fila. Nada alem.
--   attempts/last_error = tentativas do relay.
--
-- A conclusao do CONSUMIDOR nao e marcada aqui: fica em `event_consumptions`,
-- porque um mesmo evento pode ter varios consumidores com destinos diferentes.
--
-- Entrega e AO MENOS UMA VEZ. Nao ha promessa de "exatamente uma vez" para
-- efeito externo: se o provedor aceitar e a resposta se perder, o relay
-- tentara de novo. O que impede efeito duplicado e a idempotencia do
-- consumidor, nao a existencia de uma constraint.
-- ---------------------------------------------------------------------------
CREATE TABLE outbox (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid REFERENCES tenants (id) ON DELETE RESTRICT,
  event_type   text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  published_at timestamptz,
  CONSTRAINT outbox_event_type_not_blank CHECK (btrim(event_type) <> ''),
  CONSTRAINT outbox_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_attempts_sane CHECK (attempts >= 0),
  CONSTRAINT outbox_payload_no_secrets CHECK (app.assert_no_secrets(payload))
);

-- Varredura do relay: so as pendentes, na ordem de disponibilidade.
CREATE INDEX outbox_pending_idx
  ON outbox (available_at, id) WHERE published_at IS NULL;
CREATE INDEX outbox_tenant_idx ON outbox (tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- event_consumptions — idempotencia do CONSUMIDOR.
--
-- O consumidor grava aqui, NA MESMA TRANSACAO do seu efeito. Reprocessar o
-- mesmo evento colide com a chave primaria e o efeito nao se repete.
--
-- A chave inclui o consumidor: dois consumidores diferentes do mesmo evento
-- sao trabalhos diferentes e ambos precisam acontecer.
-- ---------------------------------------------------------------------------
CREATE TABLE event_consumptions (
  event_id     uuid NOT NULL REFERENCES outbox (id) ON DELETE CASCADE,
  consumer     text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, consumer),
  CONSTRAINT event_consumptions_consumer_not_blank CHECK (btrim(consumer) <> '')
);

COMMENT ON TABLE event_consumptions IS
  'Marca que um consumidor concluiu sua responsabilidade sobre um evento. '
  'Gravado na mesma transacao do efeito; reprocessar colide na PK e nao '
  'duplica.';
