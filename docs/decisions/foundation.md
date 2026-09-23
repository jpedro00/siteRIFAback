# Fundação — decisões de implementação

Data: 2026-09-16. Escopo autorizado: Fase 1, sem commit, push ou deploy.

Fontes funcionais: DOC-01, D01 e prompts Astra/Geral.
O relatório Fase 0 foi fornecido integralmente na conversa; seu arquivo não foi encontrado.
O diagrama de arquitetura original foi inspecionado.

Suposição: preservar a fundação parcial existente e completá-la no diretório solicitado.
Suposição: identidade global em users, credenciais, fatores e sessões; memberships por comunidade.
As tabelas globais têm acesso restrito por usuário; não existe tenant compartilhado artificial.
Suposição: autenticação local com scrypt do Node, TOTP otplib e sessões opacas revogáveis no PostgreSQL.
Cookies HttpOnly, SameSite=Lax e Secure em produção; frontends usam proxy de mesma origem.
Suposição: provisionamento inicial de usuários por CLI administrativa, sem senha fixa ou autoelevação.
Suposição: Operações cria comunidades; os cinco perfis globais podem listar metadados de comunidades;
as demais capacidades ficam apenas no catálogo, sem rotas futuras. Toda operação global exige MFA.
A matriz de comunidade reproduz §3, separando status, financeiro completo e dados do comprador.
Suposição: tenant.created provisiona marca padrão via outbox e pg-boss. Entrega ao menos uma vez;
efeito, auditoria e recibo de consumo são atômicos no PostgreSQL, sem promessa de entrega externa única.

Pendências preservadas: S1/S3/S4 estorno e pagamento tardio; S5 cálculo; S6 AGENDADA apenas catálogo;
S7 imagens; S8 validação dos privilégios globais; S9 compliance; S10 cativos.
Pausa de cativos, consentimento por canal, edição de imagens em revisão, draw_versions,
rotas de reserva, segunda aprovação de estorno e cobrança SaaS ficam para suas fases.
Suposição para Fase 2: PostgreSQL sem Redis conforme Astra, divergente do desenho §9;
nenhuma reserva implementada nesta fase.
