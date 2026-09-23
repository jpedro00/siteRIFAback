import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_OWNER_URL,
  describeSkipReason,
  ensureMigrated,
  hasTestDatabase,
  ownerPool,
} from './helpers/testDb.js';
import type { DbPool } from '../src/pool.js';

/**
 * A Data API do provedor NAO faz parte desta arquitetura.
 *
 * O caminho e sempre: navegador -> API RIFAS (`app_user`) -> PostgreSQL, e
 * worker (`app_worker`) -> PostgreSQL. `anon`, `authenticated` e `service_role`
 * existem porque o Supabase os cria, nao porque algum fluxo daqui os use.
 *
 * POR QUE ESTE TESTE EXISTE. O provedor concede, POR PADRAO, acesso total sobre
 * toda tabela nova do schema `public` a esses tres papeis. Ninguem escreve esse
 * GRANT — ele vem dos DEFAULT PRIVILEGES do papel que roda as migrations. Quer
 * dizer que a primeira tabela da Fase 2 recriaria o problema em silencio se a
 * migration 0009 fosse revertida ou esquecida.
 *
 * Tres coisas que a RLS sozinha NAO resolveria, e que por isso sao verificadas
 * aqui pelo GRANT, nao pela policy:
 *
 *   1. `schema_migrations` nao tem policy nenhuma — o historico de migrations
 *      ficaria legivel e gravavel;
 *   2. TRUNCATE nao passa por RLS; nenhuma policy impede esvaziar `tenants`;
 *   3. `service_role` tem BYPASSRLS — para ele a RLS desta fundacao e
 *      decorativa.
 */

const PAPEIS_DATA_API = ['anon', 'authenticated', 'service_role'] as const;

/** Tabelas da fundacao. `schema_migrations` entra: e a que nao tem RLS. */
const TABELAS = [
  'schema_migrations',
  'tenants',
  'tenant_domains',
  'tenant_branding',
  'users',
  'user_credentials',
  'user_mfa_factors',
  'sessions',
  'platform_admins',
  'memberships',
  'audit_events',
  'outbox',
  'event_consumptions',
] as const;

describe.skipIf(!hasTestDatabase)(
  `RN01 · superficie da Data API ${hasTestDatabase ? '' : describeSkipReason()}`,
  () => {
    let owner: DbPool;
    /**
     * Num PostgreSQL proprio esses papeis nao existem, e nao ha superficie a
     * fechar. O teste entao verifica exatamente isso — a ausencia — em vez de
     * fingir que provou algo.
     */
    let papeisPresentes: string[] = [];

    beforeAll(async () => {
      await ensureMigrated();
      owner = ownerPool();
      const { rows } = await owner.query<{ rolname: string }>(
        'SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])',
        [PAPEIS_DATA_API],
      );
      papeisPresentes = rows.map((r) => r.rolname);
      void TEST_OWNER_URL;
    }, 120_000);

    afterAll(async () => {
      await owner?.end();
    });

    it('nenhum papel da Data API tem privilegio em tabela alguma de public', async () => {
      if (papeisPresentes.length === 0) {
        expect(papeisPresentes).toEqual([]); // PostgreSQL proprio: nada a fechar
        return;
      }

      const { rows } = await owner.query<{ table_name: string; grantee: string; privilege_type: string }>(
        `SELECT table_name, grantee, privilege_type
           FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND grantee = ANY($1::text[])`,
        [papeisPresentes],
      );

      const achados = rows.map((r) => `${r.grantee} -> ${r.privilege_type} em ${r.table_name}`);
      expect(achados, `privilegios que nao deveriam existir:\n${achados.join('\n')}`).toEqual([]);
    });

    it('as tabelas da fundacao existem e nenhuma esta exposta', async () => {
      // Guarda contra o falso verde do teste anterior: se uma tabela sumisse do
      // schema, "nenhum privilegio encontrado" passaria sem significar nada.
      const { rows } = await owner.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
      );
      const presentes = new Set(rows.map((r) => r.tablename));
      for (const tabela of TABELAS) {
        expect(presentes.has(tabela), `tabela ausente: ${tabela}`).toBe(true);
      }
    });

    it('os DEFAULT PRIVILEGES nao recriam o acesso em tabelas futuras', async () => {
      // A parte que protege a Fase 2: sem isto, a proxima tabela nasceria
      // aberta, e ninguem teria escrito um GRANT sequer.
      if (papeisPresentes.length === 0) return;

      const { rows } = await owner.query<{ acl: string | null }>(
        `SELECT array_to_string(d.defaclacl, ',') AS acl
           FROM pg_default_acl d
           JOIN pg_namespace n ON n.oid = d.defaclnamespace
          WHERE n.nspname = 'public'
            AND pg_get_userbyid(d.defaclrole) = current_user`,
      );

      for (const linha of rows) {
        for (const papel of papeisPresentes) {
          expect(linha.acl ?? '', `default privilege ainda concede a ${papel}`).not.toContain(
            `${papel}=`,
          );
        }
      }
    });

    it('`schema_migrations` nega tudo a quem nao e o dono', async () => {
      // Sem grants ja bastaria; a RLS e a segunda barreira, para o caso de um
      // GRANT ser restaurado por engano numa migration futura.
      const { rows } = await owner.query<{ rowsecurity: boolean; policies: string }>(
        `SELECT t.rowsecurity,
                (SELECT count(*)::text FROM pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = 'schema_migrations') AS policies
           FROM pg_tables t
          WHERE t.schemaname = 'public' AND t.tablename = 'schema_migrations'`,
      );
      expect(rows[0]?.rowsecurity, 'RLS deveria estar ligada').toBe(true);
      expect(rows[0]?.policies, 'sem policy = nega tudo exceto ao dono').toBe('0');
    });

    it('o migrador continua lendo `schema_migrations` (e o dono)', async () => {
      // A RLS acima nao pode ter quebrado quem aplica as migrations.
      const { rows } = await owner.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM schema_migrations',
      );
      expect(Number(rows[0]!.total)).toBeGreaterThanOrEqual(9);
    });

    it('os papeis da APLICACAO seguem com os privilegios de 0006', async () => {
      // O hardening nao pode ter atingido quem de fato precisa de acesso.
      const { rows } = await owner.query<{ grantee: string; tabelas: string }>(
        `SELECT grantee, count(DISTINCT table_name)::text AS tabelas
           FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND grantee IN ('app_user', 'app_worker')
          GROUP BY grantee`,
      );
      const porPapel = new Map(rows.map((r) => [r.grantee, Number(r.tabelas)]));
      expect(porPapel.get('app_user'), 'app_user perdeu acesso').toBeGreaterThan(0);
      expect(porPapel.get('app_worker'), 'app_worker perdeu acesso').toBeGreaterThan(0);
    });

    it('o schema da fila nao foi tocado', async () => {
      // O aviso generico do provedor sobre RLS no schema do pg-boss nao deve
      // ser tratado mecanicamente: os papeis da Data API nem enxergam o schema.
      if (papeisPresentes.length === 0) return;

      const { rows } = await owner.query<{ existe: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss') AS existe`,
      );
      if (!rows[0]?.existe) return;

      for (const papel of papeisPresentes) {
        const { rows: acesso } = await owner.query<{ tem: boolean }>(
          `SELECT has_schema_privilege($1, 'pgboss', 'USAGE') AS tem`,
          [papel],
        );
        expect(acesso[0]?.tem, `${papel} nao deveria enxergar o schema da fila`).toBe(false);
      }
    });
  },
);
