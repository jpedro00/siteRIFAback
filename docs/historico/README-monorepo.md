# Plataforma de Campanhas & Comunidades

SaaS multi-tenant e white-label de sorteios e campanhas. Cada comunidade opera
a própria marca, domínio, equipe e sorteios, com isolamento de dados.

**Estado atual: Fase 1 — Fundação.**
Não há sorteio, reserva, pagamento, imagem, apuração nem cliente cativo. Esses
módulos pertencem às fases seguintes. O que existe aqui é a base que eles vão
usar: isolamento por comunidade, identidade, permissões, auditoria e outbox.

---

## Índice

- [Estrutura](#estrutura)
- [O que a Fase 1 entrega](#o-que-a-fase-1-entrega)
- [Setup local](#setup-local)
- [Rodar](#rodar)
- [Testes](#testes)
- [Rotas](#rotas)
- [Trilha de auditoria (RN11)](#trilha-de-auditoria-rn11)
- [Documentos](#documentos)

---

## Estrutura

```
apps/
  api/          API HTTP (Express). Conecta com o papel restrito app_user.
  worker/       Relay da outbox + consumidores (pg-boss). Entrada: src/worker.ts.
  storefront/   Vitrine do participante (React + Vite).
  organizer/    Painel do organizador (React + Vite).
  admin/        Console Super Admin (React + Vite).
packages/
  shared/       Constantes protegidas, estados, permissões, contratos de rota.
  db/           Migrations versionadas, pool e contexto transacional de tenant.
docs/
  decisions/    Decisões e suposições da fase.
```

Os módulos **M01–M12** vivem em `apps/api/src/modules/`. Esta fase implementa
apenas **M01** (identidade, comunidade e permissões) e **M12** (auditoria e
observabilidade). As pastas dos demais módulos **não foram criadas**: pasta
vazia sugere trabalho que não existe.

---

## O que a Fase 1 entrega

| Área | Estado |
|---|---|
| Migrations versionadas com RLS | ✅ |
| Isolamento por comunidade, com o papel real da aplicação | ✅ |
| Identidade global + vínculos por comunidade | ✅ |
| Autenticação (senha + sessão + logout + revogação) | ✅ |
| MFA obrigatório para dono, financeiro e Super Admin (RN12) | ✅ |
| Matriz de permissões do DOC-01 §3, aplicada no backend | ✅ |
| Resolução de comunidade por domínio ou slug | ✅ |
| Auditoria somente-inserção (RN11), inclusive da identidade | ✅ |
| Outbox transacional + relay + consumidor idempotente (RN21) | ✅ |
| Três frontends React com sessão, contexto e controle de acesso | ✅ |
| Fila real (pg-boss) exercitada de ponta a ponta | ✅ |
| Dead-letter da outbox: evento esgotado sai do fluxo | ✅ |
| Constantes protegidas com teste que falha se mudarem | ✅ |
| CI com lint, typecheck, testes e build | ✅ |

**Fora do escopo desta fase** (e não simulado em lugar nenhum): pagamentos,
reservas, imagens, apuração, automações comerciais e clientes cativos.

---

## Setup local

### Pré-requisitos

- Node.js **22+**
- PostgreSQL **17** (local, Docker ou Neon)

### 1. Dependências

```bash
npm install
```

### 2. Variáveis de ambiente

```bash
cp .env.example .env
```

Gere a chave de cifragem dos segredos TOTP e cole em `MFA_ENCRYPTION_KEY`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Preencha também `ADMIN_DATABASE_URL`, `APP_DB_PASSWORD` e `WORKER_DB_PASSWORD`.

> **Três papéis, de propósito.** `ADMIN_*` é superusuário e roda só o
> bootstrap. `MIGRATION_*` é dono do schema e roda as migrations. `DATABASE_URL`
> é o papel restrito `app_user`, com que a API roda — e é por isso que a RLS
> vale de verdade: `app_user` não é dono das tabelas e não tem `BYPASSRLS`.

### 3. Compilar os pacotes compartilhados

`api`, `worker` e os frontends importam tipos de `@campaigns/shared` e
`@campaigns/db`. Sem este passo, o typecheck não encontra as declarações.

```bash
npm run build -w @campaigns/shared
npm run build -w @campaigns/db
```

### 4. Banco: bootstrap e migrations

```bash
npm run db:bootstrap   # cria o banco e os papéis restritos app_user e app_worker
npm run db:migrate     # aplica as migrations
npm run queue:install -w @campaigns/worker   # cria o schema da fila (pg-boss)
```

**Por que a fila tem um passo próprio.** O pg-boss cria o próprio schema ao
subir, e `CREATE SCHEMA IF NOT EXISTS` exige privilégio de criação **no banco**
— mesmo quando o schema já existe, porque o PostgreSQL confere o privilégio
antes de considerar o `IF NOT EXISTS`. Deixar o worker fazer isso obrigaria a
dar esse privilégio a um processo que roda continuamente, por um comando que
ele só precisaria uma vez na vida.

O instalador roda com o papel administrativo, cria os objetos e **transfere a
posse** para `app_worker`. Depois disso o worker administra a própria fila sem
nenhum privilégio de DDL no banco — e continua sem poder criar schema, sem
`BYPASSRLS` e sem acesso às tabelas de negócio além do que a `0006` concede.
Se a fila não estiver instalada, o worker recusa subir dizendo exatamente isso.

O bootstrap fica fora das migrations de propósito: criar papel exige privilégio
administrativo e envolve **senha** — e senha não entra em arquivo versionado.

As migrations recusam rodar se `app_user` e `app_worker` não existirem. Sem
isso, a aplicação se conectaria como dono do schema e a RLS seria silenciosamente
inofensiva.

### 5. Banco de teste

Os testes de isolamento precisam de um banco **separado** — a suíte apaga dados.

```bash
# Bash
DATABASE_NAME=campaigns_test npm run db:bootstrap
MIGRATION_DATABASE_URL="postgres://postgres:SENHA@localhost:5432/campaigns_test" npm run db:migrate
```

```powershell
# PowerShell
$env:DATABASE_NAME = 'campaigns_test'; npm run db:bootstrap
$env:MIGRATION_DATABASE_URL = 'postgres://postgres:SENHA@localhost:5432/campaigns_test'; npm run db:migrate
```

---

## Rodar

Quatro terminais:

```bash
npm run dev:api          # http://localhost:3000
npm run dev:worker
npm run dev:storefront   # http://localhost:5173
npm run dev:organizer    # http://localhost:5174
npm run dev:admin        # http://localhost:5175
```

### Escolher a comunidade em desenvolvimento

Em produção a comunidade sai do **domínio**. Em `localhost` não há subdomínio
por comunidade, então a vitrine e o painel aceitam `?tenant=<slug>` uma vez e
memorizam a escolha:

```
http://localhost:5173/?tenant=minha-comunidade
```

O navegador envia apenas o **slug**. O `tenant_id` sai do banco, e o vínculo é
conferido lá — um `tenant_id` enviado pelo cliente nunca é aceito.

**Domínio desconhecido devolve 404.** Não existe comunidade padrão de fallback:
cair numa comunidade qualquer seria servir a marca e os dados de outro cliente.

### Primeiro Super Admin

Não há rota que crie o primeiro Super Admin — ela seria um caminho de escalada
de privilégio aberto na internet. A primeira concessão é feita no banco, pelo
dono do schema:

```sql
-- 1. a pessoa (senha definida pelo fluxo de convite, ainda da Fase 5)
INSERT INTO users (email, display_name)
VALUES ('voce@example.com', 'Seu Nome')
RETURNING id;

-- 2. o privilégio, explícito
INSERT INTO platform_admins (user_id, role)
VALUES ('<id devolvido acima>', 'PLATFORM_OPERATIONS');
```

A credencial precisa existir em `user_credentials` com um hash `scrypt$…`
gerado por `hashPassword()` (`apps/api/src/lib/password.ts`). No primeiro login
o console exigirá o cadastro do segundo fator: **RN12 não tem escape**.

### RN12 e a mudança de papel durante a sessão

`sessions.mfa_satisfied_at` significa **uma única coisa**: esta sessão
apresentou e validou um segundo fator real. Ela **não** significa "esta pessoa
não precisava de MFA quando entrou".

A distinção não é cosmética. A autorização faz duas perguntas independentes:

| Pergunta | De onde vem | Quando é recalculada |
|---|---|---|
| O perfil **exige** MFA? | papéis vigentes no banco | **a cada requisição** |
| Esta sessão **comprovou** MFA? | `mfa_satisfied_at` | quando o fator é apresentado |

Só bloqueia quem responde *sim* à primeira e *não* à segunda. Quem não está sob
RN12 usa normalmente as rotas que lhe cabem, com a marca nula.

A consequência é o que importa: **promover alguém a dono, financeiro ou Super
Admin passa a valer na requisição seguinte**, sem logout. A sessão aberta é
imediatamente barrada nas rotas privilegiadas até o fator ser apresentado.

Concluir o segundo fator **rotaciona o token da sessão**. A linha da sessão é a
mesma — o identificador continua ligando a trilha ao mesmo episódio de acesso —
mas o segredo portador é substituído. Um token capturado antes da elevação não
se transforma em sessão privilegiada depois.

---

## Testes

```bash
npm run lint        # ESLint
npm run typecheck   # TypeScript estrito em todos os pacotes
npm test            # Vitest
npm run build       # build de todos os pacotes e frontends
```

### Testes que exigem PostgreSQL

Os testes de RLS, auditoria, outbox e migrations rodam contra **PostgreSQL
real**, com o papel real da aplicação. Sem as variáveis abaixo eles são
**pulados** — nunca substituídos por mock, porque um mock de RLS provaria
apenas que o mock funciona.

```bash
export TEST_MIGRATION_DATABASE_URL="postgres://postgres:SENHA@localhost:5432/campaigns_test"
export TEST_APP_DATABASE_URL="postgres://app_user:SENHA@localhost:5432/campaigns_test"
export TEST_WORKER_DATABASE_URL="postgres://app_worker:SENHA@localhost:5432/campaigns_test"
npm test
```

```powershell
$env:TEST_MIGRATION_DATABASE_URL = 'postgres://postgres:SENHA@localhost:5432/campaigns_test'
$env:TEST_APP_DATABASE_URL       = 'postgres://app_user:SENHA@localhost:5432/campaigns_test'
$env:TEST_WORKER_DATABASE_URL    = 'postgres://app_worker:SENHA@localhost:5432/campaigns_test'
npm test
```

O CI (`.github/workflows/ci.yml`) sobe um PostgreSQL 17 real e **falha se
qualquer teste for pulado** — um CI verde sem os testes de isolamento seria uma
falsa aprovação.

### Cobertura por arquivo

| Arquivo | O que prova | Precisa de banco |
|---|---|---|
| `packages/shared/tests/protected-constants.test.ts` | RN05, RN13, RN16, RN18 e os estados literais do DOC-01 | não |
| `packages/shared/tests/permission-matrix.test.ts` | Matriz do DOC-01 §3, separação status × financeiro × dado pessoal, RN12 | não |
| `apps/api/tests/auth-primitives.test.ts` | scrypt, TOTP, replay, AES-GCM, token de sessão | não |
| `apps/api/tests/route-contract.test.ts` | E4: contrato ↔ rotas registradas, nos dois sentidos | não |
| `packages/db/tests/migrations-on-empty-database.test.ts` | Migrations do zero; `tenant_id` + RLS em toda tabela de negócio | **sim** |
| `packages/db/tests/enum-parity.test.ts` | E3: `pg_enum` ↔ enums do código | **sim** |
| `packages/db/tests/tenant-isolation.test.ts` | RN01: A não lê/altera/relaciona dados de B; contexto não vaza | **sim** |
| `packages/db/tests/audit-immutability.test.ts` | RN11: UPDATE/DELETE/TRUNCATE recusados; sem segredos na trilha | **sim** |
| `packages/db/tests/outbox-transactional.test.ts` | RN21: rollback desfaz o evento junto | **sim** |
| `apps/api/tests/auth-mfa-permissions.test.ts` | MFA obrigatório, matriz no backend, revogação | **sim** |
| `apps/worker/tests/outbox-relay-and-consumer.test.ts` | Relay, recuperação, reprocessamento sem duplicar, dead-letter | **sim** |
| `apps/worker/tests/queue-end-to-end.test.ts` | outbox → relay → **pg-boss real** → consumidor → efeito; privilégios da fila | **sim** |
| `packages/shared/tests/frontend-session-state.test.ts` | RN12 na tela, erro de rede ≠ logout, origem do slug | não |

---

## Rotas

Todas as rotas nascem de `packages/shared/src/contracts/routes.ts`. Os
frontends chamam por **nome de contrato**, nunca por string de caminho — uma
rota inexistente quebra o typecheck, não a produção (erro E4).

| Método | Caminho | Exige |
|---|---|---|
| `GET` | `/api/health` | — |
| `GET` | `/api/public/tenant` | comunidade resolvida |
| `POST` | `/api/auth/login` | — |
| `POST` | `/api/auth/logout` | sessão |
| `POST` | `/api/auth/logout-all` | sessão |
| `GET` | `/api/auth/session` | sessão |
| `POST` | `/api/auth/mfa/enroll` | sessão |
| `POST` | `/api/auth/mfa/enroll/confirm` | sessão |
| `POST` | `/api/auth/mfa/verify` | sessão |
| `GET` | `/api/tenant/context` | sessão + vínculo + `tenant:read` |
| `GET` | `/api/tenant/audit-events` | sessão + MFA + `team:manage` |
| `GET` | `/api/platform/tenants` | sessão + MFA + `platform:tenant:read` |
| `POST` | `/api/platform/tenants` | sessão + MFA + `platform:tenant:create` |

---

## Trilha de auditoria (RN11)

A trilha é **somente inserção**: `UPDATE`, `DELETE` e `TRUNCATE` são barrados
por trigger (0004) e pela ausência de `GRANT` (0006) — a dupla defesa cobre até
o dono do schema.

Eventos de **identidade** têm `tenant_id` nulo: login e segundo fator acontecem
antes de existir comunidade, e podem acontecer para quem não tem comunidade
nenhuma. Inventar um "tenant técnico" para abrigá-los criaria um balde onde
dados de várias comunidades se encontrariam. Eles não aparecem em
`/api/tenant/audit-events`, que enxerga apenas o próprio tenant.

| Ação | Quando |
|---|---|
| `auth.login.succeeded` | sessão aberta — na **mesma transação** da sessão |
| `auth.login.failed` | senha inválida ou conta não ativa ou bloqueada |
| `auth.account_locked` | o bloqueio por tentativas passou a valer (uma vez, na transição) |
| `auth.logout` | sessão revogada |
| `auth.logout_all` | todas as sessões revogadas |
| `auth.mfa.enrollment_started` | segredo TOTP gerado |
| `auth.mfa.enrollment_confirmed` | fator confirmado e sessão elevada |
| `auth.mfa.verified` | fator apresentado numa sessão existente |

Só entram metadados seguros. Senha, segredo TOTP, token e cookie **nunca** são
gravados — e `app.assert_no_secrets` (0001) recusa a inserção se forem, de modo
que a disciplina do chamador não é a única linha de defesa.

**Não há trilha para tentativa contra e-mail inexistente.** A tabela exige ator
identificado, e não há a quem atribuir; registrar sob um ator de sistema
transformaria a trilha num log de endereços sondados — dado pessoal de
não-usuários, acumulado sem propósito. Contar esse caso é trabalho de métrica,
não de RN11.

### Login não revela se o e-mail existe

Toda recusa devolve a **mesma** resposta: senha errada, e-mail inexistente,
conta inativa e conta bloqueada por tentativas. Devolver 429 para a conta
bloqueada parecia inofensivo, mas bastava gastar as tentativas de um endereço e
ler o código de status para descobrir se ele existe na plataforma.

O bloqueio continua existindo e continua valendo — some apenas o sinal externo.
A senha é verificada **antes** de qualquer decisão, inclusive para conta
bloqueada ou inativa: um retorno antecipado economizaria o `scrypt` e
denunciaria o caso pelo tempo de resposta. E a tentativa contra uma conta já
bloqueada **não é contabilizada**, senão qualquer um manteria uma conta
conhecida trancada indefinidamente apenas insistindo.

---

## Documentos

- [`docs/decisions/fase-1-decisoes.md`](docs/decisions/fase-1-decisoes.md) —
  decisões, suposições e pendências abertas.

---

## Próxima fase

**Fase 2 — núcleo de sorteios:** grade dinâmica, reservas de 30 minutos,
pedidos e pagamento PIX avulso.

Antes de começar, quatro decisões do produto:

1. **Trava de reserva** — só PostgreSQL (transação + índice único parcial) ou
   PostgreSQL + Redis. O DOC-01 §9 desenha Redis; a escolha operacional padrão
   é só PostgreSQL. Registrado, não resolvido.
2. **Matriz do Super Admin (S8)** — a distribuição atual por sub-perfil é
   suposição conservadora e precisa de validação.
3. **Cache no `originGuard`** — hoje cada requisição com `Origin` desconhecida
   consulta o banco.
4. **Provedores de pagamento** — PIX avulso e recorrência: a definir.

### Limites conhecidos desta fase

Registrados porque são reais, não porque impedem a fundação:

- **Telas sem teste automatizado.** A lógica de fundação dos frontends (RN12 na
  tela, erro de rede × logout, origem do slug) está em `@campaigns/shared` e tem
  teste próprio. A **renderização** dos componentes não tem: cobri-la exigiria
  trazer jsdom e uma biblioteca de teste de componente, peso que esta fase optou
  por não adicionar.
- **Bloqueio de conta como negação de serviço.** Tentativas repetidas trancam
  uma conta conhecida por `LOGIN_LOCK_MINUTES`. A resposta uniforme impede
  descobrir *quais* contas existem, mas quem já souber um e-mail válido pode
  trancá-lo. Mitigar exige limite por origem (IP/rede) antes da autenticação —
  camada que não existe nesta fase.
- **Cada `Origin` desconhecida consulta o banco** (item 3 acima).
- **Encerramento gracioso do worker não exercitado no Windows.** O processo sobe,
  processa e libera as conexões; a entrega de `SIGTERM`/`SIGINT` a um processo
  Node não é possível a partir do shell nesta plataforma. Verificar isso é
  trivial no Linux e fica para a rodada de staging.
