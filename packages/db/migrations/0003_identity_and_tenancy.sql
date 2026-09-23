-- ============================================================================
-- 0003 · Identidade, comunidade e vinculos
--
-- Modulo: M01 (identidade, comunidade e permissoes) · M11 (plano da comunidade)
-- Regras: RN01 (isolamento), RN12 (MFA)
--
-- DECISAO DE MODELAGEM — IDENTIDADE GLOBAL (excecao explicita a RN01)
--
-- O DOC-01 secao 18 diz que "todas as tabelas de negocio tem tenant_id". A
-- secao 3 diz que "o mesmo usuario pode ter papeis diferentes em comunidades
-- diferentes". As duas frases nao cabem juntas para a tabela de login: uma
-- pessoa tem UMA credencial e participa de N comunidades.
--
-- Resolucao adotada, explicita e nao escondida numa policy:
--   * `users`, `user_credentials`, `user_mfa_factors` e `sessions` sao GLOBAIS
--     e nao tem tenant_id. Sao identidade, nao dado de negocio.
--   * Toda entidade de NEGOCIO por comunidade tem tenant_id e RLS.
--   * O acesso a `users` e restrito por policy (0005): a aplicacao so enxerga
--     o proprio usuario, os colegas da comunidade resolvida no momento, ou
--     tudo sob acesso de plataforma verificado.
--   * A busca por e-mail no login NAO passa por essa policy: passa por uma
--     funcao SECURITY DEFINER de escopo minimo (0005), para que o papel da
--     aplicacao nao consiga enumerar a base de usuarios.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Comunidades (tenants)
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL,
  name          text NOT NULL,
  status        tenant_status NOT NULL DEFAULT 'ACTIVE',
  plan_code     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_slug_format CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$'),
  CONSTRAINT tenants_slug_length CHECK (char_length(slug) BETWEEN 3 AND 63),
  CONSTRAINT tenants_name_not_blank CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX tenants_slug_key ON tenants (slug);

COMMENT ON TABLE tenants IS
  'Comunidade white-label. Criada pelo Super Admin. DOC-01 secao 2, passo 1.';

-- ---------------------------------------------------------------------------
-- Dominios da comunidade
--
-- Estrutura preparada para dominio proprio (DOC-01 secao 2, passo 6). O
-- provisionamento de DNS/TLS NAO faz parte desta fase: aqui so existe o
-- registro do dominio e o momento em que foi verificado.
--
-- `verified_at IS NULL` significa dominio ainda nao comprovado; o resolvedor
-- de comunidade recusa esses dominios em vez de aceita-los.
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_domains (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  domain       text NOT NULL,
  is_primary   boolean NOT NULL DEFAULT false,
  verified_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_domains_lowercase CHECK (domain = lower(domain)),
  CONSTRAINT tenant_domains_format CHECK (domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$')
);

-- Um dominio pertence a no maximo uma comunidade, em toda a plataforma.
CREATE UNIQUE INDEX tenant_domains_domain_key ON tenant_domains (domain);
-- No maximo um dominio primario por comunidade.
CREATE UNIQUE INDEX tenant_domains_one_primary
  ON tenant_domains (tenant_id) WHERE is_primary;
CREATE INDEX tenant_domains_tenant_idx ON tenant_domains (tenant_id);

-- ---------------------------------------------------------------------------
-- Marca da comunidade. DOC-01 secao 2, tabela de personalizacao.
--
-- Campos NULL significam "herda o padrao da plataforma" (RN26). A camada de
-- sorteio, que herda desta, pertence a Fase 4.
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_branding (
  tenant_id        uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  public_name      text,
  logo_light_url   text,
  logo_dark_url    text,
  favicon_url      text,
  share_image_url  text,
  colors           jsonb NOT NULL DEFAULT '{}'::jsonb,
  fonts            jsonb NOT NULL DEFAULT '{}'::jsonb,
  showcase         jsonb NOT NULL DEFAULT '{}'::jsonb,
  contact          jsonb NOT NULL DEFAULT '{}'::jsonb,
  communication    jsonb NOT NULL DEFAULT '{}'::jsonb,
  tracking         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_branding_colors_object CHECK (jsonb_typeof(colors) = 'object'),
  CONSTRAINT tenant_branding_fonts_object CHECK (jsonb_typeof(fonts) = 'object'),
  CONSTRAINT tenant_branding_contact_object CHECK (jsonb_typeof(contact) = 'object')
);

COMMENT ON COLUMN tenant_branding.colors IS
  'RN27/RN28: a validacao de contraste 4,5:1 e a distincao por texto/icone '
  'pertencem a Fase 4 (personalizacao) e ainda nao sao aplicadas aqui.';

-- ---------------------------------------------------------------------------
-- Usuarios — IDENTIDADE GLOBAL. Sem tenant_id, por decisao documentada acima.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL,
  display_name      text NOT NULL,
  status            user_status NOT NULL DEFAULT 'ACTIVE',
  email_verified_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Normalizacao no banco evita duas contas "Joao@x.com" e "joao@x.com".
  CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
  CONSTRAINT users_email_format CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  CONSTRAINT users_display_name_not_blank CHECK (btrim(display_name) <> '')
);

CREATE UNIQUE INDEX users_email_key ON users (email);

COMMENT ON TABLE users IS
  'Identidade global. EXCECAO documentada a regra "toda tabela tem tenant_id": '
  'a mesma pessoa participa de varias comunidades. O isolamento vive em '
  'memberships e nas tabelas de negocio, nao aqui. Acesso restrito por policy '
  'em 0005.';

-- ---------------------------------------------------------------------------
-- Credenciais — tabela auxiliar, necessaria e separada de `users`.
--
-- POR QUE UMA TABELA SEPARADA:
--   1. O hash de senha nunca entra num SELECT de perfil por acidente: quem le
--      `users` nao le o segredo.
--   2. Permite bloquear a conta por tentativas (locked_until) sem escrever na
--      linha de identidade, que e lida por toda a aplicacao.
--   3. Permite revogar/rotacionar a credencial sem tocar no historico da
--      identidade nem nos vinculos.
-- ---------------------------------------------------------------------------
CREATE TABLE user_credentials (
  user_id             uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  -- Formato: scrypt$N$r$p$<salt_b64>$<hash_b64>. O algoritmo fica gravado na
  -- propria string para permitir rotacao de parametros sem migration.
  password_hash       text NOT NULL,
  password_updated_at timestamptz NOT NULL DEFAULT now(),
  failed_attempts     integer NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_credentials_hash_format CHECK (password_hash LIKE 'scrypt$%'),
  CONSTRAINT user_credentials_failed_attempts_sane CHECK (failed_attempts >= 0)
);

-- ---------------------------------------------------------------------------
-- Segundo fator (TOTP) — tabela auxiliar necessaria para RN12.
--
-- POR QUE EXISTE: RN12 exige MFA para dono, financeiro e Super Admin. O
-- segredo TOTP e material criptografico de longa duracao e precisa de ciclo
-- de vida proprio (cadastrado -> confirmado -> revogado), independente da
-- senha. Guardar isso em `users` misturaria identidade com segredo.
--
-- O segredo e gravado CIFRADO (AES-256-GCM) com chave de aplicacao vinda do
-- ambiente. O banco nunca ve o segredo em claro.
-- ---------------------------------------------------------------------------
CREATE TABLE user_mfa_factors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  factor_type      text NOT NULL DEFAULT 'TOTP',
  secret_encrypted bytea NOT NULL,
  confirmed_at     timestamptz,
  last_used_at     timestamptz,
  /* Contador do ultimo passo TOTP aceito. Impede que o mesmo codigo de 6
     digitos seja reapresentado dentro da mesma janela de 30 s. */
  last_used_step   bigint,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_mfa_factors_type CHECK (factor_type IN ('TOTP'))
);

-- Um fator TOTP confirmado por usuario.
CREATE UNIQUE INDEX user_mfa_factors_one_confirmed
  ON user_mfa_factors (user_id, factor_type) WHERE confirmed_at IS NOT NULL;
CREATE INDEX user_mfa_factors_user_idx ON user_mfa_factors (user_id);

-- ---------------------------------------------------------------------------
-- Sessoes — tabela auxiliar necessaria para logout e revogacao.
--
-- POR QUE TABELA, E NAO JWT AUTOCONTIDO: a fase exige "logout e revogacao", e
-- um token autocontido so deixa de valer quando expira. Com sessao no banco, a
-- revogacao vale na requisicao seguinte.
--
-- O token vai para o cliente em cookie httpOnly; o banco guarda apenas o
-- SHA-256 dele. Vazamento da tabela nao produz um token utilizavel.
--
-- `mfa_satisfied_at` e por SESSAO, nao por usuario: ter o fator cadastrado nao
-- basta: RN12 exige ter passado pelo segundo fator NESTA sessao.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash       bytea NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  revoked_reason   text,
  mfa_satisfied_at timestamptz,
  ip               inet,
  user_agent       text,
  CONSTRAINT sessions_expires_after_creation CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX sessions_user_active_idx
  ON sessions (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Privilegio de plataforma (Super Admin) — concessao EXPLICITA.
--
-- Nenhum papel de comunidade aparece aqui e nenhuma linha desta tabela e
-- criada como efeito colateral de virar dono de uma comunidade.
-- ---------------------------------------------------------------------------
CREATE TABLE platform_admins (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role        platform_role NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  granted_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  revoked_at  timestamptz,
  revoked_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Quem revogou so pode ser registrado se houve revogacao. Revogacao feita
  -- pelo sistema pode ter revoked_by nulo.
  CONSTRAINT platform_admins_revocation_consistent
    CHECK (revoked_by IS NULL OR revoked_at IS NOT NULL)
);

CREATE UNIQUE INDEX platform_admins_active_role
  ON platform_admins (user_id, role) WHERE revoked_at IS NULL;

COMMENT ON TABLE platform_admins IS
  'Privilegio de plataforma concedido um a um. DOC-01 secao 17. Um dono de '
  'comunidade NAO recebe linha aqui automaticamente.';

-- ---------------------------------------------------------------------------
-- Vinculos de equipe. DOC-01 secao 3.
-- ---------------------------------------------------------------------------
CREATE TABLE memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role        membership_role NOT NULL,
  invited_at  timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  revoked_at  timestamptz,
  revoked_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Um mesmo papel nao pode ser concedido duas vezes ao mesmo usuario na mesma
-- comunidade enquanto estiver vigente. Vinculos revogados ficam no historico.
CREATE UNIQUE INDEX memberships_active_role
  ON memberships (tenant_id, user_id, role) WHERE revoked_at IS NULL;
CREATE INDEX memberships_tenant_idx ON memberships (tenant_id);
CREATE INDEX memberships_user_idx ON memberships (user_id) WHERE revoked_at IS NULL;

-- Integridade entre comunidades: a chave composta abaixo permite que toda
-- tabela de negocio das proximas fases referencie (tenant_id, membership_id)
-- em conjunto, impedindo que uma linha da comunidade A aponte para um vinculo
-- da comunidade B. Sem isso, um FK simples por id deixaria o cruzamento passar.
ALTER TABLE memberships
  ADD CONSTRAINT memberships_tenant_scoped_key UNIQUE (tenant_id, id);

ALTER TABLE tenant_domains
  ADD CONSTRAINT tenant_domains_tenant_scoped_key UNIQUE (tenant_id, id);

-- ---------------------------------------------------------------------------
-- updated_at automatico
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenants_touch_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER tenant_branding_touch_updated_at
  BEFORE UPDATE ON tenant_branding
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER users_touch_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER user_credentials_touch_updated_at
  BEFORE UPDATE ON user_credentials
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER memberships_touch_updated_at
  BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
