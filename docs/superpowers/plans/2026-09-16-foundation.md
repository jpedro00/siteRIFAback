# Fase 1 — plano de execução

Objetivo: completar a base existente e executar os 13 critérios de aceite do pedido.
Especificação: pedido do usuário, DOC-01 em Downloads e docs/decisions/foundation.md.
Stack: Node/Express/TypeScript, React/Vite, PostgreSQL, pg-boss, Vitest/Supertest.

Restrições globais: só Fase 1; sem commits/deploy; preservar alterações existentes;
estados literais; constantes 30/30 minutos, 12 horas, grades 100/500/1000 e thresholds 25/10.

- [ ] Banco: iniciar cluster de teste separado; migrar vazio; testar credencial app_user,
  ausência e reutilização de contexto, relações cruzadas, auditoria imutável e rollback.
- [ ] API: completar app/server/health, autenticação e MFA, limitar tentativas,
  revogação, contratos e autorização real; testar com Supertest e PostgreSQL.
- [ ] Worker: executar docs/superpowers/plans/worker-brief.md e revisar implementação.
- [ ] Frontends: três Vite apps ligados aos contratos, sessão, MFA, contexto,
  loading/erro/negação, sem telas ou indicadores financeiros simulados.
- [ ] Entrega: CI, env, bootstrap administrativo, README, lint/typecheck/test/build,
  revisão de segurança e relatório honesto dos critérios.

Interfaces: API e UI consomem ROUTE_CONTRACTS em shared; API grava tenant.created;
worker consome o schema de evento e as tabelas existentes. Banco publica withContext.
API e worker não editam o mesmo arquivo durante implementação delegada.
