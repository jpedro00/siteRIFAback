import { createHash } from 'node:crypto';
import { withTenant, type PoolClient } from '@clubedarifa/db';
import {
  ALLOWED_GRID_SIZES,
  computeDrawResult,
  formatNumberLabel,
  type CorrectResultRequest,
  type DrawResultVersion,
  type GridSize,
  type NoWinnerPolicy,
  type OrganizerDrawResult,
  type PublicDrawResult,
  type PublishResultRequest,
  type ResultAttempt,
} from '@clubedarifa/shared';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';
import { recordAuditEvent } from '../audit/auditService.js';
import { transitionDrawStatus, type ActionOrigin } from '../draws/drawService.js';
import { enqueueOutboxEvent } from '../outbox/outboxService.js';

/**
 * M06 · apuracao e resultado. RN09 · RN20.
 *
 * O resultado e calculado a partir do SNAPSHOT congelado das vendas — nunca da
 * grade viva. Quem quiser conferir refaz a conta com o mesmo retrato e chega ao
 * mesmo numero. A "prova" e um hash que amarra o snapshot, a fonte, o numero da
 * Federal, cada tentativa e o contemplado.
 *
 * Um resultado nunca e reescrito: corrigir cria uma versao nova e a anterior
 * fica visivel como RETIFICADA.
 */

const SOURCE = 'LOTERIA_FEDERAL' as const;

/** JSON canonico: chaves em ordem, sem espaco. O mesmo conteudo gera o mesmo hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entradas = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entradas.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export interface ProofInput {
  readonly snapshotSha256: string;
  readonly federalNumber: string;
  readonly federalContest: string | null;
  readonly labelDigits: 2 | 3;
  readonly candidateNumber: number;
  readonly attempts: readonly ResultAttempt[];
  readonly winningNumber: number | null;
  readonly winnerOrderId: string | null;
}

/** Hash da prova. Versionado (`v`): mudar a receita exige outro numero. */
export function computeProofHash(input: ProofInput): string {
  return createHash('sha256')
    .update(canonicalJson({ v: 1, source: SOURCE, ...input }), 'utf8')
    .digest('hex');
}

interface SnapshotPaid {
  number: number;
  orderId: string;
  buyer: string;
}

interface DrawForResult {
  id: string;
  tenant_id: string;
  slug: string;
  title: string;
  status: string;
  total_numbers: number;
  label_digits: 2 | 3;
  no_winner_policy: NoWinnerPolicy;
  draw_date: string | null;
}

async function carregarSorteio(client: PoolClient, drawId: string): Promise<DrawForResult> {
  const { rows } = await client.query<DrawForResult>(
    `SELECT id, tenant_id, slug, title, status::text AS status, total_numbers, label_digits,
            no_winner_policy, draw_date
       FROM draws WHERE id = $1 FOR UPDATE`,
    [drawId],
  );
  const draw = rows[0];
  if (!draw) throw ApiError.notFound('Sorteio não encontrado.');
  return draw;
}

async function carregarSnapshot(
  client: PoolClient,
  drawId: string,
): Promise<{ sha256: string; paid: SnapshotPaid[] }> {
  const { rows } = await client.query<{ sha256: string; payload: { paidNumbers: SnapshotPaid[] } }>(
    'SELECT sha256, payload FROM draw_snapshots WHERE draw_id = $1',
    [drawId],
  );
  const snapshot = rows[0];
  if (!snapshot) {
    throw ApiError.conflict(
      'O retrato das vendas ainda não foi gerado: ele só existe quando não há pagamento pendente.',
    );
  }
  return { sha256: snapshot.sha256, paid: snapshot.payload.paidNumbers };
}

/** Calcula o vencedor sobre o snapshot e monta tudo o que vai para a linha do resultado. */
function apurar(
  draw: DrawForResult,
  snapshot: { sha256: string; paid: SnapshotPaid[] },
  dados: { federalNumber: string; federalContest?: string | undefined },
) {
  if (!(ALLOWED_GRID_SIZES as readonly number[]).includes(draw.total_numbers)) {
    throw ApiError.conflict('Grade do sorteio inválida.');
  }

  let calculo;
  try {
    calculo = computeDrawResult({
      federalNumber: dados.federalNumber,
      totalNumbers: draw.total_numbers as GridSize,
      soldNumbers: snapshot.paid.map((p) => p.number),
      policy: draw.no_winner_policy,
    });
  } catch (error) {
    if (error instanceof RangeError) throw ApiError.badRequest(error.message);
    throw error;
  }

  const contemplado =
    calculo.winningNumber === null
      ? null
      : (snapshot.paid.find((p) => p.number === calculo.winningNumber) ?? null);

  const proofSha256 = computeProofHash({
    snapshotSha256: snapshot.sha256,
    federalNumber: dados.federalNumber,
    federalContest: dados.federalContest ?? null,
    labelDigits: draw.label_digits,
    candidateNumber: calculo.candidateNumber,
    attempts: calculo.attempts,
    winningNumber: calculo.winningNumber,
    winnerOrderId: contemplado?.orderId ?? null,
  });

  return { calculo, contemplado, proofSha256 };
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

interface ResultRow {
  id: string;
  version: number;
  status: 'VIGENTE' | 'RETIFICADA';
  source: 'LOTERIA_FEDERAL';
  federal_number: string;
  federal_contest: string | null;
  evidence_text: string | null;
  evidence_url: string | null;
  label_digits: 2 | 3;
  candidate_number: number;
  winning_number: number | null;
  winner_order_id: string | null;
  winner_masked: string | null;
  attempts: ResultAttempt[];
  snapshot_sha256: string;
  proof_sha256: string;
  correction_reason: string | null;
  published_at: string;
}

const RESULT_COLUMNS = `id, version, status, source, federal_number, federal_contest, evidence_text,
  evidence_url, label_digits, candidate_number, winning_number, winner_order_id, winner_masked,
  attempts, snapshot_sha256, proof_sha256, correction_reason, published_at`;

function toVersion(r: ResultRow): DrawResultVersion {
  return {
    version: r.version,
    status: r.status,
    source: r.source,
    federalNumber: r.federal_number,
    federalContest: r.federal_contest,
    candidateNumber: r.candidate_number,
    winningNumber: r.winning_number,
    winningLabel:
      r.winning_number === null ? null : formatNumberLabel(r.winning_number, r.label_digits),
    winnerMasked: r.winner_masked,
    attempts: r.attempts,
    evidenceText: r.evidence_text,
    evidenceUrl: r.evidence_url,
    snapshotSha256: r.snapshot_sha256,
    proofSha256: r.proof_sha256,
    correctionReason: r.correction_reason,
    publishedAt: r.published_at,
  };
}

async function montarResultado(
  client: PoolClient,
  draw: Pick<DrawForResult, 'id' | 'slug' | 'title' | 'label_digits' | 'draw_date'>,
): Promise<OrganizerDrawResult> {
  const { rows } = await client.query<ResultRow>(
    `SELECT ${RESULT_COLUMNS} FROM draw_results WHERE draw_id = $1 ORDER BY version DESC`,
    [draw.id],
  );
  const atual = rows.find((r) => r.status === 'VIGENTE');
  if (!atual) throw ApiError.notFound('Este sorteio ainda não tem resultado.');

  return {
    drawTitle: draw.title,
    drawSlug: draw.slug,
    labelDigits: draw.label_digits,
    drawDate: draw.draw_date,
    current: toVersion(atual),
    // A versao retificada NAO some: fica visivel, marcada (RN09).
    previous: rows.filter((r) => r.status === 'RETIFICADA').map(toVersion),
    winnerOrderId: atual.winner_order_id,
  };
}

/** Pagina publica: sem o pedido contemplado. */
export async function getPublicResult(
  deps: AppDeps,
  tenantId: string,
  slug: string,
): Promise<PublicDrawResult> {
  return withTenant(deps.pool, { tenantId }, async (client) => {
    const { rows } = await client.query<DrawForResult>(
      `SELECT id, tenant_id, slug, title, status::text AS status, total_numbers, label_digits,
              no_winner_policy, draw_date
         FROM draws
        WHERE slug = $1 AND status IN ('RESULTADO PUBLICADO', 'ARQUIVADA')`,
      [slug],
    );
    const draw = rows[0];
    if (!draw) throw ApiError.notFound('Este sorteio ainda não tem resultado publicado.');
    const completo = await montarResultado(client, draw);
    // O pedido contemplado nao vai para a pagina publica.
    return {
      drawTitle: completo.drawTitle,
      drawSlug: completo.drawSlug,
      labelDigits: completo.labelDigits,
      drawDate: completo.drawDate,
      current: completo.current,
      previous: completo.previous,
    };
  });
}

export async function getOrganizerResult(
  deps: AppDeps,
  input: { tenantId: string; userId: string; drawId: string },
): Promise<OrganizerDrawResult> {
  return withTenant(deps.pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
    const { rows } = await client.query<DrawForResult>(
      `SELECT id, tenant_id, slug, title, status::text AS status, total_numbers, label_digits,
              no_winner_policy, draw_date
         FROM draws WHERE id = $1`,
      [input.drawId],
    );
    const draw = rows[0];
    if (!draw) throw ApiError.notFound('Sorteio não encontrado.');
    return montarResultado(client, draw);
  });
}

// ---------------------------------------------------------------------------
// Publicar e corrigir
// ---------------------------------------------------------------------------

export async function publishResult(
  deps: AppDeps,
  input: {
    tenantId: string;
    userId: string;
    drawId: string;
    data: PublishResultRequest;
    origin?: ActionOrigin | undefined;
  },
): Promise<OrganizerDrawResult> {
  return withTenant(deps.pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
    const draw = await carregarSorteio(client, input.drawId);
    if (draw.status !== 'APURAÇÃO') {
      throw ApiError.conflict(
        `O resultado só pode ser publicado com o sorteio em apuração (este está em "${draw.status}").`,
      );
    }

    const { rows: existentes } = await client.query('SELECT 1 FROM draw_results WHERE draw_id = $1 LIMIT 1', [
      draw.id,
    ]);
    if (existentes.length > 0) {
      throw ApiError.conflict('Este sorteio já tem resultado. Para alterá-lo, publique uma correção.');
    }

    const snapshot = await carregarSnapshot(client, draw.id);
    const { calculo, contemplado, proofSha256 } = apurar(draw, snapshot, input.data);

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO draw_results
         (tenant_id, draw_id, version, status, source, federal_number, federal_contest,
          evidence_text, evidence_url, label_digits, candidate_number, winning_number,
          winner_order_id, winner_masked, attempts, snapshot_sha256, proof_sha256, published_by)
       VALUES ($1, $2, 1, 'VIGENTE', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16)
       RETURNING id`,
      [
        input.tenantId,
        draw.id,
        SOURCE,
        input.data.federalNumber,
        input.data.federalContest ?? null,
        input.data.evidenceText ?? null,
        input.data.evidenceUrl ?? null,
        draw.label_digits,
        calculo.candidateNumber,
        calculo.winningNumber,
        contemplado?.orderId ?? null,
        contemplado?.buyer ?? null,
        JSON.stringify(calculo.attempts),
        snapshot.sha256,
        proofSha256,
        input.userId,
      ],
    );
    const resultId = rows[0]!.id;

    await transitionDrawStatus(client, {
      drawId: draw.id,
      to: 'RESULTADO PUBLICADO',
      actor: { userId: input.userId, kind: 'USER' },
      origin: input.origin,
      allowResultPublication: true,
    });

    await recordAuditEvent(client, {
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'draw.result_published',
      targetType: 'draw',
      targetId: draw.id,
      after: { version: 1, winningNumber: calculo.winningNumber, proofSha256 },
      ip: input.origin?.ip ?? null,
      userAgent: input.origin?.userAgent ?? null,
    });
    await enqueueOutboxEvent(client, {
      tenantId: input.tenantId,
      eventType: 'draw.result_published',
      payload: {
        tenantId: input.tenantId,
        drawId: draw.id,
        resultId,
        version: 1,
        winningNumber: calculo.winningNumber,
        proofSha256,
      },
    });

    return montarResultado(client, draw);
  });
}

export async function correctResult(
  deps: AppDeps,
  input: {
    tenantId: string;
    userId: string;
    drawId: string;
    data: CorrectResultRequest;
    origin?: ActionOrigin | undefined;
  },
): Promise<OrganizerDrawResult> {
  return withTenant(deps.pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
    const draw = await carregarSorteio(client, input.drawId);
    if (draw.status !== 'RESULTADO PUBLICADO') {
      throw ApiError.conflict('Só é possível corrigir um resultado já publicado.');
    }

    const { rows: vigentes } = await client.query<{ id: string; version: number; winning_number: number | null }>(
      `SELECT id, version, winning_number FROM draw_results
        WHERE draw_id = $1 AND status = 'VIGENTE' FOR UPDATE`,
      [draw.id],
    );
    const vigente = vigentes[0];
    if (!vigente) throw ApiError.conflict('Este sorteio não tem resultado vigente.');

    const snapshot = await carregarSnapshot(client, draw.id);
    const { calculo, contemplado, proofSha256 } = apurar(draw, snapshot, input.data);
    const novaVersao = vigente.version + 1;

    // A vigente vira RETIFICADA ANTES de a nova entrar: o indice parcial admite
    // uma unica VIGENTE por sorteio. Nada e apagado (RN09).
    await client.query(`UPDATE draw_results SET status = 'RETIFICADA' WHERE id = $1`, [vigente.id]);

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO draw_results
         (tenant_id, draw_id, version, status, source, federal_number, federal_contest,
          evidence_text, evidence_url, label_digits, candidate_number, winning_number,
          winner_order_id, winner_masked, attempts, snapshot_sha256, proof_sha256,
          correction_reason, published_by)
       VALUES ($1, $2, $3, 'VIGENTE', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb,
               $15, $16, $17, $18)
       RETURNING id`,
      [
        input.tenantId,
        draw.id,
        novaVersao,
        SOURCE,
        input.data.federalNumber,
        input.data.federalContest ?? null,
        input.data.evidenceText ?? null,
        input.data.evidenceUrl ?? null,
        draw.label_digits,
        calculo.candidateNumber,
        calculo.winningNumber,
        contemplado?.orderId ?? null,
        contemplado?.buyer ?? null,
        JSON.stringify(calculo.attempts),
        snapshot.sha256,
        proofSha256,
        input.data.reason,
        input.userId,
      ],
    );
    const resultId = rows[0]!.id;

    await recordAuditEvent(client, {
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'draw.result_corrected',
      targetType: 'draw',
      targetId: draw.id,
      before: { version: vigente.version, winningNumber: vigente.winning_number },
      after: {
        version: novaVersao,
        winningNumber: calculo.winningNumber,
        proofSha256,
        reason: input.data.reason,
        winnerChanged: vigente.winning_number !== calculo.winningNumber,
      },
      ip: input.origin?.ip ?? null,
      userAgent: input.origin?.userAgent ?? null,
    });
    await enqueueOutboxEvent(client, {
      tenantId: input.tenantId,
      eventType: 'draw.result_corrected',
      payload: {
        tenantId: input.tenantId,
        drawId: draw.id,
        resultId,
        version: novaVersao,
        winningNumber: calculo.winningNumber,
        proofSha256,
      },
    });

    return montarResultado(client, draw);
  });
}
