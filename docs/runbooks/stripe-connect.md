# Runbook — homologação e rollout do Stripe Connect

> **Estado:** PLANO. Nada deste documento foi executado. Sem migration externa, sem deploy, sem
> Stripe live, sem pagamento real. O recurso nasce **desligado** (`CONNECT_ENABLED=false`).
>
> Este runbook **não** é parecer jurídico nem financeiro.

Complementa `docs/runbooks/staging.md` (infraestrutura) e, em particular, a seção
[Recebimento via Stripe Connect — desligado por padrão](staging.md#recebimento-via-stripe-connect--desligado-por-padrão),
que já descreve chave, webhooks, variáveis e a ordem de ativação resumida. Aqui está o que
falta: pré-requisitos externos, roteiro de teste, perguntas em aberto, limitações e rollback.
Spec: `docs/superpowers/specs/2026-10-15-stripe-connect-recebimento-design.md`.

## 1. Visão geral e responsabilidades

- O criador cadastra uma conta **Connect Express** (BR) pelo formulário hospedado pela Stripe, em
  `/painel/recebimentos`, e volta ao painel.
- O PIX é cobrado na conta da **plataforma** (*destination charge*: `PaymentIntent` com
  `transfer_data.destination` = conta do criador) e repassado a ele, descontada a taxa
  (`application_fee_amount`).
- A taxa vem do **plano** da comunidade (`plans.platform_fee_bps`); sem plano ou sem valor no
  plano vale `billing_settings.default_platform_fee_bps` (padrão **500 = 5%**). A taxa é
  congelada no pagamento (`payments.platform_fee_bps` / `platform_fee_cents`).
- **A plataforma responde perante a Stripe** por estornos e disputas (chargebacks) desses
  pagamentos: o dinheiro entra na conta da plataforma. O estorno total devolve também a taxa
  (`refund_application_fee`) e reverte o repasse (`reverse_transfer`).
- O aviso da Stripe **não vale como verdade**: a API/worker consulta a Stripe antes de aplicar
  (RN06). A chave é uma só, da plataforma; não há token por criador.
- **Desligado por padrão.** Com `CONNECT_ENABLED=false`, as rotas `connect-stripe`,
  `refresh-stripe` e o webhook `stripe-connect` respondem 404, os jobs ignoram pagamentos
  `STRIPE` e o Mercado Pago segue idêntico.

## 2. Pré-requisitos externos (não são código)

Nada abaixo se resolve com deploy. O teste em modo teste pode começar antes de tudo estar
fechado; **produção não**.

- [ ] **Connect habilitado** na conta Stripe da plataforma (modo teste e, depois, live).
- [ ] **PIX disponível** na conta da plataforma, e para este uso (cobrança PIX com
      *destination charge* para conta conectada brasileira).
- [ ] **Confirmação por escrito da Stripe** de que rifas/sorteios é segmento aceito. Guardar a
      resposta; a Stripe pode restringir contas por segmento.
- [ ] **Validação jurídica**, já pendente para o lançamento. A plataforma passa a receber
      dinheiro de terceiros antes de repassar, o que pode ter implicações regulatórias. Este
      documento não substitui parecer.
- [ ] **Decisão sobre estorno/disputa**: quem arca com o estorno e com a perda em disputa, e se
      a taxa é devolvida (o código devolve a taxa em estorno total; ver §6).
- [ ] **Rotação das chaves Stripe que foram coladas em conversa.** Tratar como comprometidas:
      revogar no Dashboard e criar novas. Nunca repetir nem gravar valores de chave em
      repositório, ticket ou chat.

## 3. Variáveis por serviço

Sem valores. Placeholders: `<STRIPE_SECRET_KEY>`, `<WHSEC_...>`.

| Variável | API (Render) | Worker (Render) | Vercel (frontends) |
|---|---|---|---|
| `CONNECT_ENABLED` | sim | sim | não |
| `STRIPE_SECRET_KEY` (`<STRIPE_SECRET_KEY>`) | sim | sim | **não** |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | sim | não | não |
| `ORGANIZER_PANEL_URL` (ou `BILLING_RETURN_URL`) | sim | não | não |
| `PUBLIC_API_BASE_URL` | sim | — | — |

O frontend não precisa de chave Stripe nem de variável nova.

- `CONNECT_ENABLED=true` faz a API **recusar subir** sem `STRIPE_SECRET_KEY`,
  `STRIPE_CONNECT_WEBHOOK_SECRET` e `ORGANIZER_PANEL_URL`/`BILLING_RETURN_URL`; o worker recusa
  subir sem `STRIPE_SECRET_KEY`.
- Chave `sk_live_`/`rk_live_` só com `NODE_ENV=production`; com Connect ligado em produção, a
  chave **precisa** ser live (e em staging, só teste).
- `STRIPE_CONNECT_WEBHOOK_SECRET` é uma lista separada por vírgula: **dois** segredos, um por
  endpoint (§4, passo 1).
- É a mesma `STRIPE_SECRET_KEY` da cobrança de assinaturas (`BILLING_PROVIDER=stripe`), se ela
  estiver ligada.

### Permissões mínimas da chave restrita

Levantadas dos métodos do SDK realmente chamados em `packages/payment-accounts/src/connect.ts` e
`packages/psp/src/stripeConnect.ts`:

| Chamada no código | Permissão |
|---|---|
| `accounts.create` | Connect → Accounts (escrita) |
| `accounts.retrieve` | Connect → Accounts (leitura) |
| `accountLinks.create` | Connect → Account Links (escrita) |
| `paymentIntents.create` | PaymentIntents (escrita) |
| `paymentIntents.retrieve` (com `expand: ['latest_charge']`) | PaymentIntents (leitura) |
| `refunds.create` (`refund_application_fee`, `reverse_transfer`) | Refunds (escrita) |
| `refunds.list` (`payment_intent`; estorno que falhou, webhook) | Refunds (leitura) |

**Observações (a confirmar na homologação, §5):**

- **Transfers** consta na lista do plano e do `staging.md`, mas o código não chama a API de
  transferências diretamente; a reversão do repasse acontece dentro do `refunds.create`. Manter
  na chave de teste e verificar se o estorno funciona sem ela.
- `expand: ['latest_charge']` pode exigir leitura de **Charges** na chave restrita. Se o
  `paymentIntents.retrieve` falhar com erro de permissão, é esta.
- Falta de permissão no estorno aparece como falha transitória do worker (§6): o estorno tenta
  de novo e, esgotada a fila, fica para o operador.
- Webhooks usam apenas a assinatura (`whsec_`); não dependem de permissão da chave.

### Ordem de aplicação

1. Pré-requisitos externos (§2).
2. **Migrations 0027–0032 ANTES do código** (workflow *Migrar staging*, ver `staging.md`,
   seção "Migrações"). Todas são aditivas.
3. Variáveis (`CONNECT_ENABLED` ainda `false`), deploy do código, conferir que nada mudou.
4. Só então o roteiro da §4 (liga `CONNECT_ENABLED=true` no staging).

> **AVISO — banco de staging sem backup.** O banco de staging é o projeto Supabase **`RIFAS`** e,
> por decisão registrada do dono do projeto, **não tem backup**. As migrations 0027–0032 só
> foram aplicadas até hoje no **banco de teste local**. **Peça confirmação explícita do dono
> antes de aplicar.** Sugestão (não imposição): um `pg_dump` manual antes de migrar, ao menos
> das tabelas `payments`, `plans`, `billing_settings` e `payment_provider_authorizations`.
> A `0027` usa `ALTER TYPE ... ADD VALUE` (não se desfaz) e a `0028` troca a constraint
> `payments_provider_known`.

## 4. Roteiro de homologação — modo TESTE da Stripe

Staging, chave `rk_test_`/`sk_test_`, nunca live. Cada passo traz o resultado esperado.

1. **Criar os dois endpoints de webhook** (Dashboard em modo teste → *Developers → Webhooks*),
   ambos com URL `{PUBLIC_API_BASE_URL}/api/webhooks/stripe-connect`:
   - Endpoint **"Your account"**: `payment_intent.succeeded`, `payment_intent.payment_failed`,
     `payment_intent.canceled`, `charge.refunded`, `refund.failed`, `refund.updated`
     (`charge.refund.updated` também é tratado, mas é um subconjunto de `refund.updated` — os
     estornos de cobrança —, então assiná-lo é desnecessário).
   - Endpoint **"Connected accounts"**: `account.updated`.

   Copie os dois `whsec_...` para `STRIPE_CONNECT_WEBHOOK_SECRET` (separados por vírgula).
   *Esperado:* dois endpoints, cada um com o seu segredo.
2. **Ligar `CONNECT_ENABLED=true` só no staging** (API e worker), com as demais variáveis da §3;
   redeploy dos dois. *Esperado:* ambos sobem (faltando variável obrigatória, a API não sobe);
   `POST .../connect-stripe` deixa de responder 404.
3. **Criar conta de teste** em `/painel/recebimentos` → conectar Stripe. Preencher o formulário
   hospedado com os dados de teste da Stripe para contas Express do Brasil e o CPF/dados de
   teste da documentação oficial (<https://docs.stripe.com/connect/testing>; não use dados
   reais nem invente números). *Esperado:* volta ao painel em `/recebimentos`.
4. **Conferir estados:** logo ao voltar, *Cadastro em andamento*; após `account.updated` (ou
   `refresh-stripe`), conta ativa (pode receber). *Esperado:* `charges_enabled` e
   `payouts_enabled` verdadeiros.
   ```sql
   SELECT provider_account_id, status, charges_enabled, payouts_enabled, requirements_due
     FROM payment_provider_authorizations WHERE provider = 'STRIPE';
   ```
   Eventos recebidos (`stripe_connect_webhook_events` é lida só pelo dono/admin; `processed_at`
   nulo e repetido = entrega falhando):
   ```sql
   SELECT type, account, received_at, processed_at
     FROM stripe_connect_webhook_events ORDER BY received_at DESC LIMIT 20;
   ```
5. **Atribuir um plano com taxa diferente** (Console Super Admin → Planos → taxa da plataforma,
   p.ex. 700 bps) à comunidade e **ativar uma rifa**. *Esperado:* a rifa aceita venda; o
   painel mostra a Stripe como meio de pagamento.
6. **PIX de teste:** comprar um número na vitrine pagando por PIX. Em modo teste não há banco
   real: no Dashboard (modo teste), abra o PaymentIntent e use a ação de simular/autorizar o
   pagamento PIX que a página dele oferece (ver <https://docs.stripe.com/payments/pix> para o
   comportamento em teste). *Esperado:* `payment_intent.succeeded` chega ao endpoint
   "Your account".
7. **Conferir o resultado:**
   ```sql
   SELECT id, status, amount_cents, platform_fee_bps, platform_fee_cents, paid_at
     FROM payments WHERE provider = 'STRIPE' ORDER BY created_at DESC LIMIT 5;
   SELECT o.id, o.status, p.status AS payment_status
     FROM orders o JOIN payments p ON p.order_id = o.id
    WHERE p.provider = 'STRIPE' ORDER BY p.created_at DESC LIMIT 5;
   ```
   *Esperado:* pagamento `APROVADO`, pedido `PAGO`, `platform_fee_bps` = taxa do plano e
   `platform_fee_cents` = taxa aplicada ao valor; no Dashboard, o PaymentIntent tem
   `application_fee_amount` igual e um repasse ao `acct_` do criador líquido da taxa.
8. **Estornar** (Dashboard → pagamento → estorno total). *Esperado:* `charge.refunded` →
   pagamento `ESTORNADO` (`paid_at` permanece); no Dashboard, a *application fee* aparece
   devolvida e o repasse revertido. O pedido continua `PAGO` (§6: estorno feito fora da
   plataforma).
   ```sql
   SELECT status, paid_at, needs_manual_refund, refund_reason FROM payments WHERE id = '<payment.id>';
   ```
9. **Estorno automático (opcional):** pagar um PIX depois de ele ter expirado na plataforma, ou
   com o número já vendido a outro. *Esperado:* o pagamento é marcado `needs_manual_refund`, o
   worker (evento `payment.refund_required`) estorna na Stripe e o pagamento termina
   `ESTORNADO`.
10. **Expirar um PIX:** criar outro PIX e não pagar; esperar `expires_at` + ~2 min (job
    `expirar-pix`, a cada 5 min). *Esperado:* o worker consulta a Stripe antes (RN06), marca o
    pagamento `EXPIRADO` e libera os números.
    ```sql
    SELECT status, expires_at FROM payments WHERE provider = 'STRIPE' ORDER BY created_at DESC LIMIT 5;
    ```
11. **Desligar `CONNECT_ENABLED=false`** (API e worker), sem cobranças Stripe em aberto (§7).
    *Esperado:* rotas Connect voltam a 404; compra por Mercado Pago (se ligado) funciona como
    antes.

Ao final, preencha as respostas da §5.

## 5. Perguntas a confirmar na homologação

1. **Capacidades da Express.** O código pede `card_payments` + `transfers`. Em *destination
   charge* com PIX no Brasil, **basta `transfers`**? Se sim, simplificar o cadastro (menos
   exigências ao criador).
2. **`cancellation_reason: automatic` → `EXPIRADO`.** O mapeamento não foi confirmado contra a
   Stripe: o PIX que vence sozinho é cancelado com essa razão? Com outra razão, o código
   marcaria `CANCELADO`?
3. **Lista real de `requirements`** (`requirements_due`) para contas BR, para ajustar a cópia do
   painel.
4. **Entrega dos eventos `payment_intent.*`** (e `charge.refunded`) no endpoint
   "Your account": chegam todos mesmo sendo destination charge?
5. **Permissões da chave** (§3): `Transfers` e `Charges` são necessários?
6. **Taxa igual ao valor (100%)** passa nas constraints (`platform_fee_bps` até 10000 e
   `platform_fee_cents` até `amount_cents`). Permitir isso é **decisão de produto**.
7. O `paymentTypeId` `bank_transfer` usado em `listPaymentMethods` é suposição do ledger:
   conferir a tradução na API e que a vitrine mostra o PIX da Stripe como esperado.
8. **Eventos de estorno (`refund.failed`, `refund.updated`) no endpoint "Your account".** Em
   *destination charge* o estorno é criado na conta da plataforma, então devem chegar por lá (e
   não pelo "Connected accounts") — **confirmar** na homologação. Confirmar também como simular,
   em modo teste, um estorno PIX que falha (se a Stripe oferecer) e que o `refunds.list` do
   PaymentIntent mostra `status: failed` com um `failure_reason` em código.

## 6. Limitações conhecidas e pendências

Do ledger (`.superpowers/sdd/2026-10-15-stripe-connect-recebimento/progress.md`):

- Os retries do estorno automático param no limite da fila (5) e uma conta revogada consome as
  tentativas; depois disso o caso fica para o operador (`needs_manual_refund` segue ligado).
- A limpeza de eventos de webhook (`limpar-stripe-eventos`) não é feita em lotes.
- Estorno de pagamento **APROVADO no Mercado Pago continua manual**, e `ESTORNADO` não é
  terminal para o Mercado Pago.
- Estorno feito **fora da plataforma** (no Dashboard) deixa o pedido `PAGO` e pode abrir a
  divergência `ORDER_PAID_PAYMENT_NOT_APPROVED`.
- `app.connect_apply_account_state` pode ser chamada por qualquer sessão `app_user` (risco
  residual; justificativa em `staging.md`).
- ~~`app.tenant_platform_fee_bps` sem guarda de comunidade~~ — **corrigido**: a função agora
  devolve `NULL` para outra comunidade (só a própria ou o worker leem a taxa), e a API responde
  `PAYMENT_PROVIDER_UNAVAILABLE` (503) se a taxa vier nula.
- PaymentIntents órfãos (criados mas nunca gravados) expiram sozinhos pelo prazo do PIX; não há
  job de cancelamento. Pelo mesmo motivo, ao liberar uma reserva o PaymentIntent não é
  cancelado: um pagamento tardio vira `refund_required`.
- **Risco residual aceito — estorno falho só pelo webhook.** Não há job do worker que consulte
  estornos falhos: se a Stripe desistir de entregar `refund.failed`/`refund.updated` (endpoint
  fora do ar além da janela de reenvio), **nenhuma** divergência `REFUND_FAILED` é aberta. Conferir
  periodicamente no Dashboard (*Payments → Refunds*, filtro *Failed*) até haver uma varredura.
- **Risco residual aceito — estorno `canceled` não alarma.** Só `failed` abre divergência; um
  estorno cancelado (p.ex. pelo próprio Dashboard) não é sinalizado. Decisão de produto
  pendente.

**Adiadas por decisão, com o portão de cada uma:**

1. **Semântica de expiração do PIX na Stripe não verificada.** *Portão: homologação (§4, passo
   10, e §5, pergunta 2).* Confirmar em que estado fica um PaymentIntent PIX vencido. O código
   assume `canceled` com `cancellation_reason: automatic` (→ `EXPIRADO`). Se ele ficar em
   `requires_payment_method`, o worker libera o pedido mas o pagamento continua `PENDENTE` para
   sempre — e um `PENDENTE` é obrigação aberta, que **impede a conta de sair de
   `DISCONNECTING`**. `processing` é mapeado para `PENDENTE` e também é liberado: um sucesso
   tardio vira `refund_required`. Correções possíveis: chamar `paymentIntents.cancel` a partir do
   `expirar-pix` antes de liberar, ou mapear `requires_payment_method` depois do prazo para
   `EXPIRADO`.
2. ~~`refund.failed` / `charge.refund.updated` não são tratados depois de `ESTORNADO`~~ —
   **implementado** (ver "Estorno que falhou depois de `ESTORNADO`", abaixo).
3. **Sem *throttle* por comunidade em `connect-stripe` e `refresh-stripe`.** *Portão: aceitar o
   risco ou resolver antes de produção (checklist, item 12).* O limite de requisições da Stripe
   é por **chave da plataforma**: uma única comunidade chamando essas rotas em rajada pode
   degradar o checkout de todas. Não há middleware reutilizável hoje.
4. **Sem botão de desconectar Stripe no painel.** *Portão: decisão de produto.* A desconexão
   genérica do backend (`POST /api/tenant/payment-accounts/{id}/disconnect`) funciona para linhas
   `STRIPE`; falta só a interface.

### Estorno que falhou depois de `ESTORNADO` (divergência `REFUND_FAILED`)

Um estorno PIX pode falhar **depois** de a Stripe aceitá-lo (p.ex. a conta do comprador foi
encerrada). Para a Stripe, `ESTORNADO` é terminal: o pagamento **continua `ESTORNADO`** e o
código **não** tenta estornar de novo. O que acontece:

- `refund.failed` / `refund.updated` (ou `charge.refund.updated`, subconjunto do anterior) chegam ao webhook Connect
  (endpoint "Your account", §4 passo 1; §5 pergunta 8). O corpo só identifica o PaymentIntent:
  a API acha a comunidade/conta pelo nosso registro (`app.find_payment_route`), confere a conta
  do evento, e **relê na Stripe** os estornos do PaymentIntent (`refunds.list`, depois de
  conferir que o destino é a conta conectada do pagamento — RN06).
- Para **cada** estorno `failed`, `app.record_psp_refund_failed` (migration **0032**) registra
  a falha **uma vez por estorno** (`refundId`), auditando `payment.refund_failed`:
  - sem divergência `REFUND_FAILED` aberta no pagamento: abre uma;
  - com uma aberta (de outro estorno): o novo estorno entra **nela**, em `detail.refunds`;
  - estorno já registrado — numa divergência aberta **ou já resolvida** — não faz nada. A Stripe
    continua listando o estorno falho para sempre; sem isso, o novo estorno feito pelo operador
    reabriria a divergência resolvida.

  `detail` = `{refundId, failureReason, amountCents, refunds: [{refundId, failureReason,
  amountCents}, ...]}` (o primeiro também no topo), sem dado pessoal (`failureReason` é só o
  código da Stripe). Nada novo: `ignored`.
- A divergência aparece no Console Super Admin → Financeiro → conciliação (mesmo com o
  pagamento `ESTORNADO`) e na contagem de abertas da Saúde. A conciliação local **não** a fecha.

**O que o operador faz:**

1. No Dashboard da Stripe, abrir os estornos listados em `detail.refunds` (a consulta abaixo) e o
   PaymentIntent; confirmar que estão `failed` e o motivo.
2. Contatar o comprador (pelo pedido, no painel da comunidade) para combinar a devolução por
   outro meio, ou criar um **novo** estorno pelo Dashboard se a Stripe permitir. Decisão de
   quem arca: ver §2 (estorno/disputa).
3. Registrar o que foi feito e marcar a divergência como *Resolvida manualmente* no Console
   (status de revisão; fecha a divergência). Só a falha de um estorno **novo** abre outra; o
   estorno antigo, ainda `failed` na Stripe, não reabre.

Divergências abertas deste tipo (somente leitura):

```sql
SELECT i.id, i.tenant_id, left(i.order_id::text, 8) AS pedido, p.status AS pagamento,
       r->>'refundId' AS refund_id, r->>'failureReason' AS motivo,
       (r->>'amountCents')::int AS valor_centavos, i.review_status, i.detected_at
  FROM payment_reconciliation_issues i
  JOIN payments p ON p.id = i.payment_id
  CROSS JOIN LATERAL jsonb_array_elements(i.detail->'refunds') AS r
 WHERE i.kind = 'REFUND_FAILED' AND i.resolved_at IS NULL
 ORDER BY i.detected_at;
```

> **Ordem de deploy — frontend ANTES (ou junto) do backend.** O Console Super Admin
> (`apps/admin`, página Financeiro) precisa do rótulo de `REFUND_FAILED` e da renderização
> defensiva de tipos desconhecidos **antes** de o backend poder emitir esse tipo: publique o
> frontend re-sincronizado (contratos 0.18.0 com `REFUND_FAILED`) antes de, ou junto com, o
> backend com a `0032`. Um Console antigo pode quebrar a tela de conciliação ao receber o tipo novo.

> A `0032` troca a constraint `payment_recon_kind_known` (só acrescenta `REFUND_FAILED`). Reverter
> o código deixa a função sem uso; voltar à constraint antiga só sem linhas `REFUND_FAILED`.

## 7. Rollback

**Desligar:** `CONNECT_ENABLED=false` na API **e** no worker. Efeito: rotas e webhook Connect
respondem 404, o cadastro some e o worker deixa de tratar pagamentos `STRIPE`. Nenhum dado é
apagado.

**Cuidado com cobranças em aberto.** Pagamentos Stripe já criados (`PENDENTE`, ou aprovados com
estorno pendente) dependem do worker com Connect **ligado** para serem consultados, expirados ou
estornados. Com o worker desligado e o webhook em 404, eles ficam `PENDENTE` e os números
reservados não são liberados até alguém resolver o pagamento. Como proceder:

1. Preferível: desligar **só a API** (param novos cadastros e cobranças) e **manter o worker com
   `CONNECT_ENABLED=true`** até os PIX pendentes vencerem e não restar estorno pendente:
   ```sql
   SELECT status, needs_manual_refund, count(*) FROM payments
    WHERE provider = 'STRIPE' AND (status = 'PENDENTE' OR needs_manual_refund) GROUP BY 1, 2;
   ```
2. Quando zerar, desligar também o worker.
3. Alternativa: conciliar manualmente, consultando cada PaymentIntent no Dashboard e
   resolvendo pagamento e pedido com o operador.

Com a API desligada, o webhook responde 404 e a Stripe reenvia por um tempo; o worker ainda
concilia por consulta enquanto estiver ligado.

**Requisito obrigatório: o código desta branch exige as migrations 0027–0032 mesmo com
`CONNECT_ENABLED=false`.** O job `limpar-stripe-eventos` do worker chama
`app.purge_connect_webhook_events` (0030) e a leitura das contas de recebimento lê as colunas
novas (`charges_enabled`, `payouts_enabled`, `requirements_due`, 0028) incondicionalmente. Subir o
código antes das migrations quebra o worker e a tela de recebimentos, com o Connect ligado ou
não.

**Reverter código:** redeploy do commit anterior. As migrations 0027–0032 são **aditivas**:
colunas e tabelas novas ficam sem uso. Ressalvas: o valor `STRIPE` do enum `payment_provider`
**não se remove**; a constraint `payments_provider_known` passou a aceitar `STRIPE`, e voltar à
antiga só é possível sem nenhuma linha `STRIPE` em `payments`.

> **ARMADILHA — código anterior trata linhas `STRIPE` como Mercado Pago.** O worker anterior a
> esta branch manda **toda** linha de `payments` pelo resolvedor do Mercado Pago: a
> `conciliacao` antiga varre `PENDENTE`/`EXPIRADO`/`CANCELADO` dos **últimos 3 dias** e o
> `expirar-pix` antigo varre **todo** `PENDENTE`. Uma linha `STRIPE` nesses estados seria
> consultada no Mercado Pago com o id de um PaymentIntent. **Antes de reverter o código, exija:
> nenhum pagamento `STRIPE` criado nos últimos 3 dias e nenhum `STRIPE` `PENDENTE`.**
> ```sql
> SELECT count(*) FILTER (WHERE created_at > now() - interval '3 days') AS ultimos_3_dias,
>        count(*) FILTER (WHERE status = 'PENDENTE') AS pendentes
>   FROM payments WHERE provider = 'STRIPE';
> ```
> Os dois precisam ser `0`. Sem isso, desligue o Connect (acima) e espere a janela passar.

## 8. Checklist de go-live

| # | Item | Feito |
|---|---|---|
| 1 | Connect habilitado e PIX disponível na conta Stripe | [ ] |
| 2 | Confirmação por escrito da Stripe sobre o segmento | [ ] |
| 3 | Validação jurídica concluída | [ ] |
| 4 | Decisão sobre estorno/disputa registrada | [ ] |
| 5 | Chaves antigas rotacionadas; nenhuma chave em repositório ou chat | [ ] |
| 6 | Dono confirmou migrations no banco `RIFAS` (sem backup); dump manual feito, se desejado | [ ] |
| 7 | Migrations 0027–0032 aplicadas, antes do código | [ ] |
| 8 | Roteiro da §4 completo em modo teste; respostas da §5 anotadas | [ ] |
| 9 | Chave **live** restrita criada; permissões da §3 conferidas | [ ] |
| 10 | Dois endpoints live criados; dois `whsec_` em `STRIPE_CONNECT_WEBHOOK_SECRET` | [ ] |
| 11 | Variáveis em API e worker; `NODE_ENV=production` | [ ] |
| 12 | Pendências da §6 aceitas ou resolvidas (a guarda de `tenant_platform_fee_bps` já foi corrigida) | [ ] |
| 13 | Plano de rollback (§7) lido por quem opera | [ ] |
| 14 | `CONNECT_ENABLED=true` só depois dos itens 1–13 | [ ] |
