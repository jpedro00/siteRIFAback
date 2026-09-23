# Worker — relatório de aceite

Data: 2026-09-16. Escopo: `apps/worker`, M01/M12, RN21.

## Estado

**Não aprovado neste checkpoint.** A implementação do worker passou a ser
gravada simultaneamente por outra sessão durante a execução desta tarefa. Por
orientação do coordenador, os arquivos concorrentes não foram substituídos.

Arquivos criados por esta tarefa antes da detecção do conflito:

- `apps/worker/package.json` e `apps/worker/tsconfig.json`;
- `apps/worker/tests/worker.integration.test.ts`, com cenários de rollback,
  retry do relay, idempotência concorrente, recuperação e fluxo pg-boss real
  sob `app_worker`.

## Evidência executada

Comando:

```text
node_modules\.bin\vitest.cmd run apps/worker/tests/worker.integration.test.ts
```

Resultado: **RED esperado**, antes da implementação da interface requerida.
O Vitest iniciou, mas a suíte não foi coletada porque `apps/worker/src/index.js`
não existia. Saída relevante:

```text
FAIL apps/worker/tests/worker.integration.test.ts
Failed to load url ../src/index.js
Test Files 1 failed
Tests 0 test
```

O primeiro disparo dentro do sandbox falhou com `spawn EPERM` ao iniciar o
esbuild; a repetição autorizada fora do sandbox produziu a evidência acima.

As URLs do PostgreSQL 17 de teste foram fornecidas, mas o ciclo GREEN e o fluxo
real do pg-boss não foram executados porque as edições foram pausadas assim que
a concorrência foi detectada.

## Divergências observadas na implementação concorrente

A revisão somente leitura de `apps/worker/src` encontrou os seguintes pontos
incompatíveis com `docs/superpowers/plans/worker-brief.md`:

1. A mensagem da fila contém `eventType`, `tenantId` e o payload inteiro. O
   consumidor usa esse payload diretamente; não busca o evento por ID na
   `outbox`.
2. O consumidor não bloqueia a linha do evento. A exigência era lock do evento
   mais recibo para impedir duplicação concorrente.
3. Comunidade ausente causa `COMMIT` de `event_consumptions`. Assim, um erro
   desconhecido é marcado como concluído, contrariando o requisito de retry.
4. A recuperação cobre apenas linhas nunca publicadas. Não há reenvio de evento
   com `published_at` preenchido e sem recibo de consumo.
5. A configuração separa `QUEUE_DATABASE_URL` e afirma que a fila usa uma
   credencial com DDL. O brief determina pg-boss 10 no schema `pgboss`
   previamente provisionado e pertencente a `app_worker`.
6. Não são exportadas as interfaces exigidas `relayOnce(pool, boss)`,
   `consumeTenantCreated(pool, eventId)` e `startWorker`.
7. `worker.ts` executa `main()` ao ser importado, o que impede que a função de
   inicialização seja usada e testada sem efeito colateral.
8. Os testes concorrentes substituem somente o publisher; não executam um fluxo
   real do pg-boss, não exercitam consumo concorrente e o caso descrito como
   transacional confirma `tenant_missing` sem verificar que o recibo foi
   revertido — a implementação, na realidade, o confirma por `COMMIT`.
9. Os testes do relay varrem lotes globais sem restringir os IDs únicos do
   cenário, podendo publicar ou alterar eventos criados por outras suítes no
   banco compartilhado.
10. `config.ts` importa `zod`, mas o manifesto atual não declara `zod` como
    dependência direta.

## Estratégia de recuperação prevista pelo teste

O relay deve priorizar linhas disponíveis nunca publicadas e também selecionar
linhas publicadas há mais que a janela de recuperação quando não existir
`event_consumptions` para `tenant.created`. Em ambos os casos usa
`FOR UPDATE SKIP LOCKED`, envia à fila apenas `{ eventId }` e só atualiza
`published_at` após `pg-boss.send` devolver um ID. Falha incrementa `attempts`,
grava `last_error` e move `available_at` com recuo. O relay jamais insere o
recibo; somente o consumidor o faz, na mesma transação de branding e auditoria.

Duplicação entre fila e outbox continua possível e intencional: se a fila
aceitar e o commit da outbox se perder, o evento volta a ser publicado. O lock
da outbox e a chave `(event_id, consumer)` tornam o efeito PostgreSQL
idempotente.

## Dependências

O manifesto pede `pg-boss` `^10.3.2`, `@campaigns/db` e
`@campaigns/shared`. Se a implementação concorrente que usa `zod` for mantida,
`zod` precisa ser declarado diretamente.

## Próximo passo necessário

Garantir uma única sessão escritora, decidir qual implementação preservar e
então concluir o ciclo RED → GREEN. A aprovação exige evidência fresca de:

- typecheck/build do workspace;
- rollback e retry no PostgreSQL 17 real;
- duas chamadas concorrentes produzindo um único efeito, audit e recibo;
- evento publicado sem recibo sendo reenfileirado;
- fluxo outbox → pg-boss 10 → consumidor usando a credencial `app_worker`;
- confirmação de que `app_worker` não é dono das tabelas de negócio.
