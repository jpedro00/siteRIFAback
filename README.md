# TironiRifa — backend

API HTTP, worker e banco da plataforma de sorteios por comunidades. Este
repositorio e tambem a **fonte versionada dos contratos** que o frontend
consome.

O frontend — vitrine, painel do organizador e console da plataforma — vive em
`tironirifa-frontend`. Os dois repositorios instalam e compilam sem depender da
pasta local um do outro: nenhuma dependencia `file:../` atravessa a fronteira.

## Estrutura

```
apps/api            Node + Express + TypeScript. Autenticacao por sessao/cookie, MFA,
                    resolucao de comunidade, rotas publicas e privadas.
apps/worker         Processo separado: relay da outbox e consumidores (pg-boss).
packages/db         PostgreSQL: pool, contexto de sessao, migrador e migrations 0001–0010.
packages/shared     Contratos (Zod), estados, permissoes e constantes. FONTE.
render.yaml         Blueprint de STAGING para API e worker. Nao ha producao aqui.
docs/               Decisoes, aceites, runbooks e o README do monorepo anterior.
```

`apps/api` e `apps/worker` ficam no mesmo repositorio de proposito, e em
processos e deploys separados: compartilham banco, contratos e migrations, mas
escalam e falham por motivos diferentes. Um relay travado nao deve derrubar o
atendimento HTTP.

## Contratos: este repositorio manda

`packages/shared/src/{contracts,states,permissions,constants}` e a definicao
unica. O frontend carrega uma **copia conferida por hash**.

```bash
npm run contracts:verify     # o manifesto corresponde ao que esta no disco?
npm run contracts:snapshot   # regenera o manifesto apos alterar um contrato
```

Ao mudar um contrato:

1. altere aqui;
2. suba a versao de `packages/shared/package.json`;
3. rode `npm run contracts:snapshot`;
4. leve as quatro arvores **e** o `CONTRACTS_SNAPSHOT.json` para o frontend.

O CI dos dois lados confere o manifesto. Um contrato editado so de um lado nao
quebra typecheck nenhum — os dois repositorios continuam compilando, e a
diferenca aparece no navegador de quem compra, como um campo que a API recusa.
A conferencia existe para que isso vire erro de build, com o arquivo nomeado.

Permissao no frontend e apresentacao: esconder um botao. **A autorizacao continua
sendo decidida aqui**, contra o vinculo no PostgreSQL. A separacao nao moveu uma
unica decisao de autorizacao para o cliente.

## Setup local

Pre-requisitos: Node >= 20.11 (o CI e o Render usam 22) e um PostgreSQL 17 ao
qual voce tenha o papel dono do schema.

```bash
npm ci
cp .env.example .env          # preencha; o arquivo NAO vai para o Git
# Os comandos raiz de dev/typecheck/test preparam shared + db automaticamente.
```

### Banco

Os tres papeis existem para usos distintos e nao sao intercambiaveis:

| Variavel | Papel | Quem usa |
|---|---|---|
| `ADMIN_DATABASE_URL` / `MIGRATION_DATABASE_URL` | dono do schema | bootstrap, migrations, `queue:install` — etapas administrativas, executadas a mao |
| `DATABASE_URL` | `app_user` | a API, e so ela |
| `WORKER_DATABASE_URL` / `QUEUE_DATABASE_URL` | `app_worker` | o worker, e so ele |

```bash
npm run db:bootstrap                    # cria banco e os dois papeis restritos
npm run db:migrate                      # aplica as migrations pendentes
npm run queue:install -w @campaigns/worker
```

> `db:bootstrap` e `db:migrate` executam DDL. Num banco que ja existe, rode
> apenas `db:migrate`, e so depois de conferir a conexao. **`db:reset-test`
> apaga dados** — ele existe para o banco de teste descartavel e nunca deve
> receber a conexao normal.

A separacao de repositorios **nao exige trocar de banco**. O banco, os papeis, a
RLS e o historico de migrations continuam os mesmos.

### Rodar

```bash
npm run dev:api        # http://localhost:3000
npm run dev:worker
```

API, worker e CLIs carregam o `.env` privado da raiz em desenvolvimento. Em
Render, o arquivo não existe e as variáveis injetadas pelo serviço têm
precedência.

## Verificacao

```bash
npm run contracts:verify
npm run lint
npm run typecheck
npm test
npm run build
```

Boa parte da suite exige PostgreSQL de verdade: os testes de RLS, isolamento por
comunidade, imutabilidade da auditoria e outbox transacional. **Sem
`TEST_*_DATABASE_URL` configurada eles se PULAM em silencio**, e a saida verde
nao significa aprovacao. `scripts/assert-no-skipped-tests.mjs` existe para que o
CI recuse exatamente esse falso verde:

```bash
npx vitest run --reporter=default --reporter=json --outputFile=.vitest-report.json
node scripts/assert-no-skipped-tests.mjs
```

Use um banco de teste **descartavel** — nunca o de desenvolvimento, e jamais o
real. A configuração de testes também compara `host:porta/database` e recusa
subir quando um `TEST_*` aponta para o mesmo alvo físico das conexões normais.

## Deploy

`render.yaml` descreve **staging**, nao producao: um servico web (API) e um
worker. Migrations nao rodam no deploy, de proposito — sao DDL, exigem o papel
dono do schema, e amarra-las ao build faria cada deploy, inclusive um rollback,
tentar aplicar DDL com a credencial errada.

Ao apontar o Render para este repositorio, confira que a branch referenciada
existe no remoto e que os comandos de build nao mencionam mais os workspaces de
frontend.

## Pendencias herdadas

Continuam abertas e **nao** foram introduzidas nem resolvidas pela separacao:
resolucao de comunidade por host em topologia de API central; comunidade criada
sem owner automatico; equipe sem convite/remocao; listagens limitadas a 200 sem
paginacao; ausencia de PSP/PIX real e conciliacao. Ver
`docs/separacao/RELATORIO.md`.
