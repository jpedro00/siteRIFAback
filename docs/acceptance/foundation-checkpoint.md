# Fase 1 — checkpoint de execução

> **17/09/2026 — rodada de correção e validação total.** Os bloqueios descritos
> abaixo foram resolvidos. O estado atual está em
> [`rodada-correcao-final.md`](rodada-correcao-final.md); este arquivo é
> mantido como histórico do diagnóstico que levou às correções.

16/09/2026. Fundação parcial; não aceita para início da Fase 2.

Fontes funcionais: DOC-01, D01 e prompts geral/Astra.
Relatório Fase 0 consumido da conversa; arquivo não localizado.
Os fluxos financeiros não foram implementados nesta fase.

## Ambiente e alterações desta execução

Node 22.22.0, npm 10.9.4, PostgreSQL 17.11. Cluster separado em `.local/pg-test`,
escutando somente 127.0.0.1:55439, banco `foundation_test`. Autenticação trust apenas
nesse cluster local de teste; não usar esta configuração em produção.

Criados plano, decisões, teste HTTP adicional e migration 0007; corrigido comentário
com terminador acidental em shared/contracts/routes.ts. Dependências instaladas,
otplib atualizado para 13. Tentativa de atualizar lint/Vitest falhou no npm.
Subagente criou package/tsconfig e teste do worker, mas interrompeu implementação
quando arquivos do mesmo escopo surgiram por outra origem.

## Evidência de teste

Comando PowerShell (credenciais restritas no cluster de teste):

```powershell
$env:TEST_MIGRATION_DATABASE_URL='postgresql://foundation_test_owner@127.0.0.1:55439/foundation_test'
$env:TEST_APP_DATABASE_URL='postgresql://app_user@127.0.0.1:55439/foundation_test'
$env:TEST_WORKER_DATABASE_URL='postgresql://app_worker@127.0.0.1:55439/foundation_test'
npm test
```

Resultado: 202 testes passaram, 4 falharam e uma suíte não carregou. Nenhum mock
foi usado para declarar RLS. Migrations aplicaram em banco vazio; o teste de inventário
falhou por exigir tenant_id na própria tabela tenants, cujo identificador é id.
O teste de sessão expirada criou uma fixture que viola expires_at > created_at.
Falhas funcionais adicionais: domínio desconhecido aceita fallback por x-tenant-slug;
POST de origem desconhecida chega à validação de payload em vez de ser negado.
Suíte worker nova não carregou porque sua interface index.ts ainda não existe.

Passaram as suítes de isolamento (23), auditoria (10), outbox transacional (5),
constantes (15), matriz de permissões (65), enums (8), primitivas auth (20) e
contratos (10). Parte da suíte de autenticação e testes HTTP também passou.
Isso não comprova o aceite integral: MFA ainda precisa revisão de elevação de papel,
limitação de tentativas e inscrição concorrente; worker e três interfaces incompletos.

## Bloqueio de coordenação

Arquivos da API e worker foram criados/alterados durante esta execução por outra
origem, inclusive totp.ts e worker/src/outbox/relay.ts. O subagente confirmou que
não foi autor desses arquivos. Edições sobrepostas foram pausadas para preservar
o trabalho do usuário. É necessário definir qual sessão continuará escrevendo.

Não houve rejeição de aprovação automática: este bloqueio é conflito de escrita,
não falta de autorização para a Fase 1.

## Retomada diagnóstica — 16/09/2026

Diagnóstico iniciado sem edições de código. Repositório confirmado em
`C:\Users\jpfma\Downloads\RIFAS\tironiRifa`, projeto `campaigns-platform`, branch
`main`, HEAD `753c3090d5a885d2615aeb109fd41f16d08976b1`. Domínio e origem HTTP
pertencem à resolução de comunidade e à proteção das sessões desta plataforma.

O `git status --short` permaneceu:

```text
 M README.md
?? .env.example
?? .github/
?? .gitignore
?? apps/
?? docs/
?? eslint.config.js
?? package-lock.json
?? package.json
?? packages/
?? tsconfig.base.json
?? vitest.config.ts
```

### Escrita concorrente

Há evidência concreta de sobreposição anterior, mas não de watcher ativo nesta
janela. `apps/worker/tests/worker.integration.test.ts`,
`apps/api/tests/http-foundation.test.ts` e `packages/db/migrations/0007_http_security.sql`
existiam na execução anterior e agora estão ausentes. A migration atualmente
presente, `0007_foundation_hardening.sql`, tem SHA-256
`0d082824e31dc03d55838d99640775b5ba6f6a7eca07f7e8c1fedad118d6f4b4`, mas o
banco isolado registra para a versão 0007 o checksum
`36cf2a521f10df4a6364171d479001194893b1b749a2e090dc5b8f1e3d4262a8`, aplicado
às 15:16:57. Logo, o conteúdo versionado mudou depois da aplicação.

Foram observados processos Codex iniciados às 13:48 e às 15:10. O sistema negou
acesso às linhas de comando completas, portanto não foi possível atribuir um PID
específico a este repositório. Não havia processo independente identificável de
Vite, Vitest, tsx, formatter ou gerador; não há hook Git não-amostral. Dois
snapshots de conteúdo mantiveram os mesmos hashes durante o diagnóstico. Isso
não prova que a sessão anterior não voltará a escrever. Deve ser pausada a outra
sessão/tarefa Codex que edita `packages/db`, `apps/api` e `apps/worker`; nenhum
processo foi encerrado por esta retomada.

### Classificação das quatro falhas

1. `migrations-on-empty-database.test.ts > toda tabela de negocio por comunidade
   tem tenant_id e RLS ativa`. Reprodução correta:
   `vitest run packages/db/tests/migrations-on-empty-database.test.ts`. Esperado:
   RLS em todas as tabelas acessíveis e `tenant_id` nas entidades filhas da
   comunidade. Observado: `tenants deveria ter tenant_id`, 1 falha e 4 testes
   aprovados. Causa: o inventário não exclui a raiz `tenants`, cujo próprio `id`
   define a fronteira. Classificação: **fixture/asserção de inventário**. A
   execução com `-t` isolado deu falso verde porque os casos anteriores é que
   aplicam as migrations; esse resultado não foi aceito.
2. `auth-mfa-permissions.test.ts > sessao expirada nao vale`. Comando de
   reprodução: `vitest run apps/api/tests/auth-mfa-permissions.test.ts -t
   "sessao expirada nao vale"`. Esperado: uma sessão estruturalmente válida,
   já expirada, recebe 401. Na execução original, o `UPDATE` foi rejeitado pela
   constraint `expires_at > created_at`; a fixture altera somente `expires_at`.
   Classificação: **fixture**. Na retomada o caso nem foi coletado: o migrador
   interrompeu antes dos testes por checksum divergente da migration 0007.
3. `http-foundation.test.ts > RN01 sem vínculo e domínio desconhecido negam
   acesso`. Comando original: `npm test` (a suíte individual desapareceu antes
   desta retomada). Esperado: host desconhecido com `x-tenant-slug` válido recebe
   404. Observado: 200. Causa: `tenantResolver` consulta o header após falhar um
   host arbitrário, embora o próprio contrato limite esse fallback ao localhost.
   Classificação: **implementação**.
4. `http-foundation.test.ts > nega POST de origem desconhecida e payload
   inválido`. Comando original: `npm test` (a suíte individual desapareceu).
   Esperado: origem fora da allowlist recebe 403 antes do handler. Observado:
   400 da validação do payload. Causa: o middleware apenas deixa de emitir
   cabeçalhos CORS; ele não rejeita a requisição mutável com `Origin` não
   confiável. Classificação: **implementação**.

A suíte do worker foi investigada separadamente. Na execução original, o
Vitest falhou durante importação, antes de coletar qualquer teste:

```text
FAIL apps/worker/tests/worker.integration.test.ts
Error: Failed to load url ../src/index.js (resolved id: ../src/index.js) in
C:/Users/jpfma/Downloads/RIFAS/tironiRifa/apps/worker/tests/worker.integration.test.ts.
Does the file exist?
Test Files 1 failed
Tests 0 test
```

Na retomada, o mesmo comando terminou com `No test files found`, porque o arquivo
de teste já não existe. A suíte do worker continua **não coletada e não validada**.

### Comandos e resultados atuais

- `npm run typecheck`: aprovado (TypeScript/`tsc --noEmit`) nos sete workspaces.
- `vitest run packages/db/tests/migrations-on-empty-database.test.ts`: 4
  aprovados, 1 falhou pelo inventário de `tenants`.
- `vitest run apps/api/tests/auth-mfa-permissions.test.ts -t "sessao expirada
  nao vale"`: suíte falhou antes da coleta pelo checksum divergente da 0007;
  40 testes ignorados.
- `vitest run apps/worker/tests/worker.integration.test.ts`: nenhum arquivo de
  teste encontrado.
- A suíte integral de 202 aprovações não foi repetida, pois o migrador agora
  recusa o banco isolado e duas suítes diagnósticas desapareceram.

Nenhuma correção de implementação foi aplicada nesta retomada. O único arquivo
alterado foi este checkpoint. Permanecem pendentes: definir uma única sessão
escritora; restaurar por origem autorizada os testes desaparecidos; preservar
migrations já aplicadas criando nova versão, sem reescrever 0007; corrigir as
duas fixtures; corrigir domínio/origem; concluir e validar worker com pg-boss
real; e homologar MFA, três interfaces, CI, build e suíte integral. A Fase 1
permanece **bloqueada por coordenação e incompleta tecnicamente**; a Fase 2 não
foi iniciada.
