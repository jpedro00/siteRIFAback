# Separacao em dois repositorios — relatorio de execucao

Data: 22/09/2026. Executado em `C:\Users\jpfma\Downloads\SITERIFANOVO100`.

Este documento existe em `tironirifa-backend` e `tironirifa-frontend` com o
mesmo conteudo.

## Origem, e o que ela nao prova

Os arquivos vieram de `01_BASE_ATUAL` do pacote
`TIRONIRIFA_TRANSFERENCIA_FRONT_BACK_PRIVADO.zip` — o snapshot do monorepo, sem
historico Git.

**Nao ha commit-base registrado.** O pacote informa um HEAD `83b465f` e um
commit `f3df750` do fluxo funcional, mas isso nao pode ser conferido aqui: o ZIP
nao traz `.git`. Antes de qualquer publicacao, confronte estes dois
repositorios com o checkout real do monorepo e registre o commit de onde a copia
saiu. Ate la, o que se sabe e que a copia corresponde ao ZIP, nao que o ZIP
corresponde ao HEAD.

`02_PRIVADO_NAO_COMMITAR/env-historico/.env` **nao foi copiado** para nenhum dos
dois repositorios. Uma verificacao automatica comparou os 18 valores nao triviais
daquele arquivo contra os 245 arquivos versionaveis dos dois repos: a unica
coincidencia foi `DATABASE_NAME=campaigns`, que ja era publico no `.env.example`
do monorepo e nao e credencial.

## Destino dos arquivos

| Origem no monorepo | Destino |
|---|---|
| `apps/storefront`, `apps/organizer`, `apps/admin` | frontend |
| `apps/api`, `apps/worker` | backend |
| `packages/db` + as 10 migrations | backend |
| `packages/shared/src/{contracts,states,permissions,constants}` | backend (**fonte**) + copia conferida no frontend |
| `packages/shared/src/frontend`, `packages/shared/styles` | frontend |
| `packages/shared/tests/frontend-*.test.ts` | frontend |
| `packages/shared/tests/{permission-matrix,protected-constants}.test.ts` | backend — testam a fonte |
| `render.yaml` | backend |
| `apps/*/vercel.json` | frontend |
| `.env.example` (raiz) | backend — nao continha nenhuma `VITE_` |
| `.env.staging.example` | dividido: secao FRONTENDS extraida para o `.env.example` do frontend |
| `README.md` do monorepo | backend, em `docs/historico/`; READMEs novos em cada raiz |
| `docs/` | backend |
| `.gitattributes`, `.gitignore`, `tsconfig.base.json` | ambos, identicos |
| `eslint.config.js`, `vitest.config.ts`, `tsconfig.tests.json`, `package.json` | reescritos por responsabilidade |
| `package-lock.json` | **nao copiado** — cada repo gerou o seu com `npm install` |

Nada foi renomeado: os pacotes continuam `@campaigns/*`. Manter o escopo evita
tocar cada `import` das duas bases por um ganho cosmetico.

## Contratos: fonte unica + snapshot conferido

Sem um registry privado — que nao foi configurado nem autorizado —, a opcao foi
o snapshot controlado que o plano previa, com versao e hash registrados.

`scripts/contracts-snapshot.mjs` existe identico nos dois repositorios. No
backend ele **gera** `packages/shared/CONTRACTS_SNAPSHOT.json` (`--write`); dos
dois lados ele **confere**. O hash e calculado sobre o conteudo normalizado para
LF, para que um clone com `core.autocrlf=true` no Windows nao acuse divergencia
falsa — o mesmo problema que o `.gitattributes` ja resolvia para as migrations.

Manifesto atual:

```
pacote  @campaigns/shared  versao 0.1.0
17 arquivos
digest  d9b4eed9cc7239114a716accc1bff9cd23673f76966cc766e7d4d96f7beb0957
```

A guarda foi testada contra o caso que ela existe para pegar: uma linha
acrescentada a `packages/shared/src/constants/reservation.ts` **no frontend**
fez `contracts:verify` sair com codigo 1 nomeando o arquivo divergente; desfeita
a edicao, voltou a aprovar. O arquivo foi restaurado byte a byte — o digest
posterior e o mesmo de cima.

A verificacao roda no CI dos dois repositorios e no `buildCommand` dos tres
projetos do Vercel, antes da compilacao.

## O que foi validado, com o que de fato rodou

Instalacoes independentes, do zero, uma em cada repositorio. Nenhum
`package-lock.json` contem dependencia `file:../` — conferido por busca literal.

### backend

| Comando | Resultado |
|---|---|
| `npm install` | 300 pacotes |
| `npm run contracts:verify` | aprovado — 17 arquivos, digest `d9b4eed9…` |
| `npm run lint` | sem apontamentos |
| `npm run typecheck` | aprovado nos 4 workspaces + `tsconfig.tests.json` |
| `npm run build` | aprovado nos 4 workspaces |
| `npm test` | **135 aprovados, 202 pulados** (337 em 17 arquivos) |

### frontend

| Comando | Resultado |
|---|---|
| `npm install` | 220 pacotes |
| `npm run contracts:verify` | aprovado — mesmo digest |
| `npm run lint` | sem apontamentos |
| `npm run typecheck` | aprovado nos 4 workspaces + `tsconfig.tests.json` |
| `npm run build` | as 3 aplicacoes compilaram (Vite 6.4.3) |
| `npm test` | **53 aprovados**, 3 arquivos, nenhum pulado |

## O que NAO foi validado — e por que

**Os 202 testes pulados do backend sao os que exigem PostgreSQL**: RLS,
isolamento por comunidade, imutabilidade da auditoria, outbox transacional,
paridade de enums, migrations em banco vazio, fila fim a fim, reservas. Eles se
pulam sozinhos quando `TEST_*_DATABASE_URL` nao esta configurada — e um teste
pulado em silencio se parece com um teste aprovado.

Ha um PostgreSQL escutando em `127.0.0.1:5432` nesta maquina. **Ele nao foi
tocado.** Nao se sabe que banco e esse, e `db:bootstrap` e `db:migrate` executam
DDL; apontar um deles para o banco errado nao e um erro que se desfaz lendo o
log. Rodar essa parte da suite exige uma decisao que e de quem conhece a
instalacao, contra um banco declaradamente descartavel:

```bash
# banco DESCARTAVEL, nunca o de desenvolvimento e jamais o real
export ADMIN_DATABASE_URL=postgres://postgres:...@localhost:5432/postgres
export DATABASE_NAME=campaigns_test
export APP_DB_PASSWORD=... WORKER_DB_PASSWORD=...
export MIGRATION_DATABASE_URL=postgres://postgres:...@localhost:5432/campaigns_test
export TEST_MIGRATION_DATABASE_URL=$MIGRATION_DATABASE_URL
export TEST_APP_DATABASE_URL=postgres://app_user:...@localhost:5432/campaigns_test
export TEST_WORKER_DATABASE_URL=postgres://app_worker:...@localhost:5432/campaigns_test

npm run db:bootstrap && npm run db:migrate
npm run queue:install -w @campaigns/worker
npx vitest run --reporter=default --reporter=json --outputFile=.vitest-report.json
node scripts/assert-no-skipped-tests.mjs
```

Ate isso rodar, **a separacao esta verificada por lint, typecheck, build e pelos
testes que nao dependem de banco — e nada alem disso**. Os 390/390 citados no
relatorio historico sao de outra execucao, em outro ambiente; nao sao prova
desta separacao e nao devem ser reaproveitados como tal.

Tambem nao foi validado, por exigir ambiente ou autorizacao que nao existem aqui:

- navegacao no navegador contra a API rodando — login, MFA, logout, troca de
  comunidade, catalogo, reserva, pedido;
- comportamento de cookie cross-site entre os hosts reais (`SameSite=None` com
  bloqueio de cookies de terceiros continua possivel);
- qualquer configuracao de Vercel, Render, Supabase ou DNS;
- deploy, publicacao ou criacao de repositorio remoto.

## Git

**Nenhum commit foi feito.** Os dois diretorios sao repositorios Git ja
inicializados, com `LICENSE` e `README.md` previos; as mudancas estao na arvore
de trabalho, aguardando revisao. `node_modules/`, `dist/` e `.env` ja estao
cobertos pelo `.gitignore` herdado.

## Alerta de antivirus — continua em aberto

O relatorio historico informa deteccao de `Trojan:Script/Wacatac.B!ml` pelo
Defender em `tironiRifa-main.zip -> apps/admin/index.html`.

O arquivo copiado para `siteRIFAfront/apps/admin/index.html` tem 307 bytes, usa
finais de linha LF, e seu conteudo e o `index.html` padrao do Vite: `<div
id="root">` e um `<script type="module" src="/src/main.tsx">`. Nao ha script
embutido, string codificada nem URL externa.

sha256: `051525b81d1eb29a320d708b9cefd7a732271bc625c9777127a8748d7bf22502`

**Isto nao e um exame antivirus e nao conclui nada.** Leitura do conteudo nao
equivale a varredura, e a causa da deteccao continua sem explicacao. Nao desative
protecao, nao crie exclusao e nao restaure quarentena como atalho. A decisao
pertence a quem tiver a ferramenta e o contexto para fecha-la.

## Pendencias herdadas do monorepo

Estas ja existiam e atravessaram a separacao sem mudanca — nao foram
introduzidas nem resolvidas aqui:

- fallback de API para `localhost` nas tres aplicacoes;
- resolucao de comunidade por host de tres segmentos, fragil em previews e
  dominios personalizados;
- API em host central nao recebe o hostname da vitrine; a topologia white-label
  de producao continua em aberto;
- criacao de comunidade nao provisiona owner automaticamente;
- equipe informativa, sem convite nem remocao;
- conta sem consolidacao segura de pedidos autenticados;
- suspensao bloqueia a resolucao do tenant, com impacto no pos-venda;
- listagens limitadas a 200, sem paginacao;
- sem PSP/PIX real, conciliacao ou ciclo de resultado e entrega;
- sem testes de componentes React.

## Proximos passos, na ordem

1. Confrontar os dois repositorios com o checkout real do monorepo e registrar o
   commit-base.
2. Rodar a suite completa do backend contra um PostgreSQL descartavel, com
   `assert-no-skipped-tests.mjs`.
3. Revisar o diff, decidir historico (filtrado ou import inicial) e commitar.
4. So entao: repositorios remotos, Vercel, Render, dominios e CORS — como
   conjunto, nao um de cada vez.
5. Com a separacao estavel, retomar a prioridade aprovada: frontend profissional
   e navegavel. PIX continua fora desta etapa.
