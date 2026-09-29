/**
 * Validade de um convite de equipe ou de dono, em dias. Suposicao S-CONV1.
 *
 * O prazo e regra de produto, nao configuracao de ambiente: um convite que vale
 * 7 dias em um ambiente e 30 em outro faz a mensagem "este convite expirou" dizer
 * coisas diferentes para a mesma pessoa. O banco usa o mesmo numero
 * (`invitations.expires_at`, migration 0016).
 */
export const INVITATION_TTL_DAYS = 7 as const;
