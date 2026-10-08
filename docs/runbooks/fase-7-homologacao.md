# Runbook — homologação da Fase 7 (sandbox e staging)

> **Estado:** PLANO. Nada deste documento foi executado. Sem push, sem deploy, sem migration
> externa, sem Stripe live, sem Mercado Pago live, sem pagamento real.
>
> `billing_settings.enforcement_enabled` **permanece `false`**. Ligá-lo é decisão separada (§5).

Complementa `docs/runbooks/staging.md` (infraestrutura: Supabase, Render, Vercel).

## 0. Pré-condição de dados (achado do teste de upgrade)

Pagamentos criados **antes** da 0019 não têm conta de recebimento (`payment_account_id` nulo) e
não há credencial global. Depois da migration eles continuam atualizáveis (aprovar, expirar,
devolver), mas **o sistema não consegue consultá-los no Mercado Pago**: ficam como pendência
manual (`PAYMENT_AUTHORIZATION_UNAVAILABLE` / conciliação).

Antes de aplicar 0017–0021 em staging:

```sql
SELECT status, count(*) FROM payments WHERE provider <> 'FAKE' AND payment_account_id IS NULL GROUP BY 1;
```

- `PENDENTE` > 0: esperar expirar (job `expirar-pix`) ou resolver manualmente **antes** de migrar.
- Os demais estados são histórico e não exigem ação.

## 1. Stripe — modo de teste (nunca live)

| Item | Valor |
|---|---|
| Variáveis (API **e** worker) | `BILLING_PROVIDER=stripe`, `STRIPE_SECRET_KEY=sk_test_…`, `STRIPE_WEBHOOK_SECRET=whsec_…`, `BILLING_RETURN_URL=https://<painel do organizador>` |
| Também na API | `PUBLIC_API_BASE_URL` |
| Webhook | `{PUBLIC_API_BASE_URL}/api/webhooks/stripe` |
| Eventos | `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed` |
| Guardas do código | `sk_live_` só com `NODE_ENV=production`; `BILLING_RETURN_URL` exige `https://` em staging/produção |

Roteiro (na ordem):

1. Console Super Admin → **Planos** → criar plano de teste (gera Product/Price no modo de teste) e publicá-lo. Preço de teste, **não** o comercial.
2. Organizer → **Minha assinatura** → contratar → Stripe Checkout (cartão de teste `4242 4242 4242 4242`).
3. Voltar ao painel; confirmar que o estado vem do **webhook** (a volta do Checkout não concede nada).
4. Conferir `tenant_subscriptions`, `billing_invoices`, auditoria `billing.subscription_synced`.
5. Customer Portal: abrir, trocar cartão, cancelar ao fim do período (`cancel_at_period_end`).
6. Renovação simulada: Stripe test clock (avançar o relógio do customer) → `invoice.paid` do novo ciclo.
7. Falha de pagamento: cartão `4000 0000 0000 0341` (falha ao cobrar) → `past_due`; conferir `past_due_since` e a tolerância de 3 dias.
8. Cancelamento imediato → `canceled`.
9. Reenvio do mesmo evento (Dashboard → Resend): sem efeito duplicado. Evento fora de ordem: estado não regride.
10. Console → **Saúde**: eventos com falha = 0; mortos = 0.

Limitações do sandbox: test clocks têm limite de avanço por customer; disputas/estornos são simulados por cartões e ações do Dashboard, não por usuário real.

## 2. Mercado Pago — sandbox/teste

| Item | Valor |
|---|---|
| Variáveis (API **e** worker) | `PSP_PROVIDER=mercadopago`, `MERCADOPAGO_OAUTH_CLIENT_ID`, `MERCADOPAGO_OAUTH_CLIENT_SECRET`, `MERCADOPAGO_WEBHOOK_SECRET`, `PAYMENT_CREDENTIALS_KEY` (32 bytes base64, **diferente** de `MFA_ENCRYPTION_KEY`), `PUBLIC_API_BASE_URL` |
| Também na API | `ORGANIZER_PANEL_URL` (https) |
| Aplicação OAuth | criar no painel de desenvolvedores do Mercado Pago |
| Redirect URI | `{PUBLIC_API_BASE_URL}/api/payment-accounts/oauth/callback` (idêntica, caractere a caractere) |
| Webhook | `{PUBLIC_API_BASE_URL}/api/webhooks/mercadopago/{slug-da-comunidade}` |
| Contas | usuário **vendedor de teste** e usuário **comprador de teste** (contas de teste do MP, nunca contas reais) |

Roteiro:

1. Organizer → **Recebimentos** → Conectar → autorizar com o vendedor de teste → painel mostra *Conectada*.
2. Conferir no banco: uma linha em `payment_provider_authorizations` (tokens cifrados) e uma em `tenant_payment_accounts`.
3. Segunda comunidade com o **mesmo** vendedor: reutiliza a autorização (nenhum token copiado).
4. Storefront: comprar número → PIX de teste criado **pela conta conectada** (`payments.payment_account_id` preenchido).
5. Pagar com o comprador de teste → webhook → consulta ao MP com a credencial da conta → pedido `PAGO`.
6. Refresh: forçar `expires_at` próximo e rodar o job `renovar-credenciais-pagamento`; `credential_version` sobe, par access/refresh trocado junto.
7. Devolução: **somente se** o sandbox suportar estorno de PIX de teste; senão registrar a limitação e validar o caminho `needs_manual_refund` por teste automatizado.
8. Desconectar com PIX pendente → `DISCONNECTING`; ao expirar/pagar, job `finalizar-desconexoes-pagamento` conclui → `DISCONNECTED` e segredo apagado se ninguém mais usa a autorização.
9. Caminhos negativos: cancelar na tela do MP (`provider_denied`), reutilizar o `state` (recusado), abrir o callback com outra sessão (`wrong_user`).

Limitações conhecidas do sandbox do Mercado Pago (confirmar na hora): PIX de teste pode não ter paridade total de webhooks/estorno com produção; OAuth de teste depende das contas de teste.

## 3. Staging — ordem de execução (nada executado)

1. Confirmar a infraestrutura atual no Render (1 web + 1 worker, conforme `render.yaml`).
2. Garantir que **não** existem API/worker duplicados (dois workers processando a mesma fila).
3. **Backup** do PostgreSQL de staging (Supabase) e registrar o procedimento de restauração testado.
4. Configurar secrets/vars de **sandbox** (`sync: false` no Render); frontends: `VITE_API_BASE_URL`, `VITE_STOREFRONT_BASE_URL`.
5. Aplicar 0017–0021 pelo processo autorizado (`npm run db:migrate` com a conexão do dono; checksums de 0001–0016 já conferidos no teste de upgrade).
6. Subir a **API**; `GET /api/health`.
7. Subir o **worker**; heartbeat e jobs (`processar-stripe-eventos`, `limpar-stripe-eventos`, `renovar-credenciais-pagamento`, `finalizar-desconexoes-pagamento`, `expirar-pix`, `conciliacao`).
8. Organizer, Admin, Storefront: smoke test **sem enforcement**.
9. Stripe sandbox (§1).
10. Mercado Pago sandbox (§2).
11. Monitorar logs, outbox e jobs por 24 h antes de qualquer decisão sobre enforcement.

Ponto de atenção: o frontend é publicado com `sourcemap: true` (`vite.config.ts`). Decidir se os `.map` vão para o ambiente público.

## 4. Variáveis ainda necessárias (nenhuma existe no repositório)

Stripe: `STRIPE_SECRET_KEY` (teste), `STRIPE_WEBHOOK_SECRET`, `BILLING_RETURN_URL`.
Mercado Pago: `MERCADOPAGO_OAUTH_CLIENT_ID`, `MERCADOPAGO_OAUTH_CLIENT_SECRET`, `MERCADOPAGO_WEBHOOK_SECRET`, `PAYMENT_CREDENTIALS_KEY`, `ORGANIZER_PANEL_URL`.
Comum: `PUBLIC_API_BASE_URL`; frontends `VITE_API_BASE_URL`, `VITE_STOREFRONT_BASE_URL`.

## 5. Enforcement

Permanece `false`. Antes de ligar, validar em sandbox real: assinatura, renovação, atraso, cancelamento, limite de sorteios e limite de equipe. A ativação é uma operação deliberada de Super Admin Financeiro; nenhuma migration, seed, variável de ambiente ou código a liga automaticamente.

`PLAN_FEATURES` segue vazio: os limites de sorteios e de equipe bastam para os primeiros planos.

## 6. Migration 0022 (pronta no repositório, NÃO aplicada em nenhum banco)

`0022_community_content_and_media.sql` — aditiva, não altera 0001–0021:

- `tenant_branding`: `description`, `footer_text`, `banner_url`, `pages` (páginas institucionais).
- `media_files` + `app.public_media(uuid)`: imagens enviadas pelo organizador, guardadas no banco (até 2 MB, JPEG/PNG/WebP, conferidas por assinatura do arquivo). É a solução provisória até haver armazenamento de objetos.
- `payment_reconciliation_issues`: `review_status`, `review_note` e a função `app.platform_review_reconciliation` (só com acesso de plataforma).
- Relaxa as constraints de imagem de prêmio (`https://` **ou** `/api/public/media/<uuid>`).

Ela entra no corte final, junto com 0017–0021, **depois** do backup do banco e com o legado parado para escrita.
Atenção: o `RIFAS` (legado) continua sem as 0017–0022; nada foi aplicado nele.

## 7. Migrations 0023–0026 (prontas no repositório, NÃO aplicadas em nenhum banco de produção)

Todas aditivas; não alteram 0001–0022. Entram no próximo corte, depois de backup e com a mesma disciplina da §6.

| Migration | O que faz |
|---|---|
| `0023_password_reset` | `password_reset_tokens` (só o hash do token; uso único; sem GRANT) + `app.request_password_reset` / `app.reset_password` (revoga todas as sessões). |
| `0024_creator_onboarding` | `app.create_own_community`: o próprio usuário cria a comunidade e vira OWNER numa transação; idempotente (inclusive em corrida). |
| `0025_marketplace` | `app.marketplace_page` / `app.marketplace_creators` (SECURITY DEFINER, projeção mínima) para a lista pública entre comunidades, sem abrir SELECT global nem BYPASSRLS. |
| `0026_payment_method_preferences` | `tenant_payment_preferences`: o criador pausa/retoma meios que a plataforma suporta (hoje só o PIX). |

### Configuração de produção que essas mudanças pedem

- **API:** `PASSWORD_RESET_URL` (https, página `/redefinir-senha` do Storefront), `CREATOR_MAX_COMMUNITIES` (padrão 3) e, para a entrega do token, um provedor de e-mail ligado a `PasswordResetNotifier` (hoje NÃO existe: o pedido é aceito e o token não chega a ninguém).
- **CORS:** adicionar as origens exatas do Organizer e do Admin quando publicados. O Organizer central escolhe a comunidade pelo cabeçalho `x-tenant-slug` SÓ em rota autenticada com vínculo conferido; `TENANT_HEADER_ENABLED` continua `false`.
- **Storefront central:** `VITE_MARKETPLACE_MODE=central`, `VITE_API_BASE_URL`, `VITE_ORGANIZER_BASE_URL` e, se houver links antigos, `VITE_LEGACY_TENANT_SLUG`. Vitrines por domínio de comunidade continuam sem essa variável.
- **Organizer:** `VITE_API_BASE_URL` e `VITE_STOREFRONT_BASE_URL` (o link "Criar comunidade" aponta para `/quero-criar-rifas`).

## 8. Conta que não consegue entrar (sem provedor de e-mail ainda)

Não se redefine senha por SQL. Quem opera o banco emite um **link de redefinição** e a pessoa escolhe a própria senha:

1. Migration `0023` aplicada no banco e a página `/redefinir-senha` do Storefront publicada.
2. Com a credencial administrativa do banco (e TLS validado pela CA):
   `MIGRATION_DATABASE_URL=... DATABASE_SSL=true DATABASE_CA_CERT=... PASSWORD_RESET_URL=https://<storefront>/redefinir-senha npm run db:issue-reset -- pessoa@exemplo.com`
3. O comando imprime o link UMA vez (vale 30 minutos, uso único). Entregue-o só ao dono da conta, por canal confiável.
4. Ao concluir, todas as sessões da conta são revogadas. Fica em `audit_events` (`via: operator_cli`), sem o token.
