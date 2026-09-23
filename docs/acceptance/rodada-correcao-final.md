# Fase 1 — rodada de correção e validação total

17/09/2026. Branch `fase-1-fundacao`, a partir de `153ecdc`.

Objetivo desta rodada: corrigir os bloqueantes encontrados na validação,
revalidar com PostgreSQL real e encerrar a Fase 1. A Fase 2 **não** foi
iniciada; nenhuma infraestrutura de nuvem foi criada; nada foi commitado,
enviado ou publicado.

---

## Ambiente

| Item | Valor |
|---|---|
| Node | 22.22.0 |
| PostgreSQL | 17.11 |
| Cluster | `.local/pg-test`, somente `127.0.0.1:55439` |
| Banco descartável | `validacao_fase1_final`, **recriado do zero** nesta execução |
| Papéis | `app_user`, `app_worker` — ambos `NOSUPERUSER`, `NOBYPASSRLS`, sem `CREATE` no banco |

O cluster usa autenticação `trust`; é um cluster local de teste e **não** deve
ser usado como modelo de produção. O bootstrap rotacionou as senhas de
`app_user` e `app_worker` **somente neste cluster**.

---

## Resultado

| Etapa | Resultado |
|---|---|
| `npm run lint` | ✅ |
| `npm run typecheck` | ✅ 7 workspaces + suíte |
| `npm run build` | ✅ 4 pacotes TypeScript + 3 frontends |
| `db:bootstrap` + `db:migrate` em banco vazio | ✅ 8 migrations |
| `queue:install` | ✅ schema `pgboss` criado, posse em `app_worker` |
| Suíte completa (`vitest run`) | ✅ **283 passaram, 0 falharam, 0 pulados**, 13 arquivos |
| Guarda de teste pulado | ✅ passa com banco; **falha** sem banco (155 pulados detectados) |
| Worker real (`npm run dev:worker`) | ✅ sobe, publica, consome, aplica efeito |
| Isolamento/RLS reexecutado | ✅ 44 testes com os papéis reais |

### Por arquivo

```text
  78 ok   apps/api/tests/auth-mfa-permissions.test.ts
  20 ok   apps/api/tests/auth-primitives.test.ts
  10 ok   apps/api/tests/route-contract.test.ts
  18 ok   apps/worker/tests/outbox-relay-and-consumer.test.ts
   7 ok   apps/worker/tests/queue-end-to-end.test.ts
  10 ok   packages/db/tests/audit-immutability.test.ts
   8 ok   packages/db/tests/enum-parity.test.ts
   6 ok   packages/db/tests/migrations-on-empty-database.test.ts
   5 ok   packages/db/tests/outbox-transactional.test.ts
  23 ok   packages/db/tests/tenant-isolation.test.ts
  18 ok   packages/shared/tests/frontend-session-state.test.ts
  65 ok   packages/shared/tests/permission-matrix.test.ts
  15 ok   packages/shared/tests/protected-constants.test.ts
```

---

## Revalidação explícita dos bloqueantes

| Cenário | Antes | Agora |
|---|---|---|
| SUPPORT → OWNER, sem MFA, rota de comunidade | 200 | **403** `MFA_ENROLLMENT_REQUIRED` |
| USER → PLATFORM_OPERATIONS, sem MFA, `/api/platform/tenants` | 200 | **403**, sem corpo de dados |
| Os mesmos, após MFA real | — | **200** |
| Token anterior à elevação | virava sessão privilegiada | **401** |
| Conta bloqueada × e-mail inexistente | 429 × 401 | **mesma resposta** |
| Origem na allowlist | teste falhava por construção | **200** com cabeçalhos |
| Origem desconhecida / preflight | 403 | **403**, mantido |
| `npm run dev:worker` | `ERR_MODULE_NOT_FOUND` | **sobe** |
| outbox → pg-boss → consumidor | nunca exercitado | **provado**, fila real |
| Evento além do máximo de tentativas | repescado a cada hora, para sempre | **dead-letter**, não é reclamado |

### Evidência do worker real

Evento gravado na mesma transação da comunidade, com o worker rodando:

```text
relay_publicou | nao_esgotado | consumidores_concluidos | efeito_marca     | trilha
      t        |      t       |            1            | Comunidade Final |   1
```

Após encerrar o processo, nenhuma conexão `campaigns-worker` ou `pgboss`
permaneceu aberta.

### Modelo de privilégios, conferido no banco

```text
rolname     | super | bypassrls | createdb | createrole
app_user    |   f   |     f     |    f     |     f
app_worker  |   f   |     f     |    f     |     f

schema | dono                     worker pode criar schema : f
public | pg_database_owner        api    pode criar schema : f
app    | <dono do schema>
pgboss | app_worker
```

---

## O que ficou de fora, e por quê

- **Renderização dos componentes React.** A lógica de fundação dos frontends foi
  extraída para `@campaigns/shared` e coberta por 18 testes; as telas em si não
  têm teste. Cobri-las exigiria jsdom e uma biblioteca de teste de componente —
  peso que esta rodada foi orientada a não adicionar.
- **`SIGTERM`/`SIGINT` no worker.** O shell do Windows não entrega sinais POSIX a
  um processo Node. O encerramento foi verificado pela liberação das conexões,
  não pelo sinal. Trivial de exercitar no Linux, na rodada de staging.
- **Negação de serviço por bloqueio de conta.** Mitigar exige limite por origem
  antes da autenticação, camada que não existe nesta fase.

---

## Veredito

**Fase 1 aprovada para a rodada de infraestrutura de staging.**

Nada foi commitado, enviado, mesclado nem publicado. A validação termina no
repositório local.
