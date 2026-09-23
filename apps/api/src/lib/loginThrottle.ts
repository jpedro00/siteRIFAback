import { createHash } from 'node:crypto';

/**
 * Limite de tentativas de login POR ORIGEM, aplicado antes da autenticacao.
 *
 * O PROBLEMA QUE ISTO RESOLVE
 *
 * O bloqueio por conta (`user_credentials.failed_attempts`) defende UMA conta
 * contra muitas tentativas. Ele nao defende a PLATAFORMA contra uma origem
 * atacando muitas contas — pelo contrario: quanto melhor ele funciona, mais
 * barato fica trancar contas alheias. Quem conhecesse uma lista de e-mails
 * validos derrubaria o acesso de todos eles com cinco requisicoes cada.
 *
 * A defesa nao pode ser afrouxar o bloqueio por conta: forca bruta contra uma
 * senha continua sendo a ameaca mais provavel. Precisa ser uma camada ANTES,
 * que corte a origem abusiva antes de ela conseguir gastar as tentativas de
 * varias contas.
 *
 * DUAS DIMENSOES, e as duas importam
 *
 *   falhas totais     · quanta forca bruta uma origem consegue aplicar;
 *   contas distintas  · em quantas contas diferentes ela encosta.
 *
 * A segunda e a que separa o uso legitimo do ataque. Quem erra a propria senha
 * insiste numa conta so; quem quer trancar contas alheias percorre muitas. Um
 * limite apenas por volume trataria os dois igual.
 *
 * O EFEITO, EM NUMEROS
 *
 * Com os padroes (janela 15 min, 20 falhas, 5 contas) e `LOGIN_MAX_ATTEMPTS=5`,
 * uma origem consegue esgotar no maximo `20 / 5 = 4` contas por janela, contra
 * um numero ILIMITADO antes. E uma mitigacao, nao uma eliminacao — esta escrito
 * assim de proposito.
 *
 * O QUE NAO E GUARDADO
 *
 * O e-mail alvo nao entra em memoria: guarda-se um resumo SHA-256 truncado,
 * suficiente para contar alvos distintos e inutil para reconstruir a lista de
 * enderecos sondados. Contar nao exige saber quem.
 *
 * ESTADO EM MEMORIA, e por que basta aqui
 *
 * Nada de Redis nesta fase. A alternativa seria uma tabela no PostgreSQL, mas
 * gravar uma linha por tentativa FALHA daria ao atacante uma escrita de banco
 * por requisicao — o limitador viraria o amplificador. Contador em memoria e
 * O(1) e nao toca disco.
 *
 * O preco esta registrado: o balde e POR PROCESSO. Com varias instancias da API
 * o limite efetivo se multiplica pelo numero de instancias, e um reinicio zera
 * os baldes. Para staging, com uma instancia, isso e exato. Para producao com
 * varias, o limite precisa migrar para um estado compartilhado — e essa decisao
 * esta registrada em docs/decisions, nao escondida aqui.
 */

export interface LoginThrottleOptions {
  /** Tamanho da janela, em milissegundos. */
  readonly windowMs: number;
  /** Falhas de login que uma origem pode acumular na janela. */
  readonly maxFailures: number;
  /** Contas DISTINTAS em que uma origem pode encostar na janela. */
  readonly maxDistinctAccounts: number;
  /**
   * Teto de origens acompanhadas ao mesmo tempo.
   *
   * Sem ele, o proprio limitador seria um vetor: bastaria variar a origem para
   * fazer o mapa crescer sem limite. Ao estourar, as janelas mais antigas sao
   * descartadas primeiro.
   */
  readonly maxTrackedOrigins?: number;
}

export interface ThrottleDecision {
  readonly allowed: boolean;
  /** Segundos ate a janela virar. Vai no cabecalho `Retry-After`. */
  readonly retryAfterSeconds: number;
  readonly reason?: 'too_many_failures' | 'too_many_accounts';
}

interface OriginWindow {
  windowStartedAt: number;
  failures: number;
  accounts: Set<string>;
}

const DEFAULT_MAX_TRACKED_ORIGINS = 10_000;

/** Origem ausente vira um balde proprio — compartilhado, mas nunca ilimitado. */
const UNKNOWN_ORIGIN = '@desconhecida';

function accountKeyOf(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex').slice(0, 16);
}

export class LoginThrottle {
  readonly #options: Required<LoginThrottleOptions>;
  readonly #windows = new Map<string, OriginWindow>();

  constructor(options: LoginThrottleOptions) {
    this.#options = {
      maxTrackedOrigins: DEFAULT_MAX_TRACKED_ORIGINS,
      ...options,
    };
  }

  /**
   * Janela vigente da origem, ja descartando a expirada.
   *
   * Janela FIXA, nao deslizante: ao expirar, os contadores zeram de uma vez. A
   * deslizante seria mais justa na borda e exigiria guardar cada tentativa com
   * seu horario — mais memoria por origem, justamente o que nao se quer dar a
   * quem esta atacando.
   */
  #windowFor(origin: string, now: number): OriginWindow {
    const existing = this.#windows.get(origin);
    if (existing && now - existing.windowStartedAt < this.#options.windowMs) {
      return existing;
    }
    const fresh: OriginWindow = { windowStartedAt: now, failures: 0, accounts: new Set() };
    this.#windows.set(origin, fresh);
    return fresh;
  }

  #prune(now: number): void {
    if (this.#windows.size <= this.#options.maxTrackedOrigins) return;

    for (const [key, window] of this.#windows) {
      if (now - window.windowStartedAt >= this.#options.windowMs) this.#windows.delete(key);
    }
    if (this.#windows.size <= this.#options.maxTrackedOrigins) return;

    // Ainda cheio: descarta as janelas mais antigas, que sao as mais proximas
    // de expirar de qualquer forma.
    const porIdade = [...this.#windows.entries()].sort(
      (a, b) => a[1].windowStartedAt - b[1].windowStartedAt,
    );
    const excedente = this.#windows.size - this.#options.maxTrackedOrigins;
    for (let i = 0; i < excedente; i += 1) this.#windows.delete(porIdade[i]![0]);
  }

  /**
   * A origem pode tentar?
   *
   * Consulta pura: NAO conta a tentativa. Quem conta e `recordFailure`, e so
   * quando a tentativa de fato falha — um login correto nao deve gastar
   * orcamento de ninguem.
   */
  check(origin: string | null, now: number = Date.now()): ThrottleDecision {
    const key = origin ?? UNKNOWN_ORIGIN;
    const window = this.#windows.get(key);

    if (!window || now - window.windowStartedAt >= this.#options.windowMs) {
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const restante = this.#options.windowMs - (now - window.windowStartedAt);
    const retryAfterSeconds = Math.max(1, Math.ceil(restante / 1000));

    if (window.failures >= this.#options.maxFailures) {
      return { allowed: false, retryAfterSeconds, reason: 'too_many_failures' };
    }
    if (window.accounts.size > this.#options.maxDistinctAccounts) {
      return { allowed: false, retryAfterSeconds, reason: 'too_many_accounts' };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Registra UMA tentativa falha daquela origem contra aquele e-mail. */
  recordFailure(origin: string | null, email: string, now: number = Date.now()): void {
    const key = origin ?? UNKNOWN_ORIGIN;
    const window = this.#windowFor(key, now);
    window.failures += 1;
    window.accounts.add(accountKeyOf(email));
    this.#prune(now);
  }

  /**
   * Login bem-sucedido: a janela daquela origem e liberada.
   *
   * Quem acabou de provar a credencial nao e o caso que este limite persegue, e
   * manter a punicao depois do acerto castigaria a pessoa que so errou a senha
   * algumas vezes antes de lembrar.
   */
  recordSuccess(origin: string | null): void {
    this.#windows.delete(origin ?? UNKNOWN_ORIGIN);
  }

  /** Apenas para testes e diagnostico. */
  reset(): void {
    this.#windows.clear();
  }

  get trackedOrigins(): number {
    return this.#windows.size;
  }
}
