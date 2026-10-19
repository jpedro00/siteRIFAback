/** Taxa da plataforma em centavos: floor(valor × bps / 10000), nunca acima do valor. */
export function computePlatformFeeCents(amountCents: number, feeBps: number): number {
  if (!Number.isInteger(amountCents) || amountCents < 0) throw new RangeError('amountCents inválido');
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw new RangeError('feeBps inválido');
  return Math.min(amountCents, Math.floor((amountCents * feeBps) / 10_000));
}
