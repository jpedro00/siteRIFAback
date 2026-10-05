# Conformidade do produto com o DOC-01 e o D01 (auditoria de 02/10/2026)

Fontes, nesta ordem: `Especificacao_Ciclo_Sorteios.html` (DOC-01) · `D01_mapa_geral_plataforma_campanhas.html` ·
`PROMPT_GERAL_Plataforma_Campanhas_Comunidades.md` · contratos do `shared` (0.14.0) · código. Onde divergem, o
DOC-01 vence (reserva = 30 minutos). Nenhum código foi portado da NewStore/XNAMAI.

Legenda: ✅ completo · 🟡 parcial · ❌ ausente · ⚠️ depende de serviço externo.
Um contrato ou uma tabela **sem jornada utilizável não conta como implementado**.

## M01–M12

| Módulo | Estado | O que existe / o que falta |
|---|---|---|
| M01 Identidade, comunidade, permissões | 🟡 | ✅ login, MFA (TOTP), papéis e matriz de permissões, RLS, equipe e convites, Super Admin, **editor da comunidade (nome, logo, banner, cor, contatos, WhatsApp/Instagram, rodapé) e páginas Sobre / Como funciona / Termos / Privacidade / Contato** refletidos na vitrine. ❌ domínio próprio com validação de DNS, fontes, dados cadastrais/documentos. |
| M02 Campanhas e catálogo | 🟡 | ✅ assistente de **9 passos** com salvamento automático, vários prêmios (ordem, valor estimado, **foto enviada com pré-visualização**), duplicar, edição de rascunho, regulamento próprio, subtítulo/categoria, **banner, cor de destaque, contador, compradores mascarados e mínimo/máximo por pedido**. ❌ galeria com várias fotos por prêmio, recorte/ponto focal, vídeo, `draw_versions`, modelos de página. Imagens ficam no banco (limite de 2 MB) até haver armazenamento de objetos. |
| M03 Reservas e inventário | ✅ | Reserva atômica de 30 min (constante protegida por teste), contador, expiração por job, grade 100/500/1000 com rótulos. |
| M04 Checkout e pedidos | 🟡 | ✅ identificação, aceite do regulamento, consentimento separado, pedido, "Meus bilhetes". ❌ cupons, pacotes, compra mínima/máxima. |
| M05 Pagamentos | 🟡 ⚠️ | ✅ PIX com Mercado Pago por **OAuth por comunidade**, conta de origem imutável, troca/desconexão seguras, **descoberta de meios por capacidades** (hoje só PIX liga). ❌ cartão, saldo, outros (exigem tokenização do PSP no navegador); boleto desligado até existir política de prazo × reserva. ⚠️ Mercado Pago real não homologado; estorno automático inexistente (devolução manual sinalizada). |
| M06 Sorteio e resultados | 🟡 | ✅ fechamento, snapshot com hash, apuração por função pura com cada tentativa, publicação, correção versionada (retificada visível), prova pública, **entrega do prêmio e arquivamento**. ❌ vários contemplados (um por prêmio), busca automática da fonte, relatório D+1. |
| M07 CRM, comunidade, fidelidade | 🟡 | ✅ área **Clientes** (busca por nome/telefone/e-mail, pedidos, números, total pago, sorteios), lista de compradores por sorteio e CSV. ❌ CRM avançado, fidelidade, segmentação. |
| M08 Automações, IA, mensagens | 🟡 ⚠️ | ✅ registro idempotente de "faltam 25/10", esgotou, ativação e resultado publicado (outbox + `notifications_sent`). ❌ lembrete de reserva expirando e de PIX pendente, relatório D+1, assistente de IA. ⚠️ nenhum provedor de WhatsApp/e-mail/SMS conectado. |
| M09 Afiliados, cupons, gamificação | ❌ | Nada além da lista de dependências. |
| M10 Compliance, KYB/KYC, antifraude | 🟡 | ✅ fila de revisão com o sorteio completo (regulamento, prêmios com valor, cronograma, personalização), aprovar/agendar/reprovar com motivo obrigatório. ❌ documentos, KYB/KYC, área de risco (reservas por IP/aparelho não são gravadas). |
| M11 Cobrança SaaS | ✅ ⚠️ | Stripe Billing, planos, entitlements, limites; `enforcement_enabled = false`. ⚠️ sandbox não homologado. |
| M12 Auditoria e observabilidade | ✅ | `audit_events` imutável, outbox, dead-letter, heartbeats, Saúde, conciliação (lista de divergências no Financeiro). |

## Cliente (Storefront)

| Requisito | Doc | Backend | Frontend | Teste | Estado |
|---|---|---|---|---|---|
| Home, catálogo, detalhe | §9 | `/api/public/draws` | Home/Sorteios/Detalhe | ✅ | ✅ |
| Galeria de prêmios, vários prêmios, valor estimado | §5 | `prizes` | `PrizeGallery` + lista "Os prêmios" | ✅ | ✅ (por link https) |
| Regulamento próprio sempre visível (RN29) | §4 p7 | `draws.regulation` | seção "Regulamento" | ✅ | ✅ |
| Subtítulo, categoria, chamada principal, texto do botão | §6 | `draws` + `customization` | `DrawPage` | ✅ | ✅ |
| Barra de progresso: faltam X / % / ocultar | §6 | `customization.progressMode` | `ProgressBar`/`SalesHint`/`DrawStats` | ✅ | ✅ |
| Datas de venda, fechamento e sorteio | §4 p5 | campos do sorteio | seção de datas | ✅ | ✅ |
| Grade 100/500/1000, estados por cor **e** texto | §8 | `draw_numbers` | `NumberGrid` | ✅ | ✅ |
| Busca de número, +1/+5/+10, aleatório | §9 | — | `NumberGrid` | ✅ | ✅ |
| Reserva de 30 min, cronômetro, persistência ao recarregar | RN05 | `reservations` | `sessionStorage` | ✅ | ✅ |
| Disputa pelo mesmo número (atomicidade) | RN04 | índice único | mensagem de perda | ✅ | ✅ |
| Checkout, consentimento separado | §9 | `orders` | `CheckoutPage` | ✅ | ✅ |
| Pagamento PIX e atualização do status | §9 | MP + webhook + RN06 | `PixPayment`/`OrderPage` | ✅ | ✅ ⚠️ |
| Conta e "Meus bilhetes" | §9 | `/api/account/orders` | `AccountPage` | ✅ | ✅ |
| Resultado, prova/hash, retificação, histórico de versões | §13 | `draw_results` | `ResultPage` | ✅ | ✅ |
| Entrega do prêmio ("Prêmio entregue em …") | §15 | `draw_deliveries` | `ResultPage` | ✅ | ✅ |
| Histórico público da comunidade (arquivadas) | §15 | resultado continua público | — | — | 🟡 (sem listagem de arquivadas) |
| Pagar com cartão / saldo / boleto | — | desligados | — | ✅ (política) | ❌ por decisão |

## Organizador

| Requisito | Doc | Backend | Frontend | Teste | Estado |
|---|---|---|---|---|---|
| Dashboard e métricas | §16 | `/api/tenant/dashboard` | `DashboardPage` | ✅ | ✅ |
| Assistente 9 passos + **autosave** (debounce, sair e voltar) | §4 | `PATCH` só em RASCUNHO | `DrawWizardPage` | ✅ | ✅ |
| Passo 1 básicas · slug · duplicar | §4 | gera slug no servidor | passo 1 + `?duplicar=` | ✅ | ✅ (slug não editável) |
| Passo 2 vários prêmios, ordem, valor, imagens | §4/§5 | `prizes` | passo 2 | ✅ | 🟡 (sem upload) |
| Passo 3 grade e prévia | §4 | RN13/RN14 | passo 3 | ✅ | ✅ |
| Passo 4 preço e promoção | §4 | validação no contrato | passo 4 | ✅ | 🟡 (sem mín./máx., pacotes, cupons) |
| Passo 5 cronograma e fonte | §4 | campos + `noWinnerPolicy` | passo 5 | ✅ | ✅ |
| Passo 6 personalização | §6 | `customization` | passo 6 | ✅ | 🟡 (3 campos; sem banner/cor/modelo/contador) |
| Passo 7 regulamento e compliance | §4 | `regulation` | passo 7 + modelo | ✅ | 🟡 (sem documentos/responsável) |
| Passo 8 automações e cativos | §10/§11 | `thresholds` | passo 8 | ✅ | 🟡 (cativos ❌ Vindi) |
| Passo 9 checklist, prévia celular/desktop, enviar | §4 | readiness compartilhada | passo 9 | ✅ | ✅ |
| Equipe e convites | §3 | `/api/tenant/team` | `TeamPage` | ✅ | ✅ |
| Compradores e CSV | §16 | `/orders` + export | `BuyersSection` | ✅ | ✅ |
| Estorno / conciliação | §16 | divergência registrada | só Super Admin lê | ✅ | 🟡 (sem ação de estorno) |
| Apuração, publicação, retificação | §13 | `/result` | `ResultSection` | ✅ | ✅ |
| **Entrega e arquivamento** | §15 | `/delivery`, `draws_07_archive_needs_delivery` | `DeliveryPanel` | ✅ | ✅ (sem foto) |
| Assinatura, limites | §2 | Stripe | Minha assinatura | ✅ | ✅ ⚠️ |
| Recebimentos (OAuth) + **meios de pagamento** | §2 | `/payment-accounts`, `/payment-methods` | Recebimentos | ✅ | ✅ ⚠️ |
| Auditoria | §3 | `/audit-events` | `AuditPage` | ✅ | ✅ |
| Marca, contato, rodapé, páginas | §2 | `/tenant/community` | `CommunityPage` | ✅ | ✅ |
| Domínio próprio, documentos | §2 | — | — | — | ❌ |

## Super Admin

| Requisito | Doc | Backend | Frontend | Teste | Estado |
|---|---|---|---|---|---|
| Comunidades | §17 | `/platform/tenants` | `TenantsPage` | ✅ | ✅ |
| Compliance: fila + detalhe completo + decisão com motivo | §17 | `/platform/draws/review` | `ReviewQueuePage` | ✅ | ✅ (sem histórico de decisões) |
| Risco | §17 | — | — | — | ❌ (sem dados: IP/aparelho não são gravados) |
| Financeiro: divergências da conciliação | §17 | `/platform/reconciliation` + `/review` | `FinancePage` | ✅ | 🟡 (status e observação de revisão; sem estornar) |
| Planos e assinaturas | §2 | Stripe | Planos/Assinaturas | ✅ | ✅ ⚠️ |
| Saúde: jobs, heartbeat, outbox, dead-letter, Stripe, MP | §17 | `/platform/health` | `HealthPage` | ✅ | ✅ |
| 2ª aprovação de estornos acima de um valor | §17 | — | — | — | ❌ |

## Automação

| Evento | Estado |
|---|---|
| Reserva expirando | ❌ (expiração em si ✅) |
| PIX pendente há 15 min | ❌ (expiração do PIX ✅) |
| Pagamento aprovado | ✅ evento `order.paid`; ❌ mensagem |
| Faltam 25 / 10 · esgotou | ✅ registro idempotente |
| Fechamento · apuração | ✅ jobs |
| D+1 (relatório) | ❌ |
| Conciliação | ✅ |
Todas as existentes são idempotentes (`event_consumptions`, `notifications_sent`). Nenhuma mensagem real é enviada.

## Próxima fase (módulos grandes)

CRM/fidelidade (M07) · afiliados, cupons e gamificação (M09) · IA e mensageria real (M08) · KYB/KYC e antifraude
(M10) · armazenamento de mídia e galeria de imagens · clientes cativos e pré-autorização (Vindi) · cartão/saldo e
política de boleto (M05) · múltiplos contemplados por prêmio e relatório D+1 (M06) · editor de marca e domínio
próprio (M01).

## Hardening já registrado (sem alteração nesta rodada)

Source maps publicados · `redirectTo` aceita HTTP · ausência de `FORCE ROW LEVEL SECURITY` · funções internas sem
checagem do chamador · permissões padrão das extensões do PostgreSQL.
