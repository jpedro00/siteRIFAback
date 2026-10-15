import type { DbPool } from '@clubedarifa/db';
import type { AppConfig } from './config.js';
import type { LoginThrottle } from './lib/loginThrottle.js';
import type { SecretBox } from './lib/secretBox.js';
import type { ConnectRuntime, PaymentAccountsRuntime } from '@clubedarifa/payment-accounts';
import type { BillingGateway } from '@clubedarifa/billing';
import type { PasswordResetNotifier } from './lib/passwordResetNotifier.js';

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
   * Recebimento via Stripe Connect (conta Express do criador; a chave e da PLATAFORMA). `null` =
   * desligado (padrao): o Mercado Pago segue exatamente como antes. Com os dois ligados, cada
   * cobranca NOVA vai para a conta da comunidade conectada mais recentemente que pode receber.
   */
  readonly connect: ConnectRuntime | null;
  /**
   * Cobranca da PLATAFORMA (Stripe). `null` = desligada (padrao). Separada de `paymentAccounts`:
   * o dinheiro do participante e o da assinatura nao passam pelo mesmo caminho.
   */
  readonly billing: BillingDeps | null;
  /**
   * Entrega do token de recuperacao de senha (e-mail). Opcional: sem ele, o token e gerado
   * mas NAO ha como entrega-lo, e o pedido fica registrado em log SEM o token.
   */
  readonly passwordResetNotifier?: PasswordResetNotifier;
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
