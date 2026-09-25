-- ===========================================================================
-- 0011 · Conta do participante: o pedido passa a saber de quem e
-- ---------------------------------------------------------------------------
-- O QUE FALTAVA. `orders` ligava-se a `buyers`, que e um retrato do comprador
-- DENTRO de uma comunidade: nome, telefone e e-mail copiados no ato da compra.
-- Serve ao historico e ao organizador, e nao serve a conta: a mesma pessoa
-- comprando em duas comunidades vira duas linhas de `buyers` sem nada que as
-- ligue. A identidade global ja existe em `users`; o pedido e que nao a
-- alcancava.
--
-- A COLUNA E NULA DE PROPOSITO. `user_id IS NULL` significa compra sem conta,
-- que continua sendo um caminho de primeira classe — a pessoa escolhe numeros,
-- informa contato e leva o comprovante, sem cadastro. Preencher a coluna
-- depois, casando `buyers.email` com `users.email`, seria entregar um pedido a
-- quem apenas registrou o mesmo endereco. Reivindicar pedido antigo exige
-- prova de posse e tera fluxo proprio; ate la, guest permanece guest.
--
-- O SNAPSHOT NAO SAI. `buyers` continua sendo a verdade historica do pedido.
-- Trocar o nome no perfil amanha nao pode reescrever o comprovante de ontem.
-- As duas informacoes convivem: `buyers` diz quem comprou naquele dia,
-- `user_id` diz a qual conta aquilo pertence.
-- ===========================================================================

ALTER TABLE orders
  ADD COLUMN user_id uuid REFERENCES users (id) ON DELETE SET NULL;

COMMENT ON COLUMN orders.user_id IS
  'Conta global dona do pedido. NULL = compra sem conta (guest). Nunca '
  'preenchido por correspondencia de e-mail: so pela sessao autenticada no '
  'momento da compra.';

-- Padrao de acesso da conta: "meus pedidos, mais recentes primeiro". O indice
-- parcial deixa de fora as compras guest, que sao a maioria e nunca aparecem
-- nessa consulta.
CREATE INDEX orders_user_recent_idx
  ON orders (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS: o dono le o proprio pedido, em qualquer comunidade
-- ---------------------------------------------------------------------------
-- `orders_select` exige `tenant_id = app.current_tenant_id()`, e esta certo
-- para o organizador. A conta e outra pergunta: atravessa comunidades por
-- definicao, e uma pessoa que participa de tres comunidades nao tem UMA
-- comunidade corrente.
--
-- Politicas permissivas se somam (OR), entao esta ABRE um caminho novo sem
-- afrouxar o existente: quem nao for o dono continua sujeito ao filtro de
-- comunidade. A condicao e `user_id = app.current_user_id()`, e o `user_id` da
-- sessao nunca vem do cliente — e gravado pelo `withUser`/`withTenant` a partir
-- do token validado.
CREATE POLICY orders_select_own ON orders FOR SELECT
  USING (user_id IS NOT NULL AND user_id = app.current_user_id());

-- ---------------------------------------------------------------------------
-- Projecao da conta
-- ---------------------------------------------------------------------------
-- POR QUE UMA FUNCAO, E NAO MAIS POLITICAS. A tela da conta mostra, por
-- pedido, o titulo do sorteio e o nome da comunidade. Chegar la por RLS
-- exigiria abrir `draws` e `tenants` para leitura fora do contexto de
-- comunidade — alargar duas superficies para resolver uma consulta.
--
-- A funcao inverte isso: uma unica entrada, com as colunas exatas que a tela
-- usa. E o mesmo padrao que 0005 ja emprega para resolver comunidade por
-- dominio e validar token de sessao — SECURITY DEFINER de projecao minima,
-- justamente nos pontos que precisam existir antes ou fora do contexto.
--
-- NAO RECEBE IDENTIDADE. Nao ha parametro de usuario: a funcao le
-- `app.current_user_id()` de dentro. Quem chama nao consegue pedir os pedidos
-- de outra pessoa, porque nao ha onde dizer de quem. Sem sessao, devolve vazio.
--
-- PAGINACAO POR KEYSET. `(created_at, id)` como cursor, e nao OFFSET: a lista
-- cresce pela frente, e offset repetiria ou pularia linhas entre uma pagina e
-- outra. O `id` desempata criacoes no mesmo instante.
CREATE OR REPLACE FUNCTION app.account_orders(
  p_limit        integer,
  p_before_at    timestamptz DEFAULT NULL,
  p_before_id    uuid        DEFAULT NULL
)
RETURNS TABLE (
  order_id         uuid,
  status           order_status,
  quantity         integer,
  unit_price_cents integer,
  total_cents      integer,
  created_at       timestamptz,
  paid_at          timestamptz,
  numbers          integer[],
  label_digits     integer,
  draw_slug        text,
  draw_title       text,
  tenant_slug      text,
  tenant_name      text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    o.id,
    o.status,
    o.quantity,
    o.unit_price_cents,
    o.total_cents,
    o.created_at,
    o.paid_at,
    coalesce(
      (SELECT array_agg(oi.number ORDER BY oi.number)
         FROM order_items oi
        WHERE oi.order_id = o.id),
      ARRAY[]::integer[]
    ),
    CASE WHEN d.total_numbers > 100 THEN 3 ELSE 2 END,
    d.slug,
    d.title,
    t.slug,
    t.name
  FROM orders o
  JOIN draws   d ON d.tenant_id = o.tenant_id AND d.id = o.draw_id
  JOIN tenants t ON t.id = o.tenant_id
  WHERE o.user_id IS NOT NULL
    AND o.user_id = app.current_user_id()
    AND (
      p_before_at IS NULL
      OR (o.created_at, o.id) < (p_before_at, coalesce(p_before_id, '00000000-0000-0000-0000-000000000000'::uuid))
    )
  ORDER BY o.created_at DESC, o.id DESC
  LIMIT greatest(1, least(coalesce(p_limit, 20), 100));
$$;

COMMENT ON FUNCTION app.account_orders(integer, timestamptz, uuid) IS
  'Pedidos da conta autenticada, em todas as comunidades. Le o usuario de '
  'app.current_user_id(); nao aceita identidade por parametro.';

REVOKE ALL ON FUNCTION app.account_orders(integer, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.account_orders(integer, timestamptz, uuid) TO app_user;

-- ---------------------------------------------------------------------------
-- Cadastro do participante
-- ---------------------------------------------------------------------------
-- POR QUE ISTO NAO E UM INSERT COMUM. `users_insert` exige
-- `app.has_platform_access()`, e `app_user` nao tem GRANT de tabela sobre
-- `users` nem `user_credentials` — essas tabelas so sao alcancadas por funcao.
-- Nao e um obstaculo a contornar: e a decisao de 0005/0006 de que identidade
-- nao se escreve pelo caminho comum.
--
-- Quem se cadastra ainda nao tem sessao, entao nao existe contexto de usuario
-- para uma politica avaliar. E a mesma situacao de `find_login_credential` e
-- `record_login_attempt`, e a resposta e a mesma: funcao de escopo minimo, com
-- a regra escrita dentro.
--
-- A FUNCAO NAO VE SENHA. Recebe o hash pronto. O `scrypt` continua em
-- `lib/password.ts`, com os parametros de custo num lugar so; o banco nunca
-- toca no texto claro e nao tem como registra-lo por engano.
--
-- DUAS LINHAS, UMA TRANSACAO. Conta sem credencial seria uma conta pela qual
-- ninguem entra, e ocuparia o e-mail para sempre. A funcao e atomica por
-- construcao; o indice unico `users_email_key` decide a corrida entre dois
-- cadastros simultaneos, e o chamador traduz isso para conflito de negocio.
CREATE OR REPLACE FUNCTION app.register_participant(
  p_email         text,
  p_display_name  text,
  p_password_hash text
)
RETURNS TABLE (user_id uuid, email text, display_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_email text := lower(btrim(p_email));
  v_id    uuid;
BEGIN
  IF p_password_hash IS NULL OR p_password_hash NOT LIKE 'scrypt$%' THEN
    RAISE EXCEPTION 'hash de senha em formato inesperado'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO users (email, display_name)
  VALUES (v_email, btrim(p_display_name))
  RETURNING id INTO v_id;

  INSERT INTO user_credentials (user_id, password_hash)
  VALUES (v_id, p_password_hash);

  RETURN QUERY SELECT v_id, v_email, btrim(p_display_name);
END;
$$;

COMMENT ON FUNCTION app.register_participant(text, text, text) IS
  'Cria conta global + credencial numa transacao. Recebe o hash pronto; nunca '
  've a senha em texto claro. Nao concede papel de comunidade nem de '
  'plataforma: participar nao e administrar.';

REVOKE ALL ON FUNCTION app.register_participant(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.register_participant(text, text, text) TO app_user;

-- ---------------------------------------------------------------------------
-- Dono na criacao da comunidade
-- ---------------------------------------------------------------------------
-- O Super Admin cria a comunidade com `app.has_platform_access()`, e as
-- politicas de `memberships` ja permitem essa escrita. O que faltava nao era
-- permissao: era o passo. Fica no serviço, dentro da MESMA transacao da
-- criacao — ver `tenantRoutes.platformCreateTenant`.
--
-- Esta funcao existe para o outro lado do problema: achar a conta do dono pelo
-- e-mail. `users_select` so deixa o Super Admin ver quem ele ja administra, e
-- procurar por e-mail antes de existir vinculo cairia fora dessa politica.
-- Projecao minima: confirma que a conta existe e devolve o id, nada mais.
CREATE OR REPLACE FUNCTION app.find_user_by_email(p_email text)
RETURNS TABLE (user_id uuid, email text, display_name text, status user_status)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.email, u.display_name, u.status
    FROM users u
   WHERE u.email = lower(btrim(p_email));
$$;

COMMENT ON FUNCTION app.find_user_by_email(text) IS
  'Localiza conta por e-mail para provisionar dono de comunidade. Projecao '
  'minima; nao expoe credencial, sessao nem vinculo.';

REVOKE ALL ON FUNCTION app.find_user_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.find_user_by_email(text) TO app_user;
