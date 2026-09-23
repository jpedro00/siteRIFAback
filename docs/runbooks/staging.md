# Runbook — infraestrutura de staging

Como levantar o ambiente de staging do zero, na ordem em que precisa acontecer.

**Staging não é produção.** É um ambiente descartável, exposto na internet, com
TLS e sem dado real de pessoa nenhuma. Nada aqui descreve produção.

> **Pré-requisito que bloqueia tudo:** Render e Vercel constroem a partir do
> **repositório remoto**. Um commit apenas local não é visível para eles. A
> branch precisa existir no GitHub antes de qualquer provisionamento.

## Hosts

| Papel | Host |
|---|---|
| Vitrine | `staging.<BASE_DOMAIN>` |
| Painel do organizador | `painel.staging.<BASE_DOMAIN>` |
| Console Super Admin | `admin.staging.<BASE_DOMAIN>` |
| API | `api.staging.<BASE_DOMAIN>` |
| Comunidade de teste | `demo.staging.<BASE_DOMAIN>` |

Todos sob o mesmo domínio registrável — é isso que torna a topologia
**same-site** e permite `SameSite=Lax`.

---

## Princípio que organiza tudo abaixo

Três credenciais de banco, três usos que nunca se misturam:

| Credencial | Quem usa | Quando |
|---|---|---|
| `DATABASE_ADMIN_URL` | um operador, da máquina dele | bootstrap, migrations, `queue:install` |
| `DATABASE_URL` | API (`app_user`) | sempre |
| `WORKER_DATABASE_URL` | worker (`app_worker`) | sempre |

O administrativo **nunca** entra num serviço do Render. DDL é ato deliberado,
não efeito colateral de um deploy — inclusive de um rollback.

---

## 1. Banco — Neon

1. Criar um projeto Neon: **`campaigns-staging`**. Região próxima à do Render
   (Oregon / `us-west-2`) — cada milissegundo de latência aqui aparece em toda
   requisição, porque a RLS faz o banco participar de tudo.
2. Anotar a connection string do **dono** → `DATABASE_ADMIN_URL`.
3. Neon exige TLS. Todas as URLs precisam de `?sslmode=require`, e os serviços
   sobem com `DATABASE_SSL=true`.

### Bootstrap, migrations e fila

Da máquina do operador, com `DATABASE_ADMIN_URL` em mãos:

```bash
export ADMIN_DATABASE_URL="<dono>"          # cria banco e papéis
export DATABASE_NAME=campaigns_staging
export APP_DB_PASSWORD="<gerada>"
export WORKER_DB_PASSWORD="<gerada>"

npm run db:bootstrap        # cria app_user e app_worker, restritos

export MIGRATION_DATABASE_URL="<dono>"
npm run db:migrate          # 0001 … 0008

export QUEUE_ADMIN_DATABASE_URL="<dono>"
npm run queue:install -w @campaigns/worker   # schema pgboss, posse do app_worker
```

> Se o Neon não permitir `CREATE DATABASE` no plano usado, aponte
> `ADMIN_DATABASE_URL` direto para o banco já existente e defina
> `DATABASE_NAME` com o nome dele — o bootstrap detecta que já existe e segue
> criando apenas os papéis.

### Conferir antes de prosseguir

```sql
SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
  FROM pg_roles WHERE rolname IN ('app_user','app_worker');
-- os quatro booleanos precisam ser false nos dois papéis

SELECT has_database_privilege('app_worker', current_database(), 'CREATE');
-- precisa ser false: instalar a fila é etapa administrativa

SELECT nspname, pg_get_userbyid(nspowner) FROM pg_namespace
 WHERE nspname IN ('public','app','pgboss');
-- pgboss precisa pertencer a app_worker
```

### A Data API não faz parte desta arquitetura

Provedores que oferecem **Data API** (Supabase REST/GraphQL, PostgREST) criam os
papéis `anon`, `authenticated` e `service_role` e — por padrão — concedem a eles
acesso total sobre toda tabela nova do schema `public`. Não é alguém que ligou:
vem dos *default privileges* do papel que roda as migrations.

O RIFAS **não usa** esse caminho:

```text
navegador → API RIFAS (app_user) → PostgreSQL
worker    →           (app_worker) → PostgreSQL
```

A migration `0009` revoga o acesso desses três papéis e corrige os *default
privileges*, para que a primeira tabela da Fase 2 não recrie o problema em
silêncio. Três coisas que a RLS **não** resolveria sozinha e por isso dependem
do GRANT:

- `schema_migrations` não tem policy — o histórico ficaria legível e gravável;
- **`TRUNCATE` não passa por RLS**: nenhuma policy impede esvaziar `tenants`;
- **`service_role` tem `BYPASSRLS`** — para ele, toda a RLS seria decorativa.

A proteção vive no **banco**, não numa configuração de painel que outra pessoa
pode religar. Desligar a Data API no painel é opcional e não substitui isto.

Se um dia a Data API entrar na arquitetura, o caminho é conceder explicitamente
o que aquele fluxo precisa — tabela a tabela, com policy própria —, nunca
restaurar o padrão amplo.

### Provar a RLS no banco gerenciado

Migration aplicada não é prova de isolamento. Rodar a suíte contra o Neon:

```bash
export TEST_MIGRATION_DATABASE_URL="<dono>"
export TEST_APP_DATABASE_URL="<app_user>"
export TEST_WORKER_DATABASE_URL="<app_worker>"

npx vitest run packages/db/tests apps/api/tests apps/worker/tests
```

As suítes de isolamento conectam com o papel **real** da aplicação. Testar RLS
como dono não prova nada: o dono ignora as policies.

---

## 2. API — Render

O repositório traz [`render.yaml`](../../render.yaml), um Blueprint. Criar o
serviço a partir dele (Render → New → Blueprint) em vez de preencher o painel à
mão: a configuração passa a ser revisável e recriável.

Variáveis marcadas `sync: false` são pedidas na criação e guardadas cifradas:

```text
DATABASE_URL           app_user (nunca o dono)
DATABASE_CA_CERT       CA raiz do provedor, em PEM — PÚBLICA, não é segredo
MFA_ENCRYPTION_KEY     node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
CORS_ORIGINS           preencher depois do passo 4
APP_BASE_DOMAIN        staging.<BASE_DOMAIN>
```

### Por que a CA precisa ser informada

Provedores gerenciados assinam o certificado do banco com uma raiz **própria**,
que não está na lista de CAs públicas que o Node confia — o Supabase usa a
`Supabase Root 2021 CA`. Sem informá-la, toda conexão falha com
`SELF_SIGNED_CERT_IN_CHAIN`.

A saída tentadora, nesse ponto, é desligar `rejectUnauthorized`. Isso manteria a
conexão cifrada e jogaria fora a única coisa que prova **com quem** se está
falando — exatamente o que um intermediário precisa. O certificado é público:
informá-lo custa uma variável e preserva a garantia.

O mesmo valor vai para a API e para o worker.

`CORS_ORIGINS` só existe depois que o Vercel devolver as URLs. Deixar em branco
faz a API **recusar subir** em staging, de propósito — uma API sem allowlist
não conversa com painel nenhum, e falhar na subida é melhor do que descobrir
isso pelo navegador.

Healthcheck: `/api/health`. Responde 200 mesmo com o banco fora, informando
`database: "down"` — quem observa precisa distinguir "API fora" de "API no ar,
banco fora".

---

## 3. Worker — Render

Mesmo Blueprint, serviço `campaigns-worker-staging`, tipo `worker`.

```text
WORKER_DATABASE_URL    app_worker
QUEUE_DATABASE_URL     app_worker (mesmo papel; o schema pgboss é dele)
```

A fila **precisa** ter sido instalada no passo 1. Se não tiver, o worker recusa
subir com a instrução do que fazer, em vez de tropeçar num `permission denied
for database` cru.

---

## 4. Frontends — Vercel

**Três projetos separados**, o mesmo repositório, Root Directory diferente. Não
unificar: são três aplicações, com públicos e superfícies de ataque diferentes.

| Projeto | Root Directory |
|---|---|
| `campaigns-storefront-staging` | `apps/storefront` |
| `campaigns-organizer-staging` | `apps/organizer` |
| `campaigns-admin-staging` | `apps/admin` |

Build e output vêm do `vercel.json` de cada app; não há o que preencher no
painel além do Root Directory.

Variável, em cada projeto — **a única**, e pública:

```text
VITE_API_BASE_URL = https://api.staging.<BASE_DOMAIN>
```

Enquanto o DNS não estiver ativo, aponte para a URL temporária do Render e
refaça o deploy depois — o valor é embutido no pacote em tempo de build, então
trocá-lo exige novo build.

O Vite **embute** tudo que começa com `VITE_` no pacote entregue ao navegador.
Nenhum segredo, em hipótese alguma.

---

## 5. Domínios, CORS e cookies

### DNS

| Host | Aponta para |
|---|---|
| `staging` | Vercel — storefront |
| `painel.staging` | Vercel — organizer |
| `admin.staging` | Vercel — admin |
| `demo.staging` | Vercel — storefront (mesma aplicação) |
| `api.staging` | Render — API |

Cada provedor informa o registro exato (`CNAME`, ou `A`/`ALIAS` no ápice) ao
adicionar o domínio no painel. Emissão de TLS costuma levar alguns minutos.

### CORS

Com o DNS ativo, na API:

```text
CORS_ORIGINS = https://staging.<BASE_DOMAIN>,https://painel.staging.<BASE_DOMAIN>,https://admin.staging.<BASE_DOMAIN>,https://demo.staging.<BASE_DOMAIN>
APP_BASE_DOMAIN = staging.<BASE_DOMAIN>
```

Remover qualquer URL temporária de `*.vercel.app` que não precise continuar
autorizada. Sem curinga: `*` é incompatível com `credentials: include`.

**Same-site não é same-origin.** Os quatro hosts compartilham o domínio
registrável, mas cada um é uma origem distinta — CORS continua obrigatório em
toda chamada.

### Cookies

```text
SESSION_COOKIE_SECURE   = true
SESSION_COOKIE_SAMESITE = lax
```

`api.staging.<BASE_DOMAIN>` e `painel.staging.<BASE_DOMAIN>` têm o mesmo
domínio registrável, logo são **same-site** — e um cookie `Lax` **é** enviado
no `fetch` entre eles. `None` só seria necessário com domínios registráveis
diferentes (`*.vercel.app` × `*.onrender.com`, porque `vercel.app` está na
Public Suffix List). Com domínio próprio, `Lax` mantém a proteção contra POST
vindo de um site externo, e não há motivo para abrir mão dela.

O cookie é **host-only**: nenhum atributo `Domain` é definido, então ele
pertence exclusivamente a `api.staging.<BASE_DOMAIN>`. Um
`Domain=.staging.<BASE_DOMAIN>` o entregaria a todo subdomínio, inclusive a um
que venha a ser comprometido — alcance maior sem nenhuma necessidade. Os
frontends não leem o cookie: ele é `HttpOnly`.

### Resolução de comunidade — limitação conhecida

Quando `demo.staging.<BASE_DOMAIN>` chama `api.staging.<BASE_DOMAIN>`, a API
recebe a requisição no **próprio** hostname. Usar subdomínios **não** faz o
`Host` carregar a comunidade.

```text
STAGING    cabeçalho x-tenant-slug permitido, para comunidades descartáveis
PRODUÇÃO   arquitetura de resolução por domínio ainda precisa ser fechada
           antes do lançamento
```

O cabeçalho escolhe **qual** comunidade; nunca concede privilégio. Toda rota
autenticada continua conferindo o vínculo no PostgreSQL. A configuração
**recusa** este valor em produção.

---

## 6. Primeiro Super Admin

Não há rota que crie o primeiro — seria escalada de privilégio aberta na
internet. Pelo banco, com a credencial administrativa:

```sql
INSERT INTO users (email, display_name)
VALUES ('voce@example.com', 'Seu Nome') RETURNING id;

INSERT INTO platform_admins (user_id, role)
VALUES ('<id acima>', 'PLATFORM_OPERATIONS');
```

A credencial precisa existir em `user_credentials` com hash `scrypt$…` gerado
por `hashPassword()`:

```bash
node -e "
  const { hashPassword } = await import('./apps/api/dist/lib/password.js');
  console.log(await hashPassword(process.argv[1]));
" '<senha>'
```

No primeiro login o console exige o cadastro do segundo fator: **RN12 não tem
escape**.

---

## 7. Verificação de aceite

### Banco
- [ ] `app_user` e `app_worker` com `rolsuper=false`, `rolbypassrls=false`
- [ ] `app_worker` **não** consegue criar schema
- [ ] `pgboss` pertence a `app_worker`
- [ ] suíte de isolamento verde contra o Neon

### API
- [ ] `/api/health` → `{"status":"ok","database":"up"}`
- [ ] origem da allowlist → 200 com `Access-Control-Allow-Origin`
- [ ] origem desconhecida → **403**
- [ ] preflight `OPTIONS` da allowlist → 204
- [ ] login → `Set-Cookie` com `HttpOnly; Secure; SameSite=None`
- [ ] variável obrigatória ausente → a API **não sobe**

### Worker
- [ ] log de subida com o schema da fila
- [ ] evento na outbox → `published_at` → `event_consumptions` → efeito
- [ ] reentrega do mesmo evento → **um** efeito
- [ ] evento que falha além do limite → `dead_lettered_at`, sem voltar ao ciclo
- [ ] redeploy → `SIGTERM` → relay para, fila para, pool fecha

### Frontends
- [ ] os três abrem sem erro no console
- [ ] login e sessão preservada após refresh
- [ ] MFA rotaciona o token; o antigo devolve 401
- [ ] API fora → estado `unavailable`, **não** tela de login
- [ ] logout revoga a sessão

### Auditoria
- [ ] `auth.login.succeeded`, `auth.login.failed`, `auth.logout`,
      `auth.mfa.*`, `auth.account_locked` presentes
- [ ] nenhum segredo em `before`/`after`
- [ ] eventos de identidade **não** aparecem em `/api/tenant/audit-events`

---

## O que NÃO entra nesta rodada

Mercado Pago, Vindi, WhatsApp, e-mail real, Cloudflare R2, domínio próprio,
DNS final, GA4, Meta Pixel, sorteios, cativos, pagamentos. Nada de Fase 2.
