import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  cleanup,
  createHarness,
  hasTestDatabase,
  seedAccount,
  skipReason,
  unique,
  type Harness,
} from './helpers/apiHarness.js';
import { LoginThrottle } from '../src/lib/loginThrottle.js';

/**
 * Limite de tentativas POR ORIGEM, antes da autenticacao.
 *
 * A AMEACA. O bloqueio por conta defende UMA conta contra muitas tentativas.
 * Ele nao defende a plataforma contra uma origem que ataca MUITAS contas — e,
 * quanto melhor funciona, mais barato fica trancar contas alheias: cinco
 * requisicoes por e-mail conhecido derrubavam o acesso de quem quer que fosse.
 *
 * O que estes testes provam e a diferenca entre as duas coisas.
 */

const IP_ATACANTE = '203.0.113.10'; // TEST-NET-3, RFC 5737
const IP_OUTRO = '198.51.100.20'; // TEST-NET-2

describe.skipIf(!hasTestDatabase)(
  `API · limite de login por origem ${hasTestDatabase ? '' : skipReason}`,
  () => {
    let harness: Harness;

    beforeAll(async () => {
      // Limites pequenos e explicitos: 6 falhas ou 3 contas distintas por
      // janela. Com LOGIN_MAX_ATTEMPTS=5, uma origem nao consegue esgotar nem
      // duas contas antes de ser cortada.
      harness = await createHarness({
        originLimits: { windowMinutes: 15, maxFailures: 6, maxAccounts: 3 },
      });
      await cleanup(harness.owner);
    });

    afterAll(async () => {
      await harness?.close();
    });

    beforeEach(() => {
      harness.loginThrottle.reset();
    });

    /** Uma tentativa de login vinda de uma origem declarada. */
    function tentar(ip: string, email: string, password = 'senha-errada-1234') {
      return request(harness.app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email, password });
    }

    it('uma origem NAO consegue trancar varias contas conhecidas', async () => {
      // O cenario exato do risco: o atacante conhece os e-mails e quer derrubar
      // o acesso de todos.
      const contas = [
        await seedAccount(harness.owner),
        await seedAccount(harness.owner),
        await seedAccount(harness.owner),
        await seedAccount(harness.owner),
      ];

      for (const conta of contas) {
        for (let i = 0; i < harness.config.LOGIN_MAX_ATTEMPTS; i += 1) {
          await tentar(IP_ATACANTE, conta.email);
        }
      }

      const { rows } = await harness.owner.query<{ trancadas: string }>(
        `SELECT count(*)::text AS trancadas
           FROM user_credentials
          WHERE user_id = ANY($1::uuid[]) AND locked_until IS NOT NULL`,
        [contas.map((c) => c.userId)],
      );

      // Sem o limite por origem, seriam as quatro.
      expect(Number(rows[0]!.trancadas)).toBeLessThan(contas.length);
    });

    it('a origem cortada para de gastar o orcamento das contas', async () => {
      // O ponto central: a requisicao recusada NAO chega a
      // `record_login_attempt`. E isso que quebra a amplificacao.
      const alvo = await seedAccount(harness.owner);

      for (let i = 0; i < 10; i += 1) await tentar(IP_ATACANTE, `${unique('x-')}@example.com`);

      const cortada = await tentar(IP_ATACANTE, alvo.email);
      expect(cortada.status).toBe(429);

      const { rows } = await harness.owner.query<{ failed_attempts: number }>(
        'SELECT failed_attempts FROM user_credentials WHERE user_id = $1',
        [alvo.userId],
      );
      expect(rows[0]!.failed_attempts).toBe(0);
    });

    it('muitas tentativas na MESMA origem sao cortadas', async () => {
      const conta = await seedAccount(harness.owner);

      for (let i = 0; i < harness.config.LOGIN_ORIGIN_MAX_FAILURES; i += 1) {
        const res = await tentar(IP_ATACANTE, conta.email);
        expect(res.status, `tentativa ${i + 1} deveria ser avaliada`).not.toBe(429);
      }

      const cortada = await tentar(IP_ATACANTE, conta.email);
      expect(cortada.status).toBe(429);
      expect(cortada.body.error.code).toBe('RATE_LIMITED');
      // Cliente honesto precisa saber QUANDO tentar de novo.
      expect(Number(cortada.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('origens diferentes tem orcamentos independentes', async () => {
      // Cortar a origem A nao pode derrubar quem esta noutra rede.
      const conta = await seedAccount(harness.owner);

      for (let i = 0; i < 10; i += 1) await tentar(IP_ATACANTE, conta.email);
      expect((await tentar(IP_ATACANTE, conta.email)).status).toBe(429);

      const outra = await tentar(IP_OUTRO, conta.email);
      expect(outra.status).not.toBe(429);
    });

    it('login VALIDO continua funcionando e libera a origem', async () => {
      // Quem erra a senha algumas vezes e depois lembra nao pode ficar preso.
      const conta = await seedAccount(harness.owner);

      for (let i = 0; i < 3; i += 1) await tentar(IP_OUTRO, conta.email);

      const ok = await request(harness.app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', IP_OUTRO)
        .send({ email: conta.email, password: conta.password });
      expect(ok.status).toBe(200);

      // A janela daquela origem foi liberada pelo acerto.
      const depois = await tentar(IP_OUTRO, conta.email);
      expect(depois.status).not.toBe(429);
    });

    it('a resposta continua sem revelar se o e-mail existe', async () => {
      // O 429 fala do comportamento de quem chama, nunca de uma conta. Abaixo
      // do limite, existente e inexistente permanecem indistinguiveis.
      const conta = await seedAccount(harness.owner);

      const existente = await tentar(IP_OUTRO, conta.email);
      const inexistente = await tentar(IP_OUTRO, `${unique('ghost-')}@example.com`);

      expect(existente.status).toBe(401);
      expect(inexistente.status).toBe(401);
      expect(existente.body).toEqual(inexistente.body);
    });

    it('o limite tambem corta a VARREDURA de e-mails inexistentes', async () => {
      // Sondar enderecos e o mesmo abuso com outro objetivo; nao pode sair de
      // graca so porque nenhuma conta foi tocada.
      for (let i = 0; i < harness.config.LOGIN_ORIGIN_MAX_FAILURES; i += 1) {
        await tentar(IP_ATACANTE, `${unique('scan-')}@example.com`);
      }
      const cortada = await tentar(IP_ATACANTE, `${unique('scan-')}@example.com`);
      expect(cortada.status).toBe(429);
    });

    it('o 429 do limite NAO revela nada sobre conta alguma', async () => {
      // Origem cortada: conta existente e inexistente recebem a mesma resposta.
      const conta = await seedAccount(harness.owner);
      for (let i = 0; i < 10; i += 1) await tentar(IP_ATACANTE, `${unique('y-')}@example.com`);

      const comConta = await tentar(IP_ATACANTE, conta.email);
      const semConta = await tentar(IP_ATACANTE, `${unique('ghost-')}@example.com`);

      expect(comConta.status).toBe(429);
      expect(semConta.status).toBe(429);
      expect(comConta.body).toEqual(semConta.body);
    });
  },
);

/**
 * Regras do contador em si, sem HTTP nem banco.
 *
 * A janela e FIXA, nao deslizante, e o teste usa relogio injetado: depender do
 * tempo real tornaria o caso "a janela virou" lento e intermitente.
 */
describe('LoginThrottle · contador', () => {
  const opcoes = { windowMs: 60_000, maxFailures: 5, maxDistinctAccounts: 3 };

  it('permite enquanto o orcamento nao acaba', () => {
    const t = new LoginThrottle(opcoes);
    for (let i = 0; i < 4; i += 1) t.recordFailure('1.2.3.4', 'a@example.com', 1_000);
    expect(t.check('1.2.3.4', 1_000).allowed).toBe(true);
  });

  it('corta ao atingir o total de falhas', () => {
    const t = new LoginThrottle(opcoes);
    for (let i = 0; i < 5; i += 1) t.recordFailure('1.2.3.4', 'a@example.com', 1_000);
    const decisao = t.check('1.2.3.4', 1_000);
    expect(decisao.allowed).toBe(false);
    expect(decisao.reason).toBe('too_many_failures');
  });

  it('corta ao encostar em contas distintas demais', () => {
    // A dimensao que separa erro honesto de ataque: uma pessoa insiste na
    // PROPRIA conta; quem quer trancar contas alheias percorre varias.
    const t = new LoginThrottle(opcoes);
    for (const email of ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']) {
      t.recordFailure('1.2.3.4', email, 1_000);
    }
    const decisao = t.check('1.2.3.4', 1_000);
    expect(decisao.allowed).toBe(false);
    expect(decisao.reason).toBe('too_many_accounts');
  });

  it('insistir na MESMA conta nao dispara o limite de contas', () => {
    const t = new LoginThrottle(opcoes);
    for (let i = 0; i < 4; i += 1) t.recordFailure('1.2.3.4', 'a@x.com', 1_000);
    expect(t.check('1.2.3.4', 1_000).reason).not.toBe('too_many_accounts');
  });

  it('a mesma conta em caixas diferentes conta uma vez so', () => {
    const t = new LoginThrottle(opcoes);
    for (const email of ['A@X.com', 'a@x.com', ' a@x.com ']) {
      t.recordFailure('1.2.3.4', email, 1_000);
    }
    expect(t.check('1.2.3.4', 1_000).allowed).toBe(true);
  });

  it('a janela vira e o orcamento volta', () => {
    const t = new LoginThrottle(opcoes);
    for (let i = 0; i < 5; i += 1) t.recordFailure('1.2.3.4', 'a@x.com', 1_000);
    expect(t.check('1.2.3.4', 1_000).allowed).toBe(false);
    expect(t.check('1.2.3.4', 1_000 + 60_001).allowed).toBe(true);
  });

  it('o acerto libera a origem imediatamente', () => {
    const t = new LoginThrottle(opcoes);
    for (let i = 0; i < 5; i += 1) t.recordFailure('1.2.3.4', 'a@x.com', 1_000);
    expect(t.check('1.2.3.4', 1_000).allowed).toBe(false);
    t.recordSuccess('1.2.3.4');
    expect(t.check('1.2.3.4', 1_000).allowed).toBe(true);
  });

  it('origem ausente cai num balde proprio, e limitado', () => {
    // Sem IP conhecido o limite nao pode simplesmente sumir.
    const t = new LoginThrottle(opcoes);
    for (let i = 0; i < 5; i += 1) t.recordFailure(null, 'a@x.com', 1_000);
    expect(t.check(null, 1_000).allowed).toBe(false);
    expect(t.check('1.2.3.4', 1_000).allowed).toBe(true);
  });

  it('variar a origem nao faz a memoria crescer sem limite', () => {
    // O proprio limitador seria um vetor se guardasse uma entrada por IP
    // forjado. O teto descarta as janelas mais antigas.
    const t = new LoginThrottle({ ...opcoes, maxTrackedOrigins: 50 });
    for (let i = 0; i < 500; i += 1) t.recordFailure(`10.0.0.${i}`, 'a@x.com', 1_000 + i);
    expect(t.trackedOrigins).toBeLessThanOrEqual(50);
  });

  it('informa quando tentar de novo', () => {
    const t = new LoginThrottle(opcoes);
    for (let i = 0; i < 5; i += 1) t.recordFailure('1.2.3.4', 'a@x.com', 1_000);
    const decisao = t.check('1.2.3.4', 31_000);
    expect(decisao.allowed).toBe(false);
    expect(decisao.retryAfterSeconds).toBe(30);
  });
});
