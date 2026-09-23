-- ============================================================================
-- 0009 · Fechar a superficie da Data API
--
-- Modulo: M01 · M12
-- Regras: RN01 (isolamento entre comunidades)
--
-- O QUE FOI ENCONTRADO, e por que importa
--
-- Num PostgreSQL gerenciado pelo Supabase, o papel que roda as migrations
-- (`postgres`) tem DEFAULT PRIVILEGES no schema `public` que concedem
-- `arwdDxtm` — tudo — sobre TODA tabela nova para `anon`, `authenticated` e
-- `service_role`. Nao e algo que alguem ligou: e o padrao do provedor, pensado
-- para quem usa a Data API (PostgREST/GraphQL) como caminho da aplicacao.
--
-- Esta plataforma NAO usa a Data API. O caminho e:
--
--   navegador -> API RIFAS (app_user) -> PostgreSQL
--   worker    -> (app_worker)         -> PostgreSQL
--
-- Entao as 13 tabelas da fundacao nasceram com acesso total concedido a tres
-- papeis que nenhum fluxo do sistema usa.
--
-- POR QUE A RLS NAO RESOLVIA ISSO SOZINHA
--
--   1. `schema_migrations` nao tem RLS — o historico de migrations estava
--      legivel e GRAVAVEL pela Data API;
--   2. TRUNCATE NAO PASSA POR RLS. Nenhuma policy impede um papel com esse
--      privilegio de esvaziar `tenants`, `users` ou `sessions`;
--   3. `service_role` tem BYPASSRLS. Para ele, toda a RLS desta fundacao e
--      decorativa — ele enxerga e altera qualquer comunidade.
--
-- O terceiro item e o mais grave, e e o motivo de `service_role` entrar aqui
-- junto de `anon` e `authenticated`: revogar os dois papeis fracos e deixar
-- intacto o unico que ignora a RLS inverteria a prioridade.
--
-- O QUE ESTA MIGRATION NAO FAZ
--
--   * nao altera nada de `app_user` e `app_worker` — os GRANTs de 0006 e as
--     policies de 0005/0007 continuam exatamente como estao;
--   * nao toca no schema `pgboss` nem nas tabelas do pg-boss: `anon` e
--     `authenticated` ja nao tem USAGE nesse schema, e mexer ali quebraria a
--     fila para silenciar um aviso generico;
--   * nao remove `USAGE` no schema `public` de `anon`/`authenticated`: sem
--     privilegio em objeto nenhum, `USAGE` sozinho nao da acesso a nada, e
--     revoga-lo pode atrapalhar componentes internos do provedor;
--   * nao desliga a Data API no painel. A protecao precisa valer no BANCO,
--     independentemente de configuracao externa que outra pessoa pode religar.
--
-- REVERSIBILIDADE: se um dia a Data API passar a fazer parte da arquitetura,
-- o caminho e conceder explicitamente o que aquele fluxo precisa — tabela a
-- tabela, com policy propria —, nunca restaurar o padrao amplo.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- POR QUE TUDO ABAIXO E CONDICIONAL
--
-- `anon`, `authenticated` e `service_role` sao papeis do SUPABASE. Num
-- PostgreSQL proprio — a maquina de quem desenvolve, o container do CI — eles
-- simplesmente nao existem, e um `REVOKE ... FROM anon` derrubaria a migration
-- com `role "anon" does not exist`.
--
-- A migration precisa descrever a mesma INTENCAO nos dois lugares: "estes
-- papeis, se existirem, nao tem acesso". Onde eles nao existem, nao ha o que
-- fazer — e isso nao e uma excecao, e a mesma regra com o conjunto vazio.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  papel text;
  -- Papeis da Data API do Supabase. Nenhum deles participa de nenhum fluxo
  -- desta plataforma.
  papeis constant text[] := ARRAY['anon', 'authenticated', 'service_role'];
  encontrados text[] := ARRAY[]::text[];
BEGIN
  FOREACH papel IN ARRAY papeis LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = papel) THEN
      encontrados := encontrados || papel;

      -- 1. Tabelas, sequencias e funcoes que JA existem.
      --    `ALTER DEFAULT PRIVILEGES` (passo 2) so alcanca o que for criado
      --    DEPOIS dele; as 13 tabelas da fundacao ja nasceram.
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', papel);
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', papel);
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM %I', papel);

      -- 2. Tabelas FUTURAS.
      --    Sem isto, a primeira tabela da Fase 2 recriaria o problema — e em
      --    silencio, porque ninguem teria escrito GRANT nenhum: o privilegio
      --    viria do padrao do provedor.
      --
      --    Sem `FOR ROLE`, vale para o papel que EXECUTA este comando, que e o
      --    mesmo que aplica as migrations e cria as tabelas. E esse o padrao
      --    que precisa mudar.
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM %I',
        papel);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM %I',
        papel);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON FUNCTIONS FROM %I',
        papel);
    END IF;
  END LOOP;

  IF array_length(encontrados, 1) IS NULL THEN
    RAISE NOTICE 'Nenhum papel da Data API presente: nada a revogar (PostgreSQL proprio).';
  ELSE
    RAISE NOTICE 'Acesso da Data API revogado para: %', array_to_string(encontrados, ', ');
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. `schema_migrations` — RLS como segunda barreira
--
-- Com o passo 1, nenhum desses papeis tem privilegio aqui, e so isso ja fecha o
-- acesso. A RLS entra como defesa em profundidade: sem NENHUMA policy, a tabela
-- nega tudo a qualquer papel que nao seja o dono. Se um GRANT for restaurado
-- por engano numa migration futura, o acesso continua negado.
--
-- Nao quebra o migrador: ele conecta com o DONO da tabela, e o dono nao sofre
-- RLS (nao usamos FORCE ROW LEVEL SECURITY, justamente para preservar isso).
--
-- Nao e "ligar RLS para calar o alerta": sem grants, o alerta ja nao descreve
-- superficie exposta. Isto aqui vale por si.
-- ---------------------------------------------------------------------------
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE schema_migrations IS
  'Historico de migrations. Tabela INTERNA do migrador: nenhum papel de '
  'aplicacao le ou escreve aqui. RLS ativa sem policy = nega tudo exceto ao '
  'dono, que e quem aplica as migrations.';
