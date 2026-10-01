import type { DbPool } from '@clubedarifa/db';
import type { AppConfig } from './config.js';
import type { LoginThrottle } from './lib/loginThrottle.js';
import type { SecretBox } from './lib/secretBox.js';
import type { PaymentAccountsRuntime } from '@clubedarifa/payment-accounts';
import type { BillingGateway } from '@clubedarifa/billing';

/** Dependencias injetadas nas rotas. Facilita trocar o pool nos testes. */
export interface AppDeps {
  readonly config: AppConfig;
  readonly pool: DbPool;
  readonly secretBox: SecretBox;
  /**
   * Limite de tentativas por origem, anterior a autenticacao.
   *
   * Injetado, e nao criado dentro do servico, porque guarda ESTADO: cada
   * bancada de teste precisa do proprio balde, senao um teste herdaria o
   * orcamento ja gasto por outro.
   */
  readonly loginThrottle: LoginThrottle;
  /**
   * Recebimentos por comunidade (FLUXO B): resolvedor do PSP, conexao OAuth e renovacao de
   * tokens. `null` = nenhum provedor ligado (padrao): gerar PIX responde "indisponivel" em vez
   * de fingir que cobrou. NAO existe credencial global: cada comunidade usa a propria conta.
   */
  readonly paymentAccounts: PaymentAccountsRuntime | null;
  /**
   * Cobranca da PLATAFORMA (Stripe). `null` = desligada (padrao). Separada de `paymentAccounts`:
   * o dinheiro do participante e o da assinatura nao passam pelo mesmo caminho.
   */
  readonly billing: BillingDeps | null;
}

export interface BillingDeps {
  readonly gateway: BillingGateway;
  /**
   * Pede o processamento de um evento JA GRAVADO, depois de o webhook responder. E
   * "melhor esforco": se falhar ou o processo cair, o job do worker recolhe o evento
   * (recuo, lease vencido). Injetado para o teste decidir quando (e se) roda.
   */
  readonly schedule: (eventId: string) => void;
}
