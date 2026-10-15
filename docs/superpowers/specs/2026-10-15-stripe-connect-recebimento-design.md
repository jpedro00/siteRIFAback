# Recebimento dos criadores via Stripe Connect — design

Data: 2026-10-15 · Estado: aguardando revisão do usuário · Caminho: arquitetural

## 1. Objetivo
Cada criador (comunidade/tenant) cadastra, dentro do Rifas, onde recebe o dinheiro das rifas dele. A plataforma cobra uma taxa por venda, definida pelo plano do criador. A custódia e o repasse ficam com a Stripe (Connect); a plataforma não guarda dinheiro de terceiros.

Fora de escopo: chave PIX manual (descartada em favor do Connect); mudanças no Mercado Pago por OAuth (continua como a outra forma de recebimento); cobrança dos planos (fluxo Stripe separado, já existente, não muda).

## 2. Decisões do usuário
- Abordagem: **Stripe Connect Express**, cadastro e verificação hospedados pela Stripe.
- Taxa **por plano**; padrão **5%** (500 bps).
- No estorno, a **taxa da plataforma é devolvida**.
- Credenciais da Stripe entram só por variável de ambiente (Render/Vercel), nunca no repositório.

## 3. Arquitetura
A Stripe vira um segundo provedor de recebimento das comunidades, ao lado do Mercado Pago, atrás da interface `PspGateway` (`packages/psp`). O restante da API não conhece a Stripe.

- **Gateway:** `StripeConnectGateway` implementa `PspGateway` (`provider` passa a aceitar `'STRIPE'`). `createPixCharge` cria um PaymentIntent PIX com `transfer_data.destination = <acct do criador>` e `application_fee_amount = platform_fee_cents`, `idempotencyKey = order_id`.
- **Confirmação (RN06):** o webhook é apenas um aviso; o pagamento só vale após `getPayment` consultar a API da Stripe.
- **Conta do criador:** vínculo em `tenant_payment_accounts` (provider `STRIPE`), guardando `stripe_account_id`, `charges_enabled`, `payouts_enabled`, `requirements_due`. Nenhum segredo por criador.
- **Cadastro:** `POST` cria a conta Express e um Account Link; o criador vai ao formulário da Stripe e volta a `/painel/recebimentos`. O webhook `account.updated` mantém o estado.
- **Ativação de rifa:** exige uma conta de recebimento ativa (Mercado Pago ou Stripe com `charges_enabled`).
- **Flag:** `CONNECT_ENABLED=false` por padrão. Testes primeiro no modo teste da Stripe.

### Exceção à regra "não existe token global"
O Connect exige a chave da plataforma para criar cobranças nas contas conectadas. É uma exceção consciente: a chave vive só no ambiente (`STRIPE_SECRET_KEY`) e é a mesma já usada pelo módulo de cobrança.

### Responsabilidade
Com destination charges, a plataforma responde por estornos e disputas perante a Stripe.

## 4. Taxa
- `plans.platform_fee_bps` (inteiro, 0–10000). `billing_settings.default_platform_fee_bps` = 500 como fallback (criador sem plano ativo).
- Vale a taxa do plano ativo **no momento do pedido**, congelada em `orders.platform_fee_bps` e `orders.platform_fee_cents`.
- `platform_fee_cents = floor(amount_cents × bps / 10000)`, limitado a `amount_cents`.
- Estorno: reembolso com `refund_application_fee = true` (taxa devolvida junto).

## 5. Dados (migration 0027, aditiva)
- `plans.platform_fee_bps`; `billing_settings.default_platform_fee_bps`.
- `orders.platform_fee_bps`, `orders.platform_fee_cents`.
- `tenant_payment_accounts`: provider `STRIPE`; colunas da conta conectada.
- Tabela de eventos do webhook Connect, com idempotência por `event_id`.
- RLS e grants no padrão das migrations 0018/0019. Sem rollback de dados; reverter = `CONNECT_ENABLED=false`.

## 6. Erros
- Conta sem `charges_enabled`: rifa não ativa; a tela lista o que falta.
- Falha da Stripe ao cobrar: pedido segue pendente; nova tentativa idempotente.
- Webhook repetido/fora de ordem: ignorado pela tabela de eventos.
- Log nunca contém chave, corpo da resposta da Stripe ou dados pessoais.

## 7. Configuração e segurança
- Estender o guard de `config.ts` para recusar também `rk_live_` fora de produção (hoje só `sk_live_`).
- A chave restrita precisa de permissões em Accounts, Account Links, PaymentIntents, Refunds e Transfers.
- Segredo do webhook Connect em variável própria (`STRIPE_CONNECT_WEBHOOK_SECRET`).
- Chaves expostas no chat devem ser rotacionadas antes do uso.

## 8. Testes
- Gateway falso da Stripe (padrão do PSP falso do Mercado Pago).
- Cálculo da taxa: arredondamento, 0 bps, 10000 bps, limite no valor.
- Congelamento no pedido; mudar de plano não altera pedidos antigos.
- Estados da conta, ativação bloqueada sem `charges_enabled`.
- Idempotência de cobrança e de webhook; estorno devolve a taxa.
- Frontend: cartão "Conta Rifas (Stripe)" nos estados pendente/verificando/ativo/pendência.
- Teste manual no modo teste da Stripe antes de qualquer produção.

## 9. Pré-requisitos externos (não são código)
1. Connect habilitado na conta Stripe e PIX disponível para esse uso.
2. Confirmar com a Stripe que o segmento rifas/sorteios é aceito.
3. Validação jurídica (já pendente para o lançamento).

## 10. Frontend
`apps/organizer` `/recebimentos`: dois cartões, Mercado Pago (existente) e Conta Rifas (Stripe). `FirstStepsChecklist` passa a considerar qualquer um dos dois. Admin: campo de taxa por plano na tela de planos de cobrança.
