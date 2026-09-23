# Transição de configuração — 22/09/2026

## Objetivo

Restaurar o funcionamento local após a separação `siteRIFAback` / `siteRIFAfront`, sem recolocar segredos no Git e sem executar DDL ou limpeza no PostgreSQL existente.

## O que foi restaurado localmente

- `.env` privado na raiz do backend, ignorado pelo Git.
- conexões históricas de API, worker e operação administrativa;
- a mesma `MFA_ENCRYPTION_KEY` histórica, sem rotação;
- CA TLS histórica do PostgreSQL gerenciado;
- configuração local de CORS, sessão e seleção de comunidade por cabeçalho;
- frontends locais apontando para `http://localhost:3000` por arquivos ignorados `.env.local`.

As chaves Supabase de Data API/Auth do `.env` antigo **não foram copiadas** para o runtime atual porque o código da plataforma usa PostgreSQL direto e Auth próprio. Manter segredos sem consumidor aumenta superfície de exposição sem benefício.

## O que foi deliberadamente removido

`TEST_MIGRATION_DATABASE_URL`, `TEST_APP_DATABASE_URL` e `TEST_WORKER_DATABASE_URL` do histórico não foram ativados. Eles apontavam para o mesmo alvo físico do banco normal. A suíte de fundação limpa tabelas; reutilizar essas URLs seria destrutivo.

O `vitest.config.ts` agora também recusa iniciar quando um `TEST_*` resolve para o mesmo `host:porta/database` de qualquer URL normal carregada.

## Carregamento de ambiente

API e worker agora chamam `loadRootEnv()` antes de validar configuração. Em hospedagem, o `.env` não existe e as variáveis do serviço continuam prevalecendo (`override: false`). O pacote `@campaigns/db` declara `dotenv` como dependência própria, porque é ele que o importa.

## Produção / staging

Valores reais **não** foram hardcoded em `render.yaml`, `vercel.json` ou arquivos versionados. Os segredos continuam declarados como `sync: false` no Render e precisam existir no painel do serviço.

No frontend, o build/deploy deve definir somente variáveis públicas `VITE_*`. A aplicação rejeita `localhost`/loopback quando executada como bundle de produção, evitando repetir o incidente de chamadas para `localhost:3000` no navegador do usuário.

## Fora desta etapa

PIX, PSP, conciliação, cobrança recorrente, webhooks financeiros e demais funções de pagamento permanecem fora do escopo. Primeiro estabilizar navegação, UX, autenticação/tenant e fluxos existentes.
