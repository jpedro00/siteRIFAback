import { z } from 'zod';
import { labelDigitsForGridSize, type GridSize } from '../constants/grid.js';
import { DRAW_RESULT_SOURCES } from '../states/drawStatus.js';

/**
 * Apuracao e resultado. M06 · RN09 · RN20.
 *
 * O ganhador SAI DE UMA FUNCAO PURA. Ela recebe o numero da Loteria Federal, a
 * grade e o conjunto de numeros vendidos (o snapshot congelado, nunca a grade
 * viva) e devolve o vencedor E cada tentativa que fez para chegar a ele. Quem
 * audita — o organizador, o participante, a plataforma — refaz a conta a partir
 * do mesmo snapshot e chega ao mesmo numero.
 */

/**
 * O que fazer quando o numero apurado nao foi vendido. Suposicao S5, configuravel
 * por sorteio (`draws.no_winner_policy`).
 *  - PROXIMO_VENDIDO_ACIMA: usa o proximo numero vendido acima, com volta ao
 *    inicio da grade. E o padrao.
 *  - SEM_CONTEMPLADO: nao ha ganhador; a decisao passa a ser humana.
 */
export const NO_WINNER_POLICIES = ['PROXIMO_VENDIDO_ACIMA', 'SEM_CONTEMPLADO'] as const;
export type NoWinnerPolicy = (typeof NO_WINNER_POLICIES)[number];
export const DEFAULT_NO_WINNER_POLICY: NoWinnerPolicy = 'PROXIMO_VENDIDO_ACIMA';

export interface ResultAttempt {
  readonly number: number;
  /** O numero existe na grade? Um candidato como 731 numa grade de 500 nao existe. */
  readonly inGrid: boolean;
  readonly sold: boolean;
}

export interface ComputedResult {
  /** Os ultimos `labelDigits` digitos do numero da Federal. */
  readonly candidateNumber: number;
  readonly winningNumber: number | null;
  readonly attempts: readonly ResultAttempt[];
}

export function computeDrawResult(input: {
  federalNumber: string;
  totalNumbers: GridSize;
  soldNumbers: ReadonlySet<number> | readonly number[];
  policy?: NoWinnerPolicy;
}): ComputedResult {
  const labelDigits = labelDigitsForGridSize(input.totalNumbers);
  const federal = input.federalNumber.trim();
  if (!/^\d+$/.test(federal) || federal.length < labelDigits) {
    throw new RangeError(
      `O número da Loteria Federal precisa ter ao menos ${labelDigits} dígitos, só dígitos.`,
    );
  }

  const vendidos =
    input.soldNumbers instanceof Set ? input.soldNumbers : new Set<number>(input.soldNumbers);
  const total = input.totalNumbers;
  const candidate = Number.parseInt(federal.slice(-labelDigits), 10);
  const attempts: ResultAttempt[] = [];

  // Tentativa 1: o candidato em si.
  const noGrid = candidate < total;
  const candidatoVendido = noGrid && vendidos.has(candidate);
  attempts.push({ number: candidate, inGrid: noGrid, sold: candidatoVendido });
  if (candidatoVendido) return { candidateNumber: candidate, winningNumber: candidate, attempts };

  if ((input.policy ?? DEFAULT_NO_WINNER_POLICY) === 'SEM_CONTEMPLADO') {
    return { candidateNumber: candidate, winningNumber: null, attempts };
  }

  // Proximo vendido ACIMA, com volta ao inicio. Candidato fora da grade nao tem
  // "acima" dentro dela: a busca comeca no 0. Dentro da grade, o proprio candidato
  // ja foi conferido, entao sao `total - 1` passos.
  const passos = noGrid ? total - 1 : total;
  const inicio = noGrid ? candidate : -1;
  for (let k = 1; k <= passos; k += 1) {
    const n = (inicio + k) % total;
    const vendido = vendidos.has(n);
    attempts.push({ number: n, inGrid: true, sold: vendido });
    if (vendido) return { candidateNumber: candidate, winningNumber: n, attempts };
  }
  return { candidateNumber: candidate, winningNumber: null, attempts };
}

// ---------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------

const httpsUrlSchema = z
  .string()
  .url()
  .max(2000)
  .refine((v) => v.toLowerCase().startsWith('https://'), {
    message: 'O link da evidência precisa começar com https://',
  });

/**
 * Publicar o resultado: o numero da Loteria Federal e a EVIDENCIA (texto e/ou
 * link). Sem evidencia o resultado nao existe: e ela que o participante confere.
 */
const publishFields = {
  federalNumber: z
    .string()
    .trim()
    .regex(/^\d{2,10}$/, 'Informe só os dígitos do número sorteado na Loteria Federal.'),
  federalContest: z.string().trim().max(40).optional(),
  evidenceText: z.string().trim().min(3).max(2000).optional(),
  evidenceUrl: httpsUrlSchema.optional(),
} as const;

const exigeEvidencia = {
  message: 'Anexe a evidência: um texto e/ou um link https.',
  path: ['evidenceText'],
};

export const publishResultRequestSchema = z
  .object(publishFields)
  .refine((v) => v.evidenceText !== undefined || v.evidenceUrl !== undefined, exigeEvidencia);
export type PublishResultRequest = z.infer<typeof publishResultRequestSchema>;

/** Correcao de resultado: cria uma versao nova; o motivo e obrigatorio (RN09). */
export const correctResultRequestSchema = z
  .object({ ...publishFields, reason: z.string().trim().min(3).max(500) })
  .refine((v) => v.evidenceText !== undefined || v.evidenceUrl !== undefined, exigeEvidencia);
export type CorrectResultRequest = z.infer<typeof correctResultRequestSchema>;

export const resultAttemptSchema = z.object({
  number: z.number().int().nonnegative(),
  inGrid: z.boolean(),
  sold: z.boolean(),
});

export const drawResultVersionSchema = z.object({
  version: z.number().int().positive(),
  status: z.enum(['VIGENTE', 'RETIFICADA']),
  source: z.enum(DRAW_RESULT_SOURCES),
  federalNumber: z.string(),
  federalContest: z.string().nullable(),
  candidateNumber: z.number().int().nonnegative(),
  /** Nulo = ninguem contemplado. */
  winningNumber: z.number().int().nonnegative().nullable(),
  winningLabel: z.string().nullable(),
  /** Nome MASCARADO ("M*** S***"). Nunca o nome inteiro na pagina publica. */
  winnerMasked: z.string().nullable(),
  attempts: z.array(resultAttemptSchema),
  evidenceText: z.string().nullable(),
  evidenceUrl: z.string().nullable(),
  snapshotSha256: z.string(),
  proofSha256: z.string(),
  correctionReason: z.string().nullable(),
  publishedAt: z.string(),
});
export type DrawResultVersion = z.infer<typeof drawResultVersionSchema>;

/**
 * Pagina publica do resultado. A versao retificada NAO some (RN09): fica visivel,
 * marcada, para quem viu a anterior entender o que mudou.
 */
export const publicDrawResultSchema = z.object({
  drawTitle: z.string(),
  drawSlug: z.string(),
  labelDigits: z.union([z.literal(2), z.literal(3)]),
  drawDate: z.string().nullable(),
  current: drawResultVersionSchema,
  previous: z.array(drawResultVersionSchema),
});
export type PublicDrawResult = z.infer<typeof publicDrawResultSchema>;

/** Visao do organizador: o mesmo, mais o pedido contemplado. */
export const organizerDrawResultSchema = publicDrawResultSchema.extend({
  winnerOrderId: z.string().uuid().nullable(),
});
export type OrganizerDrawResult = z.infer<typeof organizerDrawResultSchema>;

/** Retrato congelado das vendas (RN20), como o organizador o ve. */
export const drawSnapshotInfoSchema = z.object({
  sha256: z.string(),
  paidCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type DrawSnapshotInfo = z.infer<typeof drawSnapshotInfoSchema>;
