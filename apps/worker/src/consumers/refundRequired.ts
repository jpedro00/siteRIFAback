import type { DbPool } from '@clubedarifa/db';
import type { Logger } from '@clubedarifa/logging';
import type { ConnectRuntime } from '@clubedarifa/payment-accounts';
import {
  PaymentAccountUnavailableError,
  PaymentsNotConfiguredError,
  PspRejectedError,
  PspUnauthorizedError,
  PspUnavailableError,
  type PspPayment,
} from '@clubedarifa/psp';
import { paymentRefundRequiredPayloadSchema } from '@clubedarifa/shared';
import { aplicarPagamentoDoPsp } from '../jobs/definitions.js';

/**
 * `payment.refund_required` · estorno AUTOMATICO, so para pagamento STRIPE (Connect).
 *
 * Quem marca `needs_manual_refund` e grava o evento e `app.apply_psp_payment` (via
 * `settle_order_paid`), na primeira vez que um pagamento aprovado nao pode ser honrado. Para
 * Mercado Pago o estorno continua MANUAL (o operador resolve fora; este consumidor nao faz nada).
 *
 * Para STRIPE:
 *   1. le o pagamento NO BANCO (provedor, conta, estado) — o payload so diz qual e;
 *   2. resolve o gateway pela conta ORIGINAL do pagamento (`forPayment`), nunca a atual;
 *   3. `gateway.refund(pi, '<payment.id>:refund')`: chave ESTAVEL entre tentativas, e o gateway
 *      devolve tambem a taxa da plataforma (`refund_application_fee`) e reverte a transferencia;
 *   4. CONSULTA a Stripe e aplica pelo `app.apply_psp_payment` (RN06: quem diz ESTORNADO e a
 *      Stripe). Consulta que ainda nao mostra o estorno = transitorio (retry). O webhook
 *      `charge.refunded` chega pelo mesmo caminho e e no-op (ou conclui antes do retry).
 *
 * Falhas: Stripe fora, 401 ou conta indisponivel (revogada...) LANCAM — a fila tenta de novo
 * (retryLimit da fila) e o `needs_manual_refund` continua ligado, entao o painel do operador
 * mostra o caso ate o estorno acontecer. Recusa definitiva da Stripe (4xx): nao lanca (repetir
 * nao muda a resposta), registra o motivo e deixa para o operador.
 *
 * Idempotente sem tabela propria: pagamento ja ESTORNADO (ou sem o sinal) nao sai para a Stripe,
 * e um estorno repetido com a mesma chave e o mesmo estorno na Stripe.
 */

export interface RefundResult {
  readonly applied: boolean;
  readonly reason?: string;
}

interface PaymentRow {
  id: string;
  tenant_id: string;
  provider: string;
  provider_payment_id: string | null;
  payment_account_id: string | null;
  status: string;
  needs_manual_refund: boolean;
}

/** Transitorio: a fila deve tentar de novo. */
const transitorio = (e: unknown): boolean =>
  e instanceof PspUnavailableError ||
  e instanceof PspUnauthorizedError ||
  e instanceof PaymentAccountUnavailableError ||
  e instanceof PaymentsNotConfiguredError;

const mensagem = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export async function consumeRefundRequired(
  pool: DbPool,
  connect: ConnectRuntime | null,
  log: Logger,
  input: { eventId: string; payload: unknown },
): Promise<RefundResult> {
  // safeParse: um payload legado/malformado (de qualquer provedor) nunca lanca — lancar faria a
  // fila reentregar ate a dead-letter algo que nao tem o que executar. O sinal
  // `needs_manual_refund` continua no banco, e o painel do operador mostra o caso.
  const parsed = paymentRefundRequiredPayloadSchema.safeParse(input.payload);
  if (!parsed.success) {
    log.error('payment.refund_required com payload invalido; estorno fica para o operador', {
      issues: parsed.error.issues.map((i) => i.path.join('.')).join(','),
    });
    return { applied: false, reason: 'payload invalido' };
  }
  const p = parsed.data;

  // O pagamento E da comunidade do evento: payload de outra comunidade nao acha nada.
  const { rows } = await pool.query<PaymentRow>(
    `SELECT id, tenant_id, provider::text AS provider, provider_payment_id, payment_account_id,
            status::text AS status, needs_manual_refund
       FROM payments WHERE id = $1 AND tenant_id = $2`,
    [p.paymentId, p.tenantId],
  );
  const pay = rows[0];
  if (!pay) return { applied: false, reason: 'pagamento inexistente' };

  // Mercado Pago (e qualquer outro): estorno manual, como sempre. Nada sai para a Stripe.
  if (pay.provider !== 'STRIPE') return { applied: false, reason: 'estorno manual (provedor nao e STRIPE)' };
  if (pay.status === 'ESTORNADO') return { applied: false, reason: 'ja estornado' };
  if (!pay.needs_manual_refund) return { applied: false, reason: 'sem estorno pendente' };
  if (pay.status !== 'APROVADO' || !pay.provider_payment_id) {
    return { applied: false, reason: `pagamento ${pay.status} nao e estornavel` };
  }

  const campos = { payment_id: pay.id, tenant_id: pay.tenant_id };
  if (!connect) {
    // Implantacao sem Connect no worker: o caso fica no painel do operador.
    log.error('estorno Stripe pendente: Connect desligado neste worker; fica para o operador', campos);
    return { applied: false, reason: 'connect desligado' };
  }

  const providerPaymentId = pay.provider_payment_id;
  try {
    const { gateway, paymentAccountId } = await connect.resolver.forPayment({
      tenantId: pay.tenant_id,
      paymentAccountId: pay.payment_account_id,
    });
    if (gateway.provider !== 'STRIPE' || !gateway.refund) {
      log.error('estorno Stripe pendente: o gateway da conta nao e Stripe; fica para o operador', campos);
      return { applied: false, reason: 'gateway nao e Stripe' };
    }

    let recusa: string | null = null;
    try {
      await gateway.refund(providerPaymentId, `${pay.id}:refund`);
    } catch (error) {
      if (!(error instanceof PspRejectedError)) throw error;
      // Definitivo (ja estornado no painel da Stripe, cobranca antiga demais...). A consulta
      // abaixo diz se, apesar da recusa, a cobranca ja esta estornada.
      recusa = mensagem(error);
    }

    // RN06: confirmar pela CONSULTA, nao pela resposta do estorno.
    let remoto: PspPayment;
    try {
      remoto = await gateway.getPayment(providerPaymentId);
    } catch (error) {
      if (recusa !== null && error instanceof PspRejectedError) {
        log.error('estorno Stripe recusado; fica para o operador', { ...campos, error: recusa });
        return { applied: false, reason: 'estorno recusado pela Stripe' };
      }
      throw error;
    }
    const outcome = await aplicarPagamentoDoPsp(pool, 'STRIPE', remoto, paymentAccountId);

    if (remoto.status !== 'ESTORNADO') {
      if (recusa !== null) {
        log.error('estorno Stripe recusado; fica para o operador', { ...campos, error: recusa, outcome });
        return { applied: false, reason: 'estorno recusado pela Stripe' };
      }
      // Estorno aceito mas a consulta ainda nao o reflete. Nao depende do webhook: falha
      // transitoria, a fila tenta de novo — o `refund` com a mesma chave e o MESMO estorno na
      // Stripe, e a proxima consulta confirma.
      throw new PspUnavailableError('Estorno pedido, mas a Stripe ainda nao o reflete na consulta.');
    }
    log.info('estorno Stripe confirmado', { ...campos, outcome });
    return { applied: true };
  } catch (error) {
    if (transitorio(error)) {
      // A fila tenta de novo; o sinal continua ligado (painel do operador).
      log.warn('estorno Stripe falhou (transitorio); a fila tenta de novo', { ...campos, error: mensagem(error) });
    }
    throw error;
  }
}
