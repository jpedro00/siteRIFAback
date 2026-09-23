# Fase 1 — Decisões e suposições

Toda decisão que não estava definida nos anexos aparece aqui com o prefixo
**Suposição**. Decisões que apenas aplicam o que os documentos determinam
aparecem como **Decisão**.

---

## 1. Identidade global — a exceção mais importante desta fase

**Conflito (C16):** o DOC-01 §18 diz que "todas as tabelas de negócio têm
`tenant_id`". O DOC-01 §3 diz que "o mesmo usuário pode ter papéis diferentes
em comunidades diferentes". As duas frases não cabem juntas na tabela de login:
uma pessoa tem uma credencial e participa de N comunidades.

**Decisão — explícita, não escondida numa policy:**

| Tabela | `tenant_id`? | Por quê |
|---|---|---|
| `users` | **não** | identidade global |
| `user_credentials` | **não** | segredo da identidade |
| `user_mfa_factors` | **não** | segredo da identidade |
| `sessions` | **não** | sessão é da pessoa, não da comunidade |
| `platform_admins` | **não** | privilégio de plataforma |
| `memberships` | **sim** | é o vínculo, e é onde o isolamento começa |
| `tenant_branding`, `tenant_domains` | **sim** | dado da comunidade |
| `audit_events`, `outbox` | **nulável** | `NULL` = evento de plataforma |

**Como o acesso é restringido apesar de não haver `tenant_id`** (migration
`0005`): `users` tem RLS ativa e a policy só libera (a) o próprio usuário,
(b) quem tem vínculo vigente na comunidade resolvida no momento, (c) acesso de
plataforma verificado. Sem isso, "não ter `tenant_id`" significaria que o papel
da aplicação leria a base inteira de usuários.

**Testado em** `packages/db/tests/tenant-isolation.test.ts`: no contexto de A,
o usuário de B não é legível, e o segredo de MFA de outra pessoa não é legível
nem pelo dono da comunidade.

---

## 2. Autenticação

**Suposição:** os anexos exigem autenticação real e MFA (RN12) mas não escolhem
biblioteca nem provedor. Escolhas desta fase:

| Peça | Escolha | Motivo |
|---|---|---|
| Senha | `scrypt` do `node:crypto` | KDF com custo de memória, recomendada pelo OWASP, mantida pelo próprio runtime. bcrypt e argon2 exigem binário nativo, que quebra com frequência em Windows e em CI enxuto. Parâmetros gravados dentro do hash permitem aumentar o custo depois sem migration. |
| Segundo fator | `otplib` v13 (TOTP, RFC 6238) | Mantida, sem binário nativo, compatível com os autenticadores usuais. Traz proteção de replay nativa via `afterTimeStep`. |
| Sessão | Token opaco de 32 bytes, SHA-256 no banco, cookie httpOnly | A fase exige **revogação**. Um JWT autocontido continua valendo até expirar; revogar exigiria uma lista de bloqueio — ou seja, a consulta ao banco que o JWT queria evitar. |
| Segredo TOTP | AES-256-GCM, chave no ambiente | GCM é autenticado: registro adulterado falha em vez de devolver lixo. Um dump do banco não gera códigos válidos. |

**Consequência operacional:** perder `MFA_ENCRYPTION_KEY` invalida todos os
segundos fatores cadastrados. Isso precisa entrar no procedimento de operação.

---

## 3. Tabelas auxiliares — por que cada uma é indispensável

O pedido manda incluir as auxiliares da autenticação escolhida **explicando sua
necessidade**:

- **`user_credentials`** — separada de `users` para que (a) o hash nunca entre
  num `SELECT` de perfil por acidente, (b) o bloqueio por tentativas não
  escreva na linha de identidade lida por toda a aplicação, (c) a credencial
  possa ser rotacionada sem tocar no histórico da identidade.
- **`user_mfa_factors`** — o segredo TOTP tem ciclo de vida próprio
  (cadastrado → confirmado → revogado), independente da senha. `last_used_step`
  impede replay do mesmo código dentro dos 30 s.
- **`sessions`** — sem ela não existe logout nem revogação. `mfa_satisfied_at`
  é **por sessão**: ter o fator cadastrado não basta; RN12 exige ter passado
  pelo fator *nesta* sessão.
- **`platform_admins`** — privilégio de plataforma concedido um a um. Nenhuma
  linha aqui nasce como efeito de virar dono de comunidade.
- **`tenant_domains`** — estrutura para domínio próprio (DOC-01 §2, passo 6).
  `verified_at IS NULL` não resolve: registrar o domínio não prova posse.
- **`event_consumptions`** — idempotência do consumidor. Ver item 6.

---

## 4. Contexto de tenant e RLS

**Decisão:** o contexto vai por `set_config(..., true)` — **local à transação** —
dentro de `withContext` (`packages/db/src/context.ts`). Nunca `SET` comum.

Motivo: `SET LOCAL` morre no COMMIT/ROLLBACK. Uma conexão devolvida ao pool e
reaproveitada por outra requisição **não** carrega o tenant anterior. Com `SET`
comum, carregaria — e a requisição seguinte leria dados da comunidade errada.

**Defesa extra:** `RESET ALL` antes de devolver a conexão ao pool, caso algum
código futuro use `SET` em vez de `SET LOCAL`.

**Ausência de contexto nega:** `current_setting('app.tenant_id', true)` devolve
NULL, `tenant_id = NULL` é NULL, nenhuma linha passa. Não existe fallback para
comunidade padrão.

**Suposição — `app.platform_access`:** a RLS reconhece acesso de plataforma por
um GUC que a API liga somente depois de verificar papel de plataforma **e** MFA
satisfeito. A RLS aqui é defesa em profundidade contra consulta sem filtro; a
decisão de autorização vive na API e tem teste próprio. A aplicação pode, em
tese, ligar o GUC por conta própria — isso é o limite do modelo, e está
registrado em vez de ser apresentado como garantia.

**Integridade entre comunidades:** `memberships` e `tenant_domains` ganharam
chave composta `UNIQUE (tenant_id, id)`, para que as tabelas de negócio das
próximas fases possam referenciar `(tenant_id, x_id)` em conjunto. Um FK
simples por id deixaria uma linha de A apontar para um registro de B.

---

## 5. Papéis

**Suposição:** os códigos persistidos ficam em inglês (`OWNER`, `FINANCE`,
`MARKETING`, `SUPPORT`, `OPERATOR`), com rótulos em português na interface.

Justificativa: a restrição de "nomes fixos" do DOC-01 e do PROMPT_ASTRA cobre
os **estados de sorteio e de número** e as **colunas de grade e preço** —
o DOC-01 apresenta os papéis apenas como rótulos de tabela. Os estados, esses
sim, foram preservados literalmente em português, com acento e espaço.

**Decisão — "olho / só status" vira permissão separada.** A matriz do DOC-01 §3
distingue "ver pagamentos e conciliação" de "só status". Viraram
`payment:read:full` e `payment:read:status`. `buyer:read:full` é um terceiro
eixo, independente dos dois. Assim:
- Suporte vê o comprador e **não** vê conciliação nem estorna;
- Operador vê status do pagamento e **não** vê dados do comprador.

**Suposição (S8 aberta) — matriz do Super Admin.** O DOC-01 §17 nomeia as
áreas (Revisão, Risco, Cobranças, Saúde) mas não publica matriz por
sub-perfil. A distribuição adotada é conservadora: cada sub-perfil recebe
apenas a sua área, mais leitura de saúde. Nenhum recebe tudo. Precisa de
validação do produto.

**Decisão:** papel de comunidade **nunca** concede permissão de plataforma, e
vice-versa. Testado nos dois sentidos.

---

## 6. Outbox × fila — a distinção que mais se erra

**Decisão explícita:**

- A **outbox** é o *registro transacional* do que aconteceu, gravado pela API
  na mesma transação da mudança. Rollback apaga o evento junto.
- A **fila** (pg-boss) é o *mecanismo de execução*.
- O **relay** só leva o evento do registro até a fila. `published_at` significa
  "entreguei à fila" — **nada além disso**. Não significa trabalho concluído.
- A conclusão de cada consumidor vive em **`event_consumptions`**, outra
  tabela, com outra chave `(event_id, consumer)`.

**Garantia real: AO MENOS UMA VEZ.** Se a fila aceitar e o COMMIT que marca
`published_at` falhar, o evento será republicado. Não há promessa de "exatamente
uma vez" para efeito externo, e **nenhuma constraint sozinha produziria isso**.
O que impede efeito duplicado é a idempotência do consumidor.

**Evento real usado para verificar o fluxo:** `tenant.created` → consumidor
`provision-tenant-branding`, que provisiona a marca padrão. O consumidor
reivindica o evento em `event_consumptions` e executa o efeito **na mesma
transação**; reprocessar colide na chave primária e não repete.

**Não há cobrança nem envio comercial** no worker desta fase.

---

## 7. Enum único (prevenção do erro E3)

**Decisão:** os tipos `draw_status` e `draw_number_status` são criados **na
fundação** (`0002_shared_enums.sql`), embora as tabelas `draws` e
`draw_numbers` pertençam à Fase 2.

Motivo: E3 aconteceu porque havia dois vocabulários — um no código, outro no
banco — evoluindo em separado, até uma CHECK desatualizada bloquear inserts de
reserva. Criar o vocabulário antes das tabelas, com teste comparando `pg_enum`
com o array de `packages/shared`, é o que impede as duas listas de divergirem.

O teste `packages/db/tests/enum-parity.test.ts` falha nos dois sentidos e ainda
verifica que `'CATIVO PENDENTE'` é aceito e `'CATIVO_PENDENTE'` é recusado.

---

## 8. Redis × PostgreSQL (C03) — registrado, não implementado

O DOC-01 §9 e o D01 desenham Redis para a trava de reserva. O painel do
PROMPT_ASTRA escolhe, para a fase inicial, **só PostgreSQL**: transação +
índice único parcial.

**Nada de reserva foi implementado nesta fase.** A opção fica registrada para a
Fase 2, junto com o alerta de que a escolha diverge do desenho da referência
principal e precisa de decisão consciente — não de precedência automática.

---

## 9. Pendências que seguem abertas

Nenhuma delas impediu construir a fundação; nenhuma foi resolvida inventando
regra:

| Código | Pendência |
|---|---|
| C06 | Pausa de cativos: §7 e §10 divergem. |
| C07 / S1 | `ESTORNADO` terminal × retorno a `LIVRE`. Implementado como terminal; a volta não virou regra. |
| S3 / S4 | Pagamento após expiração, fechamento ou snapshot. |
| C09 | Consentimento por evento e canal. |
| S5 | Algoritmo para grade de 500 e número não vendido. |
| C11 | Edição de imagens durante revisão. |
| C12 | `campaign_versions` × `draw_versions`. |
| C13 | Rotas de reserva divergentes. |
| C22 | Limite monetário da segunda aprovação de estorno — nenhum valor arbitrário foi adotado. |
| C24 | Recorrência SaaS (M11) sem contrato completo. |
| S6 | `AGENDADA` continua identificada como suposição. Está no catálogo de estados; a ativação **não** foi implementada. |
| S8 | Matriz detalhada do Super Admin. |

### Limites conhecidos, registrados na validação total

Reais, e nenhum deles impede a fundação:

| Item | Situação |
|---|---|
| Telas dos frontends sem teste de renderização | A lógica de fundação está em `@campaigns/shared` e é coberta; os componentes não. Cobri-los exigiria jsdom e uma biblioteca de teste de componente. |
| Bloqueio de conta como negação de serviço | A resposta uniforme impede descobrir **quais** contas existem, mas quem já souber um e-mail válido pode trancá-lo. Mitigar exige limite por origem antes da autenticação. |
| Cache no `originGuard` | Cada `Origin` desconhecida consulta o banco. |
| Encerramento gracioso do worker | Verificado pelo código e pela liberação das conexões; `SIGTERM`/`SIGINT` não são entregáveis a um processo Node pelo shell no Windows. Trivial de exercitar no Linux, na rodada de staging. |

---

## 10. Defeitos encontrados na execução com PostgreSQL real e corrigidos

A primeira execução da suíte com banco real (202 testes) expôs quatro defeitos.
Dois eram das asserções; **dois eram da implementação** e valiam correção.

### D-1 · Cabeçalho `x-tenant-slug` aceito fora de desenvolvimento — IMPLEMENTAÇÃO

**Observado:** host desconhecido + cabeçalho `x-tenant-slug` devolvia **200**
onde deveria devolver 404.

**Por que era grave:** o cabeçalho é um seletor de comunidade **controlado pelo
cliente**. Aceito incondicionalmente, qualquer requisição — de qualquer host —
escolhia a comunidade que quisesse, e a regra "domínio desconhecido devolve
404" virava letra morta, porque o host deixava de importar. Isso contraria
diretamente "não confie em `tenant_id` arbitrário enviado pelo cliente": um
slug de cabeçalho é a mesma coisa com outro nome.

Os painéis autenticados continuavam protegidos (o vínculo é sempre conferido
no banco), mas `/api/public/tenant` não tem checagem de vínculo — a marca de
qualquer comunidade podia ser lida de qualquer host.

**Correção:** nova chave `TENANT_HEADER_ENABLED`, **desligada por padrão**. Com
ela desligada o cabeçalho é ignorado por completo. A carga da configuração
**recusa** `true` com `NODE_ENV=production`. Coberto por
`host desconhecido NAO e salvo pelo cabecalho quando ele esta desligado`.

### D-2 · Origem HTTP desconhecida não era recusada — IMPLEMENTAÇÃO

**Observado:** origem fora da lista seguia executando; a resposta só omitia os
cabeçalhos CORS.

**Por que era grave:** omitir os cabeçalhos impede o navegador de **ler** a
resposta, mas a requisição **já foi executada no servidor**. Numa API
autenticada por cookie, uma escrita vinda de um site qualquer teria efeito
antes de o navegador barrar a leitura.

**Correção:** requisição com `Origin` fora da lista é recusada com **403** na
entrada. Requisição **sem** `Origin` (servidor-a-servidor, `curl`, navegação
direta) não é afetada — `Origin` é posto pelo navegador, e sua ausência não
caracteriza origem cruzada.

### D-3 · Inventário de `tenant_id` exigia a coluna na raiz — ASSERÇÃO

O teste exigia `tenant_id` em toda tabela, inclusive em `tenants`. Mas
`tenants.id` **é** o `tenant_id`: uma coluna apontando para si mesma não faria
sentido. A raiz passou a ter verificação própria (PK `uuid` + RLS ativa), em
vez de ser apenas ignorada.

### D-4 · Fixture de sessão expirada violava a CHECK — ASSERÇÃO

O teste envelhecia só `expires_at`, violando
`sessions_expires_after_creation (expires_at > created_at)`. A CHECK estava
certa; o teste é que criava uma sessão impossível. Agora a sessão é envelhecida
por inteiro, como uma sessão antiga de verdade.

---

## 10bis. Defeitos encontrados na VALIDAÇÃO TOTAL e corrigidos

A validação completa com PostgreSQL real expôs cinco defeitos de implementação,
um de configuração e três inconsistências entre documentação e código. Nenhum
foi contornado afrouxando regra.

### D-5 · RN12 contornável por elevação de papel — IMPLEMENTAÇÃO, crítico

**Observado**, reproduzido contra a API real:

```text
SUPPORT loga (sem MFA) → promovido a OWNER → GET /api/tenant/audit-events → 200
usuário comum loga     → recebe PLATFORM_OPERATIONS → GET /api/platform/tenants → 200
```

O segundo atravessa a fronteira da plataforma inteira.

**Causa raiz.** A sessão de quem não exigia MFA nascia com `mfa_satisfied_at =
now()`. `authenticateSession` recalculava `mfaRequired` e `mfaEnrolled` a cada
requisição, mas lia a marca **congelada no login**. A trava
`mfaRequired && !mfaSatisfied` nunca disparava.

A confusão é de significado: a coluna representava duas coisas diferentes —
"comprovou o fator" e "não precisava comprovar".

**Correção.** `mfa_satisfied_at` passa a significar **exclusivamente** "esta
sessão apresentou e validou um segundo fator". A sessão nasce sempre com a marca
nula. A autorização pergunta separadamente "precisa?" e "comprovou?", e só
bloqueia quando a primeira é sim e a segunda é não. Promoção de papel vale na
requisição seguinte, sem logout.

Quem não está sob RN12 não foi afetado: há teste cobrindo marketing, suporte e
operador usando o painel normalmente.

### D-6 · A sessão não rotacionava o token na elevação — IMPLEMENTAÇÃO

Completar o segundo fator elevava a sessão **mantendo o mesmo token**. Um token
capturado antes da verificação virava sessão privilegiada no instante em que a
pessoa legítima completasse o MFA — sem que quem o capturou precisasse do fator.

**Correção.** O `token_hash` é substituído na elevação. A linha da sessão
permanece (o identificador continua ligando a trilha ao mesmo episódio de
acesso); o que muda é o segredo portador.

### D-7 · Cadastro do MFA sem as defesas da verificação — IMPLEMENTAÇÃO

`confirmMfaEnrollment` não tinha bloqueio por tentativas nem anti-replay, embora
termine em **sessão elevada** exatamente como a verificação. Um atacante com a
senha escolheria o endpoint mais fraco.

**Correção.** Os dois fluxos passaram a compartilhar as mesmas funções de
bloqueio e o mesmo contador — contadores independentes dariam o dobro de
tentativas.

### D-8 · O bloqueio de conta revelava a existência do e-mail — IMPLEMENTAÇÃO

`429 RATE_LIMITED` para conta bloqueada contra `401` para e-mail inexistente.
Bastava gastar as tentativas de um endereço e ler o código de status.

**Correção.** Resposta uniforme para toda recusa. A senha é verificada antes de
qualquer decisão, para o tempo não denunciar o caso. Tentativa contra conta já
bloqueada não é contabilizada — contabilizar empurrava `locked_until` para
frente a cada requisição, e qualquer um manteria uma conta trancada para sempre.

O bloqueio continua existindo. O que some é o sinal externo.

**Limite que permanece:** quem já souber um e-mail válido pode trancá-lo.
Registrado no README; mitigar exige limite por origem antes da autenticação.

### D-9 · A policy de trilha de identidade era inoperante — IMPLEMENTAÇÃO

A `0007` criou `audit_identity_insert` para `action LIKE 'auth.%'`, mas nenhum
evento de identidade era gravado. Ao implementá-los, a inserção era recusada com
`new row violates row-level security policy` **mesmo satisfazendo todas as
condições da policy de INSERT**.

**Causa raiz, e ela não é óbvia:** `recordAuditEvent` usava `INSERT ... RETURNING
id`. O `RETURNING` faz a linha recém-inserida passar **também pela policy de
SELECT** — e `audit_events_select` só enxerga o que pertence a uma comunidade. A
linha era aceita na escrita e recusada na leitura, e o PostgreSQL relata os dois
casos com a **mesma** mensagem, o que faz o erro parecer recusa de escrita.

**Correção.** A trilha passou a ser inserida sem `RETURNING`. Nenhum chamador
usava o identificador devolvido. Numa tabela somente-inserção, ler de volta a
linha para confirmar que ela foi escrita acopla escrita a leitura sem motivo — e
obrigaria a abrir leitura só para isso.

### D-10 · `apps/worker` inteiro desalinhado — CONFIGURAÇÃO

O `package.json` apontava para `src/main.ts`, `dist/main.js` e `dist/index.js`;
o arquivo real é `src/worker.ts`. `npm run dev:worker` falhava com
`ERR_MODULE_NOT_FOUND`. Corrigido para a implementação real; `main`, `types` e
`exports` foram removidos — o worker é uma **aplicação**, nada o importa como
biblioteca. A pasta vazia `src/jobs/` foi removida: os consumidores vivem em
`src/consumers/`, e pasta vazia sugere trabalho que não existe.

Junto com ele, um erro garantido em produção: o worker lia `DATABASE_URL`, que no
`.env` da raiz é a conexão da **API** (`app_user`). Subiria com o papel errado e
falharia no primeiro `UPDATE outbox`. Passou a ler `WORKER_DATABASE_URL`.

### D-11 · "Esgotou as tentativas" não tirava o evento do fluxo — IMPLEMENTAÇÃO

O relay empurrava `available_at` uma hora para frente. Como o critério de
varredura é "não publicado e disponível", o evento voltava a ser reclamado a cada
hora, **indefinidamente**. O comentário dizia "fica parado"; o código dizia outra
coisa.

**Correção.** Coluna `dead_lettered_at` (0008), com CHECK que impede o estado
contraditório "entregue à fila e esgotado". O evento sai do fluxo de forma
inequívoca e permanece visível para inspeção — sair do esgotamento exige ação
deliberada. O índice de varredura foi refeito para refletir o novo critério.

### D-12 · Privilégios do pg-boss: três afirmações incompatíveis — ARQUITETURA

O `.env.example` sugeria superusuário; `queue.ts` afirmava que `app_worker` não
recebe DDL; a `0007` dava a **posse** do schema `pgboss` ao `app_worker`.

**Fato descoberto na validação:** `CREATE SCHEMA IF NOT EXISTS` exige `CREATE` no
**banco** mesmo quando o schema já existe — o PostgreSQL confere o privilégio
antes de considerar o `IF NOT EXISTS`. Logo, ou o worker recebe privilégio de
criação no banco, ou a instalação é uma etapa à parte.

**Decisão:** etapa à parte, como manda o princípio de menor privilégio para um
processo de execução contínua.

```text
INSTALAÇÃO  npm run queue:install   papel administrativo, uma vez
RUNTIME     npm run dev:worker      app_worker, sem DDL no banco
```

O instalador cria os objetos e **transfere a posse** para `app_worker` — é isso
que o dispensa de GRANTs avulsos (que precisariam de revisão a cada versão do
pg-boss) e o deixa aplicar as migrations de versão da fila sem nunca poder criar
um schema novo. O runtime recusa subir se a fila não estiver instalada, com a
instrução do que fazer, em vez de tropeçar num `permission denied` cru.

Há teste provando que o papel do worker **não** consegue criar schema.

### D-13 · A bancada de teste nunca declarava `CORS_ORIGINS` — TESTE

`createHarness` chamava `loadConfig` sem a chave, então `config.corsOrigins`
nascia vazio: o teste do ramo positivo do `originGuard` falhava **por
construção**, em qualquer máquina e no CI, e o caminho de allowlist ficava sem
cobertura nenhuma. Corrigido com uma allowlist explícita de domínios `.test`
(RFC 2606) e cobertura dos casos que faltavam, incluindo lista vazia e preflight.

### D-14 · Erro de rede tratado como logout — IMPLEMENTAÇÃO (frontends)

O comentário dizia "erro de rede não deve fingir que a pessoa está deslogada" e
as duas linhas seguintes faziam exatamente isso. Uma queda de três segundos
derrubava a interface para a tela de login.

**Correção.** `classifySessionFailure` distingue "o servidor respondeu que não há
sessão" de "não consegui perguntar", e os três frontends ganharam o estado
`unavailable`, com tela própria e ação de tentar novamente. A regra vive em
`@campaigns/shared` e tem teste — os três frontends mantinham a mesma conta em
três cópias, que já haviam divergido.

### D-15 · Corrida no slug da comunidade — IMPLEMENTAÇÃO

`SELECT` seguido de `INSERT` devolvia 500 quando duas requisições simultâneas
passavam pela verificação. A constraint continua sendo a autoridade; a violação
de unicidade passou a ser traduzida para **409**.

### D-16 · O CI rodava a suíte inteira duas vezes — CI

Uma execução para os humanos lerem e outra só para gerar o relatório JSON da
verificação de teste pulado. Dobrava o tempo e reaplicava as migrations sem
cobrir um teste a mais. Agora é **uma** execução com dois repórteres, e a
verificação lê o relatório dela.

---

## 11. Migration 0007 — checksum divergente

O banco de teste registra a versão `0007` com um checksum que **não** é o do
arquivo atual: uma migration diferente, de outra sessão, foi aplicada e depois
substituída no disco.

**O runner recusar é o comportamento correto** — é a prevenção do erro E6
(coluna e CHECK criadas por patch manual, fora do arquivo versionado)
funcionando.

**Resolução:** o **repositório é a fonte da verdade**; o banco de teste é
descartável. Nem afrouxar a guarda, nem editar `schema_migrations` à mão:

```bash
npm run db:reset-test
```

O script recusa qualquer banco cujo nome não termine em `_test`.

Nada foi aplicado em produção, e nenhuma migration precisou ser renumerada.
