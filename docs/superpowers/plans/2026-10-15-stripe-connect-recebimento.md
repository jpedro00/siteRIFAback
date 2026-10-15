# Recebimento via Stripe Connect — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O criador cadastra, dentro do Rifas, uma conta Stripe Connect Express; o PIX das rifas dele é cobrado na conta da plataforma com repasse automático ao criador, descontada a taxa do plano (padrão 5%), e o estorno devolve a taxa.

**Architecture:** A Stripe vira um segundo provedor de recebimento atrás de `PspGateway` (`packages/psp`). O vínculo da comunidade continua em `tenant_payment_accounts`; a conta Connect é uma linha de `payment_provider_authorizations` sem token (a chave é da plataforma). Um `ConnectRuntime` novo (em `packages/payment-accounts`) faz onboarding e resolve o gateway; a API escolhe o provedor da comunidade na hora de cobrar. Tudo atrás de `CONNECT_ENABLED=false`.

**Tech Stack:** TypeScript, Node, Express, PostgreSQL (migrations SQL + RLS), vitest + supertest, SDK `stripe` (já usado em `packages/billing`), React (apps organizer/admin).

**Spec:** `docs/superpowers/specs/2026-10-15-stripe-connect-recebimento-design.md`

## Global Constraints
- Segredos só por variável de ambiente; **nenhuma chave `pk_`/`rk_`/`sk_`/`whsec_` em código, teste, fixture, log ou documentação** (usar `sk_test_fake` e similares nos testes).
- `CONNECT_ENABLED=false` por padrão; desligado, nada novo responde (404/`PAYMENT_ACCOUNT_UNAVAILABLE`) e o Mercado Pago segue idêntico.
- Chave live só com `NODE_ENV=production`: o guard recusa `sk_live_` **e `rk_live_`**.
- RN06: webhook é aviso; o pagamento só vale depois de `getPayment` consultar a Stripe.
- Idempotência de cobrança = `order_id`; de webhook = `event.id`.
- Taxa: `platform_fee_cents = floor(amount_cents × bps / 10000)`, nunca acima de `amount_cents`; padrão `default_platform_fee_bps = 500`.
- No estorno a taxa é devolvida (`refund_application_fee: true`).
- Migrations são aditivas (padrão 0018/0019/0026), com RLS e grants no mesmo estilo; `ALTER TYPE … ADD VALUE` fica numa migration **separada** da que usa o valor.
- Comentários e mensagens em português, no tom do código vizinho. Logs nunca levam chave, corpo da resposta da Stripe ou dado pessoal.
- Mudou `packages/shared/src/contracts` → `npm run contracts:snapshot` e subir a versão do contrato; sincronizar no `siteRIFAfront` (`packages/shared`) como nos commits anteriores.

## Review Focus
1. **Valor 0 ou taxa que come tudo** (`bps=10000`, pedido de R$ 0,01): taxa nunca excede o valor; teste em Task 2.
2. **Dois provedores conectados na mesma comunidade:** vale a conta conectada **mais recentemente** que pode receber; teste em Task 6.
3. **Conta Connect conectada mas sem `charges_enabled`** (cadastro incompleto): não conta como "pode receber", rifa não ativa, cobrança é recusada com `PAYMENT_ACCOUNT_UNAVAILABLE`; teste em Tasks 4 e 6.
4. **Webhook Connect repetido, fora de ordem ou de evento desconhecido:** responde 200 sem efeito duplicado; teste em Task 7.
5. **Plano muda depois da venda:** a taxa já gravada no pagamento não muda; teste em Task 3.

---

## Mapa de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `packages/db/migrations/0027_payment_provider_stripe.sql` (criar) | só `ALTER TYPE payment_provider ADD VALUE 'STRIPE'` |
| `packages/db/migrations/0028_stripe_connect.sql` (criar) | colunas de taxa e de conta Connect, funções SQL |
| `packages/shared/src/billing/platformFee.ts` (criar) | `computePlatformFeeCents` (puro) |
| `packages/psp/src/stripeConnect.ts` (criar) | `StripeConnectGateway` |
| `packages/psp/src/types.ts` (modificar) | `provider` aceita `'STRIPE'`; `refund` opcional; `platformFeeCents` na cobrança |
| `packages/payment-accounts/src/connect.ts` (criar) | onboarding e sincronização de conta Connect |
| `packages/payment-accounts/src/connectResolver.ts` (criar) | `ConnectPspGatewayResolver` |
| `apps/api/src/modules/paymentAccounts/connectRoutes.ts` (criar) | rotas de onboarding e webhook Connect |
| `apps/api/src/modules/payments/paymentService.ts` (modificar) | escolhe provedor, aplica taxa, grava taxa |
| `apps/api/src/config.ts` (modificar) | variáveis e guards |
| `siteRIFAfront/apps/organizer/src/pages/ReceiptsPage.tsx` e novo `components/ConnectCard.tsx` | UI do criador |
| `siteRIFAfront/apps/admin/src/pages/*Plan*` | campo de taxa no plano |

---

### Task 1: Migrations 0027 e 0028 (banco)

**Files:**
- Create: `packages/db/migrations/0027_payment_provider_stripe.sql`
- Create: `packages/db/migrations/0028_stripe_connect.sql`
- Create: `packages/db/tests/stripe-connect.test.ts`
- Modify: `packages/db/tests/enum-parity.test.ts` (se listar `payment_provider`)

**Interfaces:**
- Produces (SQL): `plans.platform_fee_bps integer`, `billing_settings.default_platform_fee_bps integer`, `payments.platform_fee_bps integer`, `payments.platform_fee_cents integer`, `payment_provider_authorizations.charges_enabled boolean`, `.payouts_enabled boolean`, `.requirements_due text[]`, `app.tenant_platform_fee_bps(p_tenant uuid) RETURNS integer`, `app.tenant_receiving_provider(p_tenant uuid, p_environment payment_environment) RETURNS TABLE(account_id uuid, provider payment_provider)`.

- [ ] **Step 1: Ler o que será estendido**

Run: `sed -n 525,570p packages/db/migrations/0019_payment_accounts.sql; sed -n 715,750p packages/db/migrations/0019_payment_accounts.sql; grep -n "payments_provider_known" packages/db/migrations/*.sql`
Expected: ver `payment_account_overview` (`can_receive`), `tenant_receiving_account`, `tenant_has_payment_account` e a constraint `payments_provider_known`. As reescritas abaixo trocam exatamente essas definições.

- [ ] **Step 2: Escrever o teste que falha**

`packages/db/tests/stripe-connect.test.ts` (seguir o estilo de `payment-accounts.test.ts` para helpers de conexão e `describe.skipIf`):

```ts
it('aceita provedor STRIPE e rejeita taxa fora de 0..10000', async () => {
  await expect(
    admin.query(`UPDATE plans SET platform_fee_bps = 10001 WHERE false`),
  ).resolves.toBeDefined(); // coluna existe
  await expect(
    admin.query(`INSERT INTO plans (code, name, billing_interval, price_cents, platform_fee_bps)
                 VALUES ('fee-ruim', 'x', 'month', 0, 10001)`),
  ).rejects.toThrow(/plans_fee_range/);
});

it('tenant_platform_fee_bps: plano ativo > padrão da plataforma', async () => {
  const { rows } = await admin.query(`SELECT app.tenant_platform_fee_bps($1) AS bps`, [tenantSemPlano]);
  expect(rows[0].bps).toBe(500);
});

it('conta Stripe sem charges_enabled não pode receber', async () => {
  // cria authorization STRIPE ACTIVE sem token, charges_enabled=false, vínculo CONNECTED
  const { rows } = await admin.query(`SELECT can_receive FROM app.payment_account_overview($1)`, [tenant]);
  expect(rows[0].can_receive).toBe(false);
  await admin.query(`UPDATE payment_provider_authorizations SET charges_enabled = true WHERE provider_account_id = 'acct_teste'`);
  const depois = await admin.query(`SELECT can_receive FROM app.payment_account_overview($1)`, [tenant]);
  expect(depois.rows[0].can_receive).toBe(true);
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run packages/db/tests/stripe-connect.test.ts`
Expected: FAIL (coluna `platform_fee_bps` não existe). Se não houver `TEST_DATABASE_URL`, o teste é pulado: subir o Postgres de teste (`npm run db:reset-test`, porta 55432) antes.

- [ ] **Step 4: Escrever 0027**

```sql
-- 0027 · Stripe como provedor de recebimento (Connect). Só o valor do enum: um valor novo
-- não pode ser usado na mesma transação que o cria, então o uso fica na 0028.
ALTER TYPE public.payment_provider ADD VALUE IF NOT EXISTS 'STRIPE';
```

- [ ] **Step 5: Escrever 0028**

```sql
-- 0028 · Stripe Connect: taxa da plataforma e conta conectada do criador. Aditiva.

-- Taxa por plano (pontos-base: 500 = 5%) e padrão da plataforma.
ALTER TABLE public.plans
  ADD COLUMN platform_fee_bps integer,
  ADD CONSTRAINT plans_fee_range CHECK (platform_fee_bps IS NULL OR platform_fee_bps BETWEEN 0 AND 10000);
ALTER TABLE public.billing_settings
  ADD COLUMN default_platform_fee_bps integer NOT NULL DEFAULT 500,
  ADD CONSTRAINT billing_settings_fee_range CHECK (default_platform_fee_bps BETWEEN 0 AND 10000);

-- A taxa fica CONGELADA no pagamento: mudar de plano depois não altera o que já foi vendido.
ALTER TABLE public.payments
  ADD COLUMN platform_fee_bps integer,
  ADD COLUMN platform_fee_cents integer,
  ADD CONSTRAINT payments_fee_valid CHECK (
    (platform_fee_bps IS NULL AND platform_fee_cents IS NULL)
    OR (platform_fee_bps BETWEEN 0 AND 10000 AND platform_fee_cents BETWEEN 0 AND amount_cents)
  );
ALTER TABLE public.payments DROP CONSTRAINT payments_provider_known;
ALTER TABLE public.payments ADD CONSTRAINT payments_provider_known
  CHECK (provider IN ('MERCADO_PAGO', 'STRIPE', 'FAKE'));

-- Conta Connect: sem token (a chave é da plataforma). O estado vem do webhook account.updated.
ALTER TABLE public.payment_provider_authorizations
  ADD COLUMN charges_enabled boolean,
  ADD COLUMN payouts_enabled boolean,
  ADD COLUMN requirements_due text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.payment_provider_authorizations DROP CONSTRAINT ppa_active_has_credentials;
ALTER TABLE public.payment_provider_authorizations ADD CONSTRAINT ppa_active_has_credentials CHECK (
  status <> 'ACTIVE'
  OR provider = 'STRIPE'
  OR (access_token_encrypted IS NOT NULL AND refresh_token_encrypted IS NOT NULL AND credentials_key_version IS NOT NULL)
);
ALTER TABLE public.payment_provider_authorizations ADD CONSTRAINT ppa_stripe_no_tokens CHECK (
  provider <> 'STRIPE' OR (access_token_encrypted IS NULL AND refresh_token_encrypted IS NULL)
);

-- Pode receber = vínculo conectado + autorização ativa + (se Stripe) charges_enabled.
CREATE OR REPLACE FUNCTION app.tenant_has_payment_account(p_tenant uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN RETURN false; END IF;
  RETURN EXISTS (SELECT 1 FROM public.tenant_payment_accounts a
                   JOIN public.payment_provider_authorizations z ON z.id = a.authorization_id
                  WHERE a.tenant_id = p_tenant AND a.status = 'CONNECTED' AND z.status = 'ACTIVE'
                    AND (a.provider <> 'STRIPE' OR z.charges_enabled IS TRUE));
END;
$$;

-- Qual conta cobra uma venda NOVA: a conectada há menos tempo que pode receber.
CREATE FUNCTION app.tenant_receiving_provider(p_tenant uuid, p_environment public.payment_environment)
RETURNS TABLE (account_id uuid, provider public.payment_provider)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app.caller_can_touch_tenant(p_tenant) THEN RETURN; END IF;
  RETURN QUERY
  SELECT a.id, a.provider FROM public.tenant_payment_accounts a
    JOIN public.payment_provider_authorizations z ON z.id = a.authorization_id
   WHERE a.tenant_id = p_tenant AND a.environment = p_environment
     AND a.status = 'CONNECTED' AND z.status = 'ACTIVE'
     AND (a.provider <> 'STRIPE' OR z.charges_enabled IS TRUE)
   ORDER BY a.connected_at DESC LIMIT 1;
END;
$$;
REVOKE EXECUTE ON FUNCTION app.tenant_receiving_provider(uuid, public.payment_environment) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_receiving_provider(uuid, public.payment_environment) TO app_user, app_worker;

-- Taxa vigente: plano da assinatura viva da comunidade, senão o padrão da plataforma.
CREATE FUNCTION app.tenant_platform_fee_bps(p_tenant uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT p.platform_fee_bps FROM public.tenant_subscriptions s
       JOIN public.plans p ON p.id = s.plan_id
      WHERE s.tenant_id = p_tenant AND s.status IN ('trialing', 'active', 'past_due')),
    (SELECT default_platform_fee_bps FROM public.billing_settings));
$$;
REVOKE EXECUTE ON FUNCTION app.tenant_platform_fee_bps(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_platform_fee_bps(uuid) TO app_user, app_worker;
```

Acrescentar, no mesmo arquivo, a redefinição de `app.payment_account_overview` com `can_receive` = `(a.status = 'CONNECTED' AND z.status = 'ACTIVE' AND (a.provider <> 'STRIPE' OR z.charges_enabled IS TRUE))` e as colunas extras `charges_enabled boolean, payouts_enabled boolean, requirements_due text[]` (copiar o corpo lido no Step 1, `DROP FUNCTION` + `CREATE FUNCTION`, pois a assinatura de retorno muda; reaplicar `GRANT`/`REVOKE` iguais ao da 0019).

- [ ] **Step 6: Rodar e ver passar**

Run: `npm run db:reset-test && npx vitest run packages/db`
Expected: PASS, incluindo `migrations-on-empty-database` e `data-api-hardening` (que verifica grants).

- [ ] **Step 7: Commit**

```bash
git add packages/db
git commit -m "feat(db): stripe connect — provedor STRIPE, taxa por plano e funções de recebimento"
```

---

### Task 2: Cálculo da taxa e tipos compartilhados

**Files:**
- Create: `packages/shared/src/billing/platformFee.ts`
- Create: `packages/shared/tests/platform-fee.test.ts`
- Modify: `packages/shared/src/index.ts` (exportar)
- Modify: lista de provedores em `packages/shared` (`grep -rn "MERCADO_PAGO" packages/shared/src`) para incluir `'STRIPE'`; `packages/db/tests/enum-parity.test.ts` deve continuar verde.

**Interfaces:**
- Produces: `computePlatformFeeCents(amountCents: number, feeBps: number): number`

- [ ] **Step 1: Teste que falha**

```ts
import { describe, expect, it } from 'vitest';
import { computePlatformFeeCents } from '../src/billing/platformFee.js';

describe('computePlatformFeeCents', () => {
  it('5% de R$ 100,00 = R$ 5,00', () => expect(computePlatformFeeCents(10_000, 500)).toBe(500));
  it('arredonda para baixo', () => expect(computePlatformFeeCents(999, 500)).toBe(49));
  it('0 bps = sem taxa', () => expect(computePlatformFeeCents(10_000, 0)).toBe(0));
  it('10000 bps nunca passa do valor', () => expect(computePlatformFeeCents(1, 10_000)).toBe(1));
  it('valor 0 = taxa 0', () => expect(computePlatformFeeCents(0, 500)).toBe(0));
  it.each([[-1, 500], [100, -1], [100, 10_001], [1.5, 500], [100, 5.5]])(
    'recusa entrada inválida (%s, %s)', (a, b) => expect(() => computePlatformFeeCents(a, b)).toThrow(RangeError));
});
```

- [ ] **Step 2:** Run `npx vitest run packages/shared/tests/platform-fee.test.ts` → FAIL (módulo não existe).

- [ ] **Step 3: Implementar**

```ts
/** Taxa da plataforma em centavos: floor(valor × bps / 10000), nunca acima do valor. */
export function computePlatformFeeCents(amountCents: number, feeBps: number): number {
  if (!Number.isInteger(amountCents) || amountCents < 0) throw new RangeError('amountCents inválido');
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw new RangeError('feeBps inválido');
  return Math.min(amountCents, Math.floor((amountCents * feeBps) / 10_000));
}
```

- [ ] **Step 4:** Run o teste → PASS. Rodar `npx vitest run packages/db/tests/enum-parity.test.ts` → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(shared): cálculo da taxa da plataforma e provedor STRIPE"`

---

### Task 3: Taxa vigente congelada no pagamento

**Files:**
- Modify: `apps/api/src/modules/payments/paymentService.ts` (`ensurePixPayment`, linhas ~107–250)
- Test: `apps/api/tests/payments.test.ts`

**Interfaces:**
- Consumes: `computePlatformFeeCents` (Task 2), `app.tenant_platform_fee_bps` (Task 1).
- Produces: linhas de `payments` com `platform_fee_bps`/`platform_fee_cents` preenchidas para provedor STRIPE (NULL para Mercado Pago, que não usa taxa de intermediação).

- [ ] **Step 1: Teste que falha** (em `payments.test.ts`, no estilo dos testes de PIX existentes, com `FakePsp`): criar PIX para uma comunidade com plano `platform_fee_bps = 300` e assertar `payments.platform_fee_bps = 300` e `platform_fee_cents = floor(total × 0.03)`; trocar o plano para 800 e assertar que a linha antiga continua 300.
- [ ] **Step 2:** Run `npx vitest run apps/api/tests/payments.test.ts -t "taxa"` → FAIL.
- [ ] **Step 3: Implementar** — dentro do `withTenant` do preparo, ler `SELECT app.tenant_platform_fee_bps($1) AS bps`; depois da resolução do PSP, se `psp.provider === 'STRIPE'`, calcular `platformFeeCents = computePlatformFeeCents(pedido.total_cents, bps)`, passá-lo em `createPixCharge({... platformFeeCents })` (campo novo opcional, Task 4) e gravá-lo no `INSERT INTO payments` (colunas `platform_fee_bps`, `platform_fee_cents`; `NULL` quando o provedor não é STRIPE).
- [ ] **Step 4:** Run o teste → PASS; `npx vitest run apps/api/tests/payments.test.ts` completo → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(api): congela a taxa da plataforma no pagamento"`

---

### Task 4: `StripeConnectGateway`

**Files:**
- Create: `packages/psp/src/stripeConnect.ts`
- Create: `packages/psp/tests/stripe-connect.test.ts`
- Modify: `packages/psp/src/types.ts` (`provider: 'MERCADO_PAGO' | 'STRIPE' | 'FAKE'`; `CreatePixChargeInput.platformFeeCents?: number`; `PspGateway.refund?(providerPaymentId: string, idempotencyKey: string): Promise<void>`)
- Modify: `packages/psp/src/index.ts`, `packages/psp/package.json` (dependência `stripe`, mesma versão de `packages/billing`)

**Interfaces:**
- Produces: `new StripeConnectGateway({ secretKey, connectedAccountId, client? })` implementando `PspGateway` com `provider = 'STRIPE'`; `listPaymentMethods()` devolve só PIX; `verifyWebhook` **não é usado** (a verificação do Connect fica em Task 7) e retorna `{ valid: false, reason: 'use o webhook Connect' }`.

- [ ] **Step 1: Teste que falha** com cliente Stripe falso (objeto com `paymentIntents.create/retrieve`, `refunds.create`), assertando:
  - `createPixCharge` chama `paymentIntents.create` com `amount`, `currency: 'brl'`, `payment_method_types: ['pix']`, `payment_method_data: { type: 'pix' }`, `confirm: true`, `application_fee_amount`, `transfer_data: { destination: 'acct_teste' }`, `metadata: { order_id }`, e `{ idempotencyKey }`; devolve `copyPaste` de `next_action.pix_display_qr_code.data` e `qrCodeBase64` ausente (a Stripe devolve imagem por URL; guardar `null`).
  - `getPayment` mapeia `succeeded→APROVADO`, `requires_action|processing→PENDENTE`, `canceled→CANCELADO` (expirado se `cancellation_reason` indicar), e o valor/`externalReference` vêm de `amount`/`metadata.order_id`.
  - 4xx vira `PspRejectedError`; 5xx/rede vira `PspUnavailableError`; a mensagem nunca contém a chave.
  - `refund` chama `refunds.create({ payment_intent, refund_application_fee: true, reverse_transfer: true }, { idempotencyKey })`.
- [ ] **Step 2:** Run `npx vitest run packages/psp/tests/stripe-connect.test.ts` → FAIL.
- [ ] **Step 3: Implementar** `stripeConnect.ts`, seguindo o formato de `packages/billing/src/stripeGateway.ts` (cliente injetável, `timeout: 10_000`, `maxNetworkRetries: 2`, `classify(error)` truncando mensagem a 300). Esqueleto obrigatório:

```ts
export class StripeConnectGateway implements PspGateway {
  readonly provider = 'STRIPE' as const;
  constructor(private readonly options: { secretKey: string; connectedAccountId: string; client?: Stripe }) {
    // mesma regra do billing: chave live só com allowLive
  }
  async createPixCharge(input: CreatePixChargeInput): Promise<PspPayment> { /* PaymentIntent com destination charge */ }
  async getPayment(id: string): Promise<PspPayment> { /* retrieve + map */ }
  async refund(id: string, idempotencyKey: string): Promise<void> { /* refund com taxa devolvida */ }
}
```
O `expiresAt` do PIX vai em `payment_method_options.pix.expires_after_seconds` (calculado de `input.expiresAt`, mínimo 60).
- [ ] **Step 4:** Run o teste → PASS; `npm run typecheck` → ok.
- [ ] **Step 5: Commit** `git commit -m "feat(psp): gateway Stripe Connect (PIX com taxa e estorno)"`

---

### Task 5: Runtime Connect — onboarding e sincronização da conta

**Files:**
- Create: `packages/payment-accounts/src/connect.ts`
- Create: `packages/payment-accounts/src/connectResolver.ts`
- Modify: `packages/payment-accounts/src/index.ts`
- Test: `packages/payment-accounts/tests/connect.test.ts`

**Interfaces:**
- Consumes: pool, `StripeConnectGateway`, migrations da Task 1.
- Produces:
  - `createConnectRuntime(pool, { secretKey, returnBaseUrl, environment, client?, log? }): ConnectRuntime`
  - `ConnectRuntime.beginOnboarding({ tenantId, userId }): Promise<{ url: string }>` — cria a conta Express uma vez (reaproveita se já houver `payment_provider_authorizations` STRIPE ligada à comunidade), grava autorização `ACTIVE` sem token + vínculo `CONNECTED`, devolve o Account Link.
  - `ConnectRuntime.syncAccount(stripeAccountId: string): Promise<void>` — lê `accounts.retrieve` e grava `charges_enabled`, `payouts_enabled`, `requirements_due`.
  - `ConnectRuntime.resolver: PspGatewayResolver` (provider `'STRIPE'`; `forTenant`/`forPayment` devolvem `StripeConnectGateway` amarrado ao `acct_…` da conta; `forTenant` lança `PaymentsNotConfiguredError` sem conta e `PaymentAccountUnavailableError('NOT_READY')` com `charges_enabled` falso).

- [ ] **Step 1: Teste que falha** com Stripe falso: (a) `beginOnboarding` cria `accounts.create({ type: 'express', country: 'BR', capabilities: { transfers: { requested: true }, card_payments: { requested: true } } })` **uma vez** mesmo chamado duas vezes e devolve a URL de `accountLinks.create({ type: 'account_onboarding', return_url, refresh_url })`; (b) `syncAccount` com `charges_enabled=false` deixa `app.tenant_has_payment_account` falso, e com `true` verdadeiro; (c) `resolver.forTenant` recusa conta sem `charges_enabled`; (d) um `tenantId` não consegue disparar onboarding para outra comunidade (RLS/`caller_can_touch_tenant`).
- [ ] **Step 2:** Run `npx vitest run packages/payment-accounts/tests/connect.test.ts` → FAIL.
- [ ] **Step 3: Implementar.** Gravações no banco por funções `SECURITY DEFINER` novas adicionadas à **0028** (acrescentar ao arquivo da Task 1 antes de aplicar, no mesmo estilo de `app.begin_payment_connection` da 0019): `app.connect_register_account(p_tenant uuid, p_user uuid, p_environment payment_environment, p_account text)` e `app.connect_apply_account_state(p_account text, p_charges boolean, p_payouts boolean, p_requirements text[])`. O `ConnectRuntime` só chama essas funções; nenhuma tabela é escrita direto.
- [ ] **Step 4:** Run o teste → PASS; `npx vitest run packages/db/tests/data-api-hardening.test.ts` → PASS (grants).
- [ ] **Step 5: Commit** `git commit -m "feat(payment-accounts): onboarding e resolvedor Stripe Connect"`

---

### Task 6: Escolha do provedor na cobrança

**Files:**
- Modify: `apps/api/src/deps.ts` (campo `connect: ConnectRuntime | null`)
- Modify: `apps/api/src/modules/payments/paymentService.ts` (`resolverPspDaComunidade`, `exigirPagamentos`, `reconcilePayment` passa `psp.provider`)
- Modify: `apps/api/src/modules/paymentAccounts/paymentAccountService.ts` (`listPaymentAccounts` inclui contas STRIPE e `enabled`)
- Test: `apps/api/tests/payments.test.ts`, `apps/api/tests/payment-accounts.test.ts`

**Interfaces:**
- Consumes: `ConnectRuntime` (Task 5), `app.tenant_receiving_provider` (Task 1).
- Produces: `resolverPspDaComunidade(deps, tenantId)` consulta `app.tenant_receiving_provider`; `'STRIPE'` → `deps.connect.resolver.forTenant`, `'MERCADO_PAGO'` → `deps.paymentAccounts.resolver.forTenant`. Sem nenhum → `PAYMENTS_NOT_CONFIGURED`.

- [ ] **Step 1: Testes que falham:** (a) comunidade só com Stripe pronta cobra via gateway Stripe falso e grava `payments.provider='STRIPE'`; (b) comunidade com as duas, a mais recente vence; (c) Stripe sem `charges_enabled` → `PAYMENT_ACCOUNT_UNAVAILABLE`/`PAYMENTS_NOT_CONFIGURED`; (d) `CONNECT_ENABLED` desligado → comportamento atual do Mercado Pago inalterado (rodar a suíte atual de pagamentos inteira).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implementar** a escolha por `SELECT * FROM app.tenant_receiving_provider($1, $2)` dentro de `withTenant`.
- [ ] **Step 4:** `npx vitest run apps/api/tests/payments.test.ts apps/api/tests/payment-accounts.test.ts` → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(api): cobra pelo provedor de recebimento da comunidade"`

---

### Task 7: Rotas, webhook Connect e configuração

**Files:**
- Create: `apps/api/src/modules/paymentAccounts/connectRoutes.ts`
- Create: `apps/api/src/modules/paymentAccounts/connectSetup.ts`
- Modify: `apps/api/src/config.ts`, `apps/api/src/app.ts` (registrar rotas), `packages/shared/src/contracts/routes.ts`
- Modify: `.env.example`, `render.yaml`, `docs/runbooks/staging.md`
- Test: `apps/api/tests/connect.test.ts`, `apps/api/tests/billing-config.test.ts` (guard)

**Interfaces:**
- Produces rotas (todas com o padrão de `routes.ts`): `POST /api/tenant/payment-accounts/connect-stripe` (MFA, `payment_account:manage`) → `{ url }`; `POST /api/tenant/payment-accounts/refresh-stripe` (`payment_account:manage`) → resincroniza a conta; `POST /api/webhooks/stripe-connect` (sem auth, corpo bruto, assinatura).
- Config: `CONNECT_ENABLED` (boolean, `false`), `STRIPE_CONNECT_WEBHOOK_SECRET`; `CONNECT_ENABLED=true` exige `STRIPE_SECRET_KEY`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `BILLING_RETURN_URL`/`ORGANIZER_PANEL_URL`.

- [ ] **Step 1: Testes que falham:** (a) config: `CONNECT_ENABLED=true` sem os segredos falha ao subir; `rk_live_…` com `NODE_ENV!=production` falha (hoje só `sk_live_` é barrado em `config.ts:267`); (b) webhook com assinatura inválida → 401 sem efeito; (c) `account.updated` válido atualiza `charges_enabled`; (d) `payment_intent.succeeded` válido causa `getPayment` no gateway falso e só então liquida (provar RN06: o falso responde `requires_action` e nada é pago); (e) o **mesmo `event.id` duas vezes** liquida uma vez; (f) evento desconhecido → 200 `ignored`; (g) com `CONNECT_ENABLED=false` as três rotas respondem 404.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implementar.** Verificação: `stripe.webhooks.constructEvent(rawBody, signature, STRIPE_CONNECT_WEBHOOK_SECRET)` (corpo bruto, como em `stripeWebhook`). Idempotência por `event.id` reaproveitando o padrão de `stripe_webhook_events` (tabela própria `stripe_connect_webhook_events` na **0028**, `event_id text PRIMARY KEY`, `INSERT … ON CONFLICT DO NOTHING RETURNING`). Para `payment_intent.*`: localizar por `app.find_payment_route('STRIPE', id)`, consultar `getPayment` e chamar `reconcilePayment` (mesmo caminho do Mercado Pago). Atualizar o guard: `value.STRIPE_SECRET_KEY` começando com `sk_live_` **ou `rk_live_`** fora de produção é erro.
- [ ] **Step 4:** `npx vitest run apps/api/tests/connect.test.ts apps/api/tests/billing-config.test.ts apps/api/tests/route-contract.test.ts` → PASS. `npm run contracts:snapshot` e subir a versão do contrato (`0.18.0`).
- [ ] **Step 5: Documentação:** em `.env.example` e `render.yaml` listar `CONNECT_ENABLED`, `STRIPE_CONNECT_WEBHOOK_SECRET` (sem valor, `sync: false`); em `docs/runbooks/staging.md` descrever criar o endpoint do webhook Connect na Stripe (eventos `account.updated`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded`) e as permissões da chave restrita (Accounts, Account Links, PaymentIntents, Refunds, Transfers).
- [ ] **Step 6: Commit** `git commit -m "feat(api): rotas, webhook e configuração do Stripe Connect"`

---

### Task 8: Estorno devolvendo a taxa

**Files:**
- Modify: `apps/api/src/modules/draws/drawService.ts` e/ou `apps/api/src/modules/payments/paymentService.ts` (onde `needs_manual_refund` hoje vira ação — `grep -n "refund" apps/api/src/modules/*/*.ts apps/worker/src/jobs/definitions.ts`)
- Test: `apps/api/tests/payments.test.ts`

**Interfaces:**
- Consumes: `PspGateway.refund` (Task 4).

- [ ] **Step 1: Ler** os pontos de `refund` listados pelo grep e confirmar quem hoje marca `needs_manual_refund` e quem o resolve.
- [ ] **Step 2: Teste que falha:** pagamento STRIPE aprovado e depois cancelado/duplicado → o caminho de estorno chama `gateway.refund(paymentId, '<payment.id>:refund')` uma vez (idempotente) e o falso recebeu `refund_application_fee: true`; Mercado Pago continua manual como hoje.
- [ ] **Step 3: Implementar** a chamada de `refund` só quando `payment.provider === 'STRIPE'` e `gateway.refund` existir; falha transitória deixa `needs_manual_refund` ligado e tenta de novo.
- [ ] **Step 4:** testes → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(api): estorno Stripe devolve a taxa da plataforma"`

---

### Task 9: Frontend — criador e admin

**Files (repositório `siteRIFAfront`):**
- Create: `apps/organizer/src/components/ConnectCard.tsx`
- Modify: `apps/organizer/src/pages/ReceiptsPage.tsx` (ou a página montada em `/recebimentos`), `apps/organizer/src/components/FirstStepsChecklist.tsx`
- Modify: página de planos do admin (`grep -rn "stripe_price\|price" apps/admin/src/pages`) para o campo "Taxa da plataforma (%)"
- Sync: `packages/shared` a partir do backend (como nos commits anteriores)
- Test: testes vitest dos dois apps

**Interfaces:**
- Consumes: rotas `connectStripeAccount`/`refreshStripeAccount` do contrato (Task 7) e `PaymentAccount` com `provider: 'STRIPE'`, `canReceivePayments`, `requirementsDue`.

- [ ] **Step 1: Teste que falha** (`ConnectCard.test.tsx`): estados — sem conta (botão "Cadastrar recebimento"), conta criada sem `canReceivePayments` e com `requirementsDue` (lista o que falta + "Continuar cadastro"), ativa ("Recebimento ativo"), módulo desligado (`enabled=false`: cartão oculto). O clique chama a rota e faz `window.location.assign(url)`.
- [ ] **Step 2:** `npm test -w apps/organizer` → FAIL.
- [ ] **Step 3: Implementar** `ConnectCard` seguindo o padrão visual dos cartões existentes em `ReceiptsPage`; ao voltar da Stripe (`?connect=return`), chamar `refreshStripeAccount` e recarregar a lista. `FirstStepsChecklist`: o passo "recebimentos" fica completo se qualquer conta tem `canReceivePayments`.
- [ ] **Step 4: Admin:** campo numérico em %, convertido para bps (`Math.round(pct × 100)`), 0–100, com teste de conversão (5 → 500; 0,5 → 50; 100,01 → erro).
- [ ] **Step 5:** `npm run lint && npm run typecheck && npm test && npm run build` nos três apps → verde.
- [ ] **Step 6: Commit** `git commit -m "feat(organizer,admin): cadastro de recebimento via Stripe Connect e taxa por plano"`

---

### Task 10: Verificação, homologação e liberação

**Files:** `docs/runbooks/stripe-connect.md` (criar)

- [ ] **Step 1:** Backend: `npm run lint && npm run typecheck && npm test && npm run contracts:verify` → tudo verde (hoje 1143 testes; a contagem sobe).
- [ ] **Step 2:** Frontend: lint, typecheck, test, build dos 3 apps → verde.
- [ ] **Step 3: Runbook** com o passo a passo de homologação no **modo teste** da Stripe: habilitar Connect, criar conta de teste, concluir onboarding com dados de teste, fazer um PIX de teste, conferir repasse e taxa, estornar e conferir a devolução da taxa.
- [ ] **Step 4: Pré-requisitos externos** (não são código, registrar no runbook): Connect habilitado e PIX disponível na conta Stripe; confirmação com a Stripe de que rifas/sorteios é segmento aceito; validação jurídica; rotacionar as chaves expostas.
- [ ] **Step 5: Liberação:** aplicar 0027 e 0028 no staging (decisão do usuário: banco `RIFAS`, **sem backup**; peça confirmação antes de aplicar), definir `CONNECT_ENABLED=true` só no staging com chaves `_test`; produção só depois do teste manual aprovado.
- [ ] **Step 6: Commit** `git commit -m "docs: runbook de homologação do Stripe Connect"`

---

## Auto-revisão

- **Cobertura da spec:** §3 arquitetura (Tasks 4–6), §4 taxa (Tasks 1–3), §5 dados (Task 1), §6 erros (Tasks 5–7), §7 config/segurança (Task 7), §8 testes (em cada task), §9 pré-requisitos (Task 10), §10 frontend (Task 9). Estorno (§4) na Task 8.
- **Desvios deliberados da spec (registrar ao revisar):** (1) a taxa fica congelada em `payments` (criado segundos depois do pedido) e não em `orders`, para não tocar a criação do pedido; (2) a conta Connect é uma linha de `payment_provider_authorizations` sem token (a restrição `ppa_active_has_credentials` é relaxada só para `STRIPE`) em vez de uma tabela nova; (3) com duas contas conectadas vence a mais recente que pode receber.
- **Incertezas a confirmar na execução:** nome exato do arquivo de planos do admin; onde o estorno é disparado hoje (Task 8 Step 1); versão do SDK `stripe` a alinhar com `packages/billing`; se a Stripe devolve imagem do QR PIX por URL (assumido: guardar `null` em `qrCodeBase64` e usar só o copia-e-cola).
