import { StaticPspResolver } from '@clubedarifa/psp/testing';
import type { PspGateway } from '@clubedarifa/psp';
import type { PaymentAccountsRuntime } from '../runtime.js';

/**
 * Runtime de TESTE para quem so precisa do PSP falso (os testes de PIX que ja existiam): o
 * resolvedor devolve sempre o mesmo gateway, sem conta. O modulo OAuth fica DESLIGADO.
 * Existe so em `@clubedarifa/payment-accounts/testing`; nenhuma configuracao o liga.
 */
export function staticPaymentAccountsRuntime(psp: PspGateway): PaymentAccountsRuntime {
  return {
    enabled: false,
    environment: 'SANDBOX',
    resolver: new StaticPspResolver(psp),
    beginConnection: () => Promise.reject(new Error('OAuth desligado neste runtime de teste.')),
    completeConnection: () => Promise.reject(new Error('OAuth desligado neste runtime de teste.')),
    refreshDue: () => Promise.resolve({ refreshed: 0, revoked: 0, failed: 0 }),
    finalizeDisconnections: () => Promise.resolve(0),
  };
}
