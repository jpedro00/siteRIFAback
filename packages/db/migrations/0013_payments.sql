-- ============================================================================
-- 0013 · Pagamentos PIX (M05)
-- ----------------------------------------------------------------------------
-- `payments` guarda a COBRANCA feita no provedor (PSP) para um pedido. O pedido
-- so vira PAGO quando o PSP CONFIRMA a cobranca — consultada na API do provedor,
-- nunca pelo que chegou no corpo de um webhook (RN06).
--
-- O que garante a idempotencia:
--   * `idempotency_key` UNICA: a chave e o `order_id`. Repetir "gerar o PIX" para
--     o mesmo pedido devolve a mesma cobranca, nunca uma segunda.
--   * `(provider, provider_payment_id)` UNICO: o mesmo pagamento do PSP nao vira
--     duas linhas.
--   * A transicao PENDENTE -> APROVADO e feita com a linha travada; webhook
--     repetido encontra APROVADO e nao faz nada (RN07).
--
-- Credenciais do PSP NAO entram aqui nem em nenhuma tabela: ficam em variavel de
-- ambiente. `raw` e a resposta do PSP a uma consulta, sem nada nosso.
-- ============================================================================

CREATE TYPE payment_status AS ENUM (
  'PENDENTE',    -- cobranca criada, aguardando o pagamento
  'APROVADO',    -- o PSP confirmou o pagamento
  'EXPIRADO',    -- o prazo do PIX terminou sem pagamento
  'CANCELADO',   -- cancelada ou recusada no PSP
  'ESTORNADO'    -- devolvida
);

CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  order_id            uuid NOT NULL,
  provider            text NOT NULL,
  provider_payment_id text NOT NULL,
  status              payment_status NOT NULL DEFAULT 'PENDENTE',
  idempotency_key     text NOT NULL,
  amount_cents        integer NOT NULL,
  -- "Copia e cola" do PIX e o QR em base64. Sao para o participante pagar; nao
  -- sao segredo, mas tambem nao precisam ser lidos por quem so lista pedidos.
  pix_copy_paste      text,
  pix_qr_base64       text,
  expires_at          timestamptz NOT NULL,
  paid_at             timestamptz,
  -- Pagamento aprovado depois de o numero ja ter outro dono: a venda NAO se
  -- conclui e o dinheiro precisa ser devolvido por uma pessoa (Suposicao S4).
  needs_manual_refund boolean NOT NULL DEFAULT false,
  refund_reason       text,
  raw                 jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payments_order_fk
    FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT payments_provider_known CHECK (provider IN ('MERCADO_PAGO', 'FAKE')),
  CONSTRAINT payments_amount_positive CHECK (amount_cents > 0),
  CONSTRAINT payments_provider_id_not_blank CHECK (btrim(provider_payment_id) <> ''),
  -- Um pagamento estornado FOI pago: `paid_at` fica.
  CONSTRAINT payments_paid_has_timestamp CHECK (
    (status IN ('APROVADO', 'ESTORNADO')) = (paid_at IS NOT NULL)
  ),
  CONSTRAINT payments_refund_has_reason CHECK (NOT needs_manual_refund OR refund_reason IS NOT NULL)
);

CREATE UNIQUE INDEX payments_provider_payment_key ON payments (provider, provider_payment_id);
CREATE UNIQUE INDEX payments_idempotency_key ON payments (idempotency_key);
CREATE INDEX payments_order_idx ON payments (order_id);
-- Varredura de PIX vencido e conciliacao.
CREATE INDEX payments_pending_expiry_idx ON payments (expires_at) WHERE status = 'PENDENTE';
CREATE INDEX payments_refund_idx ON payments (tenant_id) WHERE needs_manual_refund;

CREATE TRIGGER payments_touch_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS · mesmo criterio de 0010
-- ---------------------------------------------------------------------------
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY payments_select ON payments FOR SELECT
  USING (tenant_id = app.current_tenant_id() OR app.has_platform_access());
CREATE POLICY payments_insert ON payments FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY payments_update ON payments FOR UPDATE
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
-- Sem policy de DELETE: cobranca nao se apaga.

GRANT SELECT, INSERT, UPDATE ON payments TO app_user;

-- Superficie da Data API (mesmo cinto e suspensorio da 0010).
DO $$
DECLARE
  papel text;
BEGIN
  FOREACH papel IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = papel) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON payments FROM %I', papel);
    END IF;
  END LOOP;
END;
$$;
