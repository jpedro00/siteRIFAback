import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { loadRootEnv } from '../loadEnv.js';
import { pgConnectionConfig } from '../ssl.js';

const { Client } = pg;

/**
 * Emite um LINK DE REDEFINICAO DE SENHA para uma conta, por quem opera o banco.
 *
 * Existe para o caso em que a pessoa nao consegue entrar e a plataforma ainda nao tem
 * provedor de e-mail para entregar o token. NAO define senha nenhuma: a pessoa abre o link e
 * escolhe a PROPRIA senha pela tela de redefinicao, com as mesmas regras do fluxo normal
 * (uso unico, validade curta, revoga todas as sessoes ao concluir).
 *
 *   - Usa a MESMA funcao do fluxo normal (`app.request_password_reset`): so o hash do token e
 *     gravado e os tokens anteriores da conta sao invalidados.
 *   - Quem roda precisa da credencial administrativa do banco (MIGRATION_DATABASE_URL). Nao ha
 *     rota HTTP, entao nao ha como um terceiro pedir isto pela internet.
 *   - O token aparece UMA vez, na saida deste comando, e vai so para quem roda. Entregue-o ao
 *     DONO DA CONTA por um canal que voce confie. Nao cole em chat publico, ticket ou log.
 *   - Fica registrado em `audit_events` (sem o token).
 *
 * Uso:
 *   MIGRATION_DATABASE_URL=... DATABASE_CA_CERT=... DATABASE_SSL=true \
 *   PASSWORD_RESET_URL=https://exemplo/redefinir-senha \
 *   npm run db:issue-reset -- pessoa@exemplo.com
 */
const TTL_MINUTES = 30;

async function main(): Promise<void> {
  await loadRootEnv();
  const email = (process.argv[2] ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('Informe o e-mail da conta: npm run db:issue-reset -- pessoa@exemplo.com');
  }
  const url = process.env['MIGRATION_DATABASE_URL']?.trim();
  if (!url) throw new Error('Defina MIGRATION_DATABASE_URL (credencial administrativa).');

  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token, 'utf8').digest('hex');

  const client = new Client({ ...pgConnectionConfig(url), application_name: 'clubedarifa-issue-reset' });
  await client.connect();
  try {
    await client.query('BEGIN');
    // Sem intervalo minimo: quem opera sabe o que esta fazendo.
    const { rows } = await client.query<{ user_id: string; email: string }>(
      'SELECT user_id, email FROM app.request_password_reset($1, $2, $3, 0)',
      [email, hash, TTL_MINUTES],
    );
    const conta = rows[0];
    if (!conta) {
      await client.query('ROLLBACK');
      throw new Error('Nenhum token emitido: conta inexistente, inativa ou sem senha cadastrada.');
    }
    await client.query(
      `INSERT INTO audit_events (tenant_id, actor_user_id, actor_type, action, target_type, target_id, after)
       VALUES (NULL, $1::uuid, 'USER', 'auth.password_reset.requested', 'user', ($1::uuid)::text,
               jsonb_build_object('via', 'operator_cli', 'ttlMinutes', $2::int))`,
      [conta.user_id, TTL_MINUTES],
    );
    await client.query('COMMIT');

    const base = process.env['PASSWORD_RESET_URL']?.trim();
    console.log(`Link emitido para ${conta.email} (vale por ${TTL_MINUTES} minutos, uso unico):`);
    console.log(base ? `${base}#token=${token}` : `<URL da pagina /redefinir-senha>#token=${token}`);
    console.log('Entregue ao dono da conta por um canal confiavel. Ele nao fica gravado em claro em lugar nenhum.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('issue-reset falhou:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
