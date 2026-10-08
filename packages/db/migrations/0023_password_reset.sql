-- 0023 · recuperacao de senha.
--
-- A identidade e GLOBAL (uma pessoa, uma conta): a recuperacao tambem. Nao ha fluxo por
-- tipo de usuario (participante, dono, equipe, Super Admin).
--
-- O token NUNCA e gravado: so o SHA-256 dele. Quem le esta tabela nao consegue redefinir a
-- senha de ninguem. A tabela nao tem policy e nenhum papel da aplicacao tem GRANT: todo
-- acesso passa pelas duas funcoes SECURITY DEFINER abaixo, que sao o unico caminho.
--
-- Nao altera nenhuma migration anterior.

CREATE TABLE public.password_reset_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  revoked_at timestamptz,
  CONSTRAINT password_reset_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT password_reset_expires_after_creation CHECK (expires_at > created_at),
  CONSTRAINT password_reset_state_exclusive CHECK (used_at IS NULL OR revoked_at IS NULL)
);

CREATE UNIQUE INDEX password_reset_tokens_hash_key ON public.password_reset_tokens (token_hash);
-- Tokens ainda utilizaveis de uma conta: invalidados a cada novo pedido.
CREATE INDEX password_reset_tokens_open_idx
  ON public.password_reset_tokens (user_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;

ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.password_reset_tokens FROM PUBLIC, app_user, app_worker;

-- ---------------------------------------------------------------------------
-- Pedido. Devolve a conta SOMENTE quando um token foi de fato criado; qualquer outro caso
-- (e-mail inexistente, conta inativa, sem senha, pedido recente demais) devolve zero linhas,
-- e a API responde igual nos dois casos (nao ha enumeracao).
--
-- Cria o token e invalida, na mesma transacao, os anteriores ainda utilizaveis.
-- `p_cooldown_seconds` evita transformar o endpoint em disparador de e-mails.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.request_password_reset(
  p_email            text,
  p_token_hash       text,
  p_ttl_minutes      integer,
  p_cooldown_seconds integer
)
RETURNS TABLE (user_id uuid, email text, display_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  usr public.users%ROWTYPE;
BEGIN
  IF p_ttl_minutes IS NULL OR p_ttl_minutes < 1 OR p_ttl_minutes > 1440 THEN
    RAISE EXCEPTION 'validade do token invalida' USING ERRCODE = '22023';
  END IF;

  SELECT u.* INTO usr
    FROM public.users u
    JOIN public.user_credentials c ON c.user_id = u.id
   WHERE u.email = lower(btrim(p_email)) AND u.status = 'ACTIVE'
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF p_cooldown_seconds > 0 AND EXISTS (
    SELECT 1 FROM public.password_reset_tokens t
     WHERE t.user_id = usr.id
       AND t.created_at > now() - make_interval(secs => p_cooldown_seconds)
  ) THEN
    RETURN;
  END IF;

  UPDATE public.password_reset_tokens t
     SET revoked_at = now()
   WHERE t.user_id = usr.id AND t.used_at IS NULL AND t.revoked_at IS NULL;

  INSERT INTO public.password_reset_tokens (user_id, token_hash, expires_at)
  VALUES (usr.id, p_token_hash, now() + make_interval(mins => p_ttl_minutes));

  RETURN QUERY SELECT usr.id, usr.email, usr.display_name;
END;
$$;

-- ---------------------------------------------------------------------------
-- Redefinicao. Uso unico, validade, conta ativa. Qualquer falha devolve zero linhas (a API
-- responde a mesma coisa para token desconhecido, usado, revogado ou vencido).
--
-- O hash da senha NOVA chega pronto (scrypt, calculado pela API com a mesma rotina do
-- cadastro e do login); o banco so confere o formato. Na mesma transacao:
--   * grava o hash e zera tentativas e bloqueio;
--   * marca o token como usado e invalida os demais tokens da conta;
--   * REVOGA todas as sessoes abertas da conta.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.reset_password(p_token_hash text, p_new_password_hash text)
RETURNS TABLE (user_id uuid, revoked_sessions integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  tok       public.password_reset_tokens%ROWTYPE;
  n_revoked integer;
BEGIN
  IF p_new_password_hash IS NULL OR p_new_password_hash NOT LIKE 'scrypt$%' THEN
    RAISE EXCEPTION 'formato de hash de senha invalido' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO tok FROM public.password_reset_tokens WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND
     OR tok.used_at IS NOT NULL
     OR tok.revoked_at IS NOT NULL
     OR tok.expires_at <= now() THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = tok.user_id AND u.status = 'ACTIVE') THEN
    RETURN;
  END IF;

  UPDATE public.user_credentials c
     SET password_hash = p_new_password_hash,
         password_updated_at = now(),
         failed_attempts = 0,
         locked_until = NULL,
         updated_at = now()
   WHERE c.user_id = tok.user_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.password_reset_tokens SET used_at = now() WHERE id = tok.id;
  UPDATE public.password_reset_tokens t
     SET revoked_at = now()
   WHERE t.user_id = tok.user_id AND t.id <> tok.id AND t.used_at IS NULL AND t.revoked_at IS NULL;

  UPDATE public.sessions s
     SET revoked_at = now(), revoked_reason = 'password_reset'
   WHERE s.user_id = tok.user_id AND s.revoked_at IS NULL;
  GET DIAGNOSTICS n_revoked = ROW_COUNT;

  RETURN QUERY SELECT tok.user_id, n_revoked;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.request_password_reset(text, text, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.reset_password(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.request_password_reset(text, text, integer, integer) TO app_user;
GRANT EXECUTE ON FUNCTION app.reset_password(text, text) TO app_user;
