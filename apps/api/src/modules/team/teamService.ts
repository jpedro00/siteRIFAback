import { translateEntitlementError } from '../billing/entitlementService.js';
import { withTenant, withUser, type PoolClient } from '@clubedarifa/db';
import type {
  AcceptInvitationResponse,
  InvitationPreview,
  InviteMemberRequest,
  InviteMemberResponse,
  MembershipRole,
  TeamMember,
  TeamResponse,
} from '@clubedarifa/shared';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';
import { generateInviteToken, hashInviteToken, maskEmail } from '../../lib/inviteToken.js';
import { recordAuditEvent } from '../audit/auditService.js';
import type { ActionOrigin } from '../draws/drawService.js';
import { enqueueOutboxEvent } from '../outbox/outboxService.js';

/**
 * Equipe e convites. P9 · RN11.
 *
 * REGRAS QUE ESTE ARQUIVO SUSTENTA
 *  - so o dono gerencia a equipe (`team:manage`, aplicada na rota);
 *  - ninguem muda o proprio papel nem se remove: evita a comunidade ficar sem
 *    alguem que consiga administra-la;
 *  - a comunidade nunca fica sem dono: o ultimo OWNER nao sai nem e rebaixado;
 *  - vinculo NAO se apaga, se REVOGA (`revoked_at`): o historico de quem teve
 *    acesso a quê e parte da trilha. Trocar de papel revoga o vinculo antigo e
 *    cria outro;
 *  - toda mudanca deixa auditoria e evento na outbox, na mesma transacao.
 */

interface MemberRow {
  membership_id: string;
  user_id: string;
  email: string;
  display_name: string;
  role: MembershipRole;
  accepted_at: string | null;
}

const toMember = (r: MemberRow, self: string): TeamMember => ({
  membershipId: r.membership_id,
  userId: r.user_id,
  email: r.email,
  displayName: r.display_name,
  role: r.role,
  acceptedAt: r.accepted_at,
  isSelf: r.user_id === self,
});

export async function listTeam(
  deps: AppDeps,
  input: { tenantId: string; userId: string },
): Promise<TeamResponse> {
  return withTenant(deps.pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
    const { rows: membros } = await client.query<MemberRow>(
      `SELECT m.id AS membership_id, m.user_id, u.email, u.display_name, m.role::text AS role, m.accepted_at
         FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.revoked_at IS NULL
        ORDER BY m.role, u.display_name`,
    );
    const { rows: convites } = await client.query<{
      id: string;
      email: string;
      role: MembershipRole;
      created_at: string;
      expires_at: string;
      expired: boolean;
    }>(
      `SELECT id, email, role::text AS role, created_at, expires_at, (expires_at <= now()) AS expired
         FROM invitations
        WHERE accepted_at IS NULL AND revoked_at IS NULL
        ORDER BY created_at DESC`,
    );
    return {
      members: membros.map((r) => toMember(r, input.userId)),
      invitations: convites.map((c) => ({
        id: c.id,
        email: c.email,
        role: c.role,
        createdAt: c.created_at,
        expiresAt: c.expires_at,
        expired: c.expired,
      })),
    };
  });
}

export async function inviteMember(
  deps: AppDeps,
  input: {
    tenantId: string;
    userId: string;
    data: InviteMemberRequest;
    origin?: ActionOrigin | undefined;
  },
): Promise<InviteMemberResponse> {
  return withTenant(deps.pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
    const { email, role } = input.data;

    const { rows: jaMembro } = await client.query(
      `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.revoked_at IS NULL AND u.email = $1 AND m.role = $2::membership_role`,
      [email, role],
    );
    if (jaMembro.length > 0) {
      throw ApiError.conflict('Essa pessoa já faz parte da equipe com esse papel.');
    }

    // Reenviar revoga o convite anterior: o token velho deixa de funcionar.
    await client.query(
      `UPDATE invitations SET revoked_at = now()
        WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [email],
    );

    const { token, hash } = generateInviteToken();
    const { rows } = await client.query<{ id: string; expires_at: string }>(
      `INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by)
       VALUES ($1, $2, $3::membership_role, $4, $5)
       RETURNING id, expires_at`,
      [input.tenantId, email, role, hash, input.userId],
    );
    const convite = rows[0]!;

    await recordAuditEvent(client, {
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'team.invited',
      targetType: 'invitation',
      targetId: convite.id,
      after: { role, email: maskEmail(email) },
      ip: input.origin?.ip ?? null,
      userAgent: input.origin?.userAgent ?? null,
    });

    return { id: convite.id, email, role, expiresAt: convite.expires_at, token };
  });
}

export async function revokeInvitation(
  deps: AppDeps,
  input: { tenantId: string; userId: string; invitationId: string; origin?: ActionOrigin | undefined },
): Promise<void> {
  await withTenant(deps.pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
    const { rows } = await client.query<{ email: string; role: string }>(
      `UPDATE invitations SET revoked_at = now()
        WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
        RETURNING email, role::text AS role`,
      [input.invitationId],
    );
    if (rows.length === 0) throw ApiError.notFound('Convite não encontrado ou já encerrado.');

    await recordAuditEvent(client, {
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'team.invitation_revoked',
      targetType: 'invitation',
      targetId: input.invitationId,
      after: { role: rows[0]!.role, email: maskEmail(rows[0]!.email) },
      ip: input.origin?.ip ?? null,
      userAgent: input.origin?.userAgent ?? null,
    });
  });
}

/** Trava o vinculo e aplica as travas de seguranca comuns a trocar e remover. */
async function carregarVinculo(
  client: PoolClient,
  input: { userId: string; membershipId: string; acao: 'alterar' | 'remover' },
): Promise<{ id: string; user_id: string; role: MembershipRole }> {
  const { rows } = await client.query<{ id: string; user_id: string; role: MembershipRole }>(
    `SELECT id, user_id, role::text AS role FROM memberships
      WHERE id = $1 AND revoked_at IS NULL FOR UPDATE`,
    [input.membershipId],
  );
  const vinculo = rows[0];
  if (!vinculo) throw ApiError.notFound('Membro não encontrado.');

  if (vinculo.user_id === input.userId) {
    throw ApiError.conflict(
      input.acao === 'alterar'
        ? 'Você não pode alterar o seu próprio papel.'
        : 'Você não pode remover a si mesmo da equipe.',
    );
  }

  if (vinculo.role === 'OWNER') {
    const { rows: outros } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM memberships
        WHERE role = 'OWNER' AND revoked_at IS NULL AND id <> $1`,
      [vinculo.id],
    );
    if (outros[0]!.n === 0) {
      throw ApiError.conflict('A comunidade precisa de pelo menos um dono.');
    }
  }
  return vinculo;
}

async function revogarVinculo(
  client: PoolClient,
  tenantId: string,
  actor: string,
  vinculo: { id: string; user_id: string },
): Promise<void> {
  await client.query('UPDATE memberships SET revoked_at = now(), revoked_by = $2 WHERE id = $1', [
    vinculo.id,
    actor,
  ]);
  await enqueueOutboxEvent(client, {
    tenantId,
    eventType: 'membership.revoked',
    payload: {
      tenantId,
      membershipId: vinculo.id,
      userId: vinculo.user_id,
      revokedByUserId: actor,
    },
  });
}

export async function changeMemberRole(
  deps: AppDeps,
  input: {
    tenantId: string;
    userId: string;
    membershipId: string;
    role: MembershipRole;
    origin?: ActionOrigin | undefined;
  },
): Promise<TeamMember> {
  return withTenant(deps.pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
    const atual = await carregarVinculo(client, {
      userId: input.userId,
      membershipId: input.membershipId,
      acao: 'alterar',
    });
    if (atual.role === input.role) throw ApiError.conflict('O membro já tem esse papel.');

    const { rows: jaTem } = await client.query(
      `SELECT 1 FROM memberships
        WHERE user_id = $1 AND role = $2::membership_role AND revoked_at IS NULL`,
      [atual.user_id, input.role],
    );
    if (jaTem.length > 0) throw ApiError.conflict('O membro já tem esse papel.');

    await revogarVinculo(client, input.tenantId, input.userId, atual);
    const { rows: novo } = await client.query<{ id: string }>(
      `INSERT INTO memberships (tenant_id, user_id, role, accepted_at, created_by)
       VALUES ($1, $2, $3::membership_role, now(), $4) RETURNING id`,
      [input.tenantId, atual.user_id, input.role, input.userId],
    );
    await enqueueOutboxEvent(client, {
      tenantId: input.tenantId,
      eventType: 'membership.granted',
      payload: {
        tenantId: input.tenantId,
        membershipId: novo[0]!.id,
        userId: atual.user_id,
        role: input.role,
        grantedByUserId: input.userId,
      },
    });

    await recordAuditEvent(client, {
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'team.member_role_changed',
      targetType: 'membership',
      targetId: novo[0]!.id,
      before: { role: atual.role },
      after: { role: input.role, userId: atual.user_id },
      ip: input.origin?.ip ?? null,
      userAgent: input.origin?.userAgent ?? null,
    });

    const { rows } = await client.query<MemberRow>(
      `SELECT m.id AS membership_id, m.user_id, u.email, u.display_name, m.role::text AS role, m.accepted_at
         FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.id = $1`,
      [novo[0]!.id],
    );
    return toMember(rows[0]!, input.userId);
  });
}

export async function removeMember(
  deps: AppDeps,
  input: { tenantId: string; userId: string; membershipId: string; origin?: ActionOrigin | undefined },
): Promise<void> {
  await withTenant(deps.pool, { tenantId: input.tenantId, userId: input.userId }, async (client) => {
    const vinculo = await carregarVinculo(client, {
      userId: input.userId,
      membershipId: input.membershipId,
      acao: 'remover',
    });
    await revogarVinculo(client, input.tenantId, input.userId, vinculo);

    await recordAuditEvent(client, {
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'team.member_removed',
      targetType: 'membership',
      targetId: vinculo.id,
      before: { role: vinculo.role },
      after: { userId: vinculo.user_id },
      ip: input.origin?.ip ?? null,
      userAgent: input.origin?.userAgent ?? null,
    });
  });
}

// ---------------------------------------------------------------------------
// Convite pelo token (sem vinculo ainda)
// ---------------------------------------------------------------------------

export async function previewInvitation(deps: AppDeps, token: string): Promise<InvitationPreview> {
  const client = await deps.pool.connect();
  try {
    const { rows } = await client.query<{
      tenant_name: string;
      role: MembershipRole;
      email_masked: string;
      expires_at: string;
      state: InvitationPreview['state'];
    }>('SELECT * FROM app.invitation_preview($1)', [hashInviteToken(token)]);
    const convite = rows[0];
    if (!convite) throw ApiError.notFound('Convite não encontrado.');
    return {
      tenantName: convite.tenant_name,
      role: convite.role,
      emailMasked: convite.email_masked,
      expiresAt: convite.expires_at,
      state: convite.state,
    };
  } finally {
    client.release();
  }
}

export async function acceptInvitation(
  deps: AppDeps,
  input: { userId: string; token: string },
): Promise<AcceptInvitationResponse> {
  return withUser(deps.pool, { userId: input.userId }, async (client) => {
    try {
      const { rows } = await client.query<{ tenant_slug: string; tenant_name: string; role: MembershipRole }>(
        'SELECT out_tenant_slug AS tenant_slug, out_tenant_name AS tenant_name, out_role::text AS role FROM app.accept_invitation($1)',
        [hashInviteToken(input.token)],
      );
      const r = rows[0]!;
      return { tenantSlug: r.tenant_slug, tenantName: r.tenant_name, role: r.role };
    } catch (error) {
      // A franquia da equipe (`ENTITLEMENT:*`) tambem usa P0001: traduz ANTES de olhar o codigo.
      const traduzido = translateEntitlementError(error);
      if (traduzido !== error) throw traduzido;
      const codigo = (error as { code?: string }).code;
      if (codigo === 'P0002') throw ApiError.notFound('Convite não encontrado.');
      if (codigo === 'P0001') throw ApiError.conflict('Este convite já foi usado, foi revogado ou expirou.');
      if (codigo === 'P0003') throw ApiError.unauthenticated();
      throw error;
    }
  });
}
