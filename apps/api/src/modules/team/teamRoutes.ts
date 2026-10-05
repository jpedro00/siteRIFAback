import type { Request, RequestHandler, Response } from 'express';
import { changeMemberRoleRequestSchema, inviteMemberRequestSchema } from '@clubedarifa/shared';
import type { AppDeps } from '../../deps.js';
import { ApiError } from '../../lib/apiError.js';
import {
  acceptInvitation,
  changeMemberRole,
  inviteMember,
  listTeam,
  previewInvitation,
  removeMember,
  revokeInvitation,
} from './teamService.js';

/** P9 · equipe e convites. A permissao `team:manage` vem do contrato e e aplicada antes daqui. */

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

const requireTenant = (req: Request) => {
  if (!req.tenant) throw ApiError.tenantNotResolved();
  return req.tenant;
};
const requireSession = (req: Request) => {
  if (!req.session) throw ApiError.unauthenticated();
  return req.session;
};
function pathParam(req: Request, nome: string): string {
  const valor = req.params[nome];
  if (typeof valor !== 'string' || valor === '') {
    throw ApiError.badRequest(`Parâmetro "${nome}" ausente na rota.`);
  }
  return valor;
}
const originOf = (req: Request) => ({ ip: req.context?.ip ?? null, userAgent: req.context?.userAgent ?? null });

export function buildTeamHandlers(deps: AppDeps): Record<string, RequestHandler> {
  return {
    tenantTeam: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      res.status(200).json(await listTeam(deps, { tenantId: tenant.tenantId, userId: session.userId }));
    }),

    inviteTeamMember: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      const data = inviteMemberRequestSchema.parse(req.body);
      res.status(201).json(
        await inviteMember(deps, {
          tenantId: tenant.tenantId,
          userId: session.userId,
          data,
          origin: originOf(req),
        }),
      );
    }),

    revokeTeamInvitation: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      await revokeInvitation(deps, {
        tenantId: tenant.tenantId,
        userId: session.userId,
        invitationId: pathParam(req, 'id'),
        origin: originOf(req),
      });
      res.status(204).end();
    }),

    changeTeamMemberRole: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      const { role } = changeMemberRoleRequestSchema.parse(req.body);
      res.status(200).json(
        await changeMemberRole(deps, {
          tenantId: tenant.tenantId,
          userId: session.userId,
          membershipId: pathParam(req, 'id'),
          role,
          origin: originOf(req),
        }),
      );
    }),

    removeTeamMember: asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const session = requireSession(req);
      await removeMember(deps, {
        tenantId: tenant.tenantId,
        userId: session.userId,
        membershipId: pathParam(req, 'id'),
        origin: originOf(req),
      });
      res.status(204).end();
    }),

    /** Prévia pelo token: sem sessão. O token É o segredo; o e-mail sai mascarado. */
    invitationPreview: asyncHandler(async (req, res) => {
      res.status(200).json(await previewInvitation(deps, pathParam(req, 'token')));
    }),

    /** Aceite: exige sessão cujo e-mail seja o do convite (conferido no banco). */
    acceptInvitation: asyncHandler(async (req, res) => {
      const session = requireSession(req);
      res.status(200).json(await acceptInvitation(deps, { userId: session.userId, token: pathParam(req, 'token') }));
    }),
  };
}
