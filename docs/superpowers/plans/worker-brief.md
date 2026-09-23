# Tarefa worker — M01/M12, base RN21

Leia migrations 0004–0006 e shared/contracts/events.ts. Implemente apenas apps/worker
(package.json, tsconfig, src, tests). Não altere root/shared/db/API. Não faça commit,
não instale dependências (avise o coordenador) e não delegue.

Use pg-boss 10, worker com app_worker, fila em schema pgboss previamente provisionado
por migration administrativa; a credencial do worker nunca deve ser dona de tabelas de negócio.
O coordenador provisionará schema pgboss AUTHORIZATION app_worker em migration.
API emite tenant.created na mesma transação da comunidade. Relay recuperável seleciona
outbox com FOR UPDATE SKIP LOCKED, publica evento por ID na fila, marca published_at
somente após aceite. Falha deve registrar attempts/last_error e available_at para retry.
Como banco e fila não são transação única, publicação duplicada é possível e aceitável.
Consumidor busca evento por ID (não confia no payload da fila), valida schema,
provisiona tenant_branding padrão, audit_events SYSTEM e event_consumptions numa transação.
Lock do evento + recibo evitam duplicação concorrente. Erro desconhecido não conclui.
Recovery deve reencaminhar eventos publicados mas não consumidos quando necessário,
sem marcar consumo concluído no relay. Registre estratégia no relatório.
Exportar relayOnce(pool,boss), consumeTenantCreated(pool,eventId) e startWorker.
Testes Vitest de banco real usam helpers packages/db/tests/helpers/testDb.ts;
evite limpeza destrutiva compartilhada, use IDs únicos. Teste rollback/retry/idempotência
concorrente/fluxo real pg-boss com credencial restrita. Sem mock para alegar banco validado.
Reporte evidência real e limitações em docs/acceptance/worker-report.md.
