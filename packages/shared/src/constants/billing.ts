/**
 * Constantes da cobranca da plataforma. Fase 7.
 *
 * Nenhum PRECO e nenhum LIMITE comercial mora aqui: planos, precos e limites sao
 * dados do catalogo (tabela `plans`), administrados pelo Super Admin. Aqui ficam so
 * regras de mecanismo.
 */

/**
 * Tolerancia inicial, em dias, para assinaturas em `past_due`. Decisao de produto.
 * O valor VIGENTE vive em `billing_settings.past_due_grace_days` (o Super Admin o
 * altera); esta constante e o padrao gravado pela migration 0018.
 */
export const DEFAULT_PAST_DUE_GRACE_DAYS = 3 as const;

/** Faixa aceita para a tolerancia (CHECK do banco). */
export const PAST_DUE_GRACE_DAYS_RANGE = Object.freeze({ min: 0, max: 90 } as const);

/**
 * Retencao dos eventos do webhook Stripe (migration 0018, `purge_stripe_events`).
 *
 *  - o PAYLOAD (um resumo minimo, sem dado pessoal) de evento terminal e zerado apos
 *    `STRIPE_EVENT_PAYLOAD_RETENTION_DAYS`;
 *  - a LINHA (ids de idempotencia) fica `STRIPE_EVENT_ROW_RETENTION_DAYS`, alem da janela
 *    de reenvio da Stripe (~3 dias), e entao sai. Evento ainda nao concluido nunca e
 *    apagado.
 */
export const STRIPE_EVENT_PAYLOAD_RETENTION_DAYS = 30 as const;
export const STRIPE_EVENT_ROW_RETENTION_DAYS = 90 as const;

/** Posse (lease) de um evento em processamento, em segundos. Vencido, outro processo assume. */
export const STRIPE_EVENT_LEASE_SECONDS = 120 as const;

/** Tentativas antes de um evento falho virar DEAD. Igual ao limite do banco. */
export const STRIPE_EVENT_MAX_ATTEMPTS = 10 as const;

/** Validade de um Checkout aberto, em minutos (a Stripe aceita de 30 min a 24 h). */
export const CHECKOUT_SESSION_TTL_MINUTES = 30 as const;

/** A autorizacao e renovada quando falta menos que isto para vencer (o token do Mercado Pago dura ~180 dias). */
export const PAYMENT_TOKEN_REFRESH_MARGIN_DAYS = 14 as const;

/**
 * Janela em que um pagamento encerrado ainda pode ser descoberto como pago (conciliacao).
 * Enquanto houver um, a credencial da conta nao pode ser apagada numa desconexao.
 */
export const PAYMENT_RECONCILIATION_WINDOW_DAYS = 3 as const;

/** Validade do `state` do OAuth de recebimentos: uso unico e curto. Banco: 60 a 3600 s. */
export const PAYMENT_OAUTH_STATE_TTL_SECONDS = 600 as const;
