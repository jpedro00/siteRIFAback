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
