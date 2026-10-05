import { describe, expect, it } from 'vitest';
import { createLogger, maskEmail, maskName, maskPhone, sanitize } from '../src/index.js';

/**
 * Logs: uma linha JSON por evento, correlacionavel e SEM dado pessoal.
 */
function capturar() {
  const linhas: { linha: string; nivel: string }[] = [];
  const logger = createLogger({ write: (linha, nivel) => linhas.push({ linha, nivel }) });
  return { logger, linhas, ultimo: () => JSON.parse(linhas.at(-1)!.linha) as Record<string, unknown> };
}

describe('mascaras', () => {
  it('e-mail: guarda a inicial e o dominio', () => {
    expect(maskEmail('maria@example.com')).toBe('m***@example.com');
    expect(maskEmail('sem-arroba')).toBe('***');
  });

  it('telefone: so os 4 ultimos digitos', () => {
    expect(maskPhone('+55 11 91234-5678')).toBe('***5678');
    expect(maskPhone('12')).toBe('***');
  });

  it('nome: inicial de cada parte', () => {
    expect(maskName('Maria da Silva')).toBe('M*** d*** S***');
    expect(maskName('   ')).toBe('***');
  });
});

describe('createLogger', () => {
  it('emite JSON com ts, level e msg, mais os campos de correlacao', () => {
    const { logger, ultimo } = capturar();
    logger.info('requisicao', { request_id: 'r-1', tenant_id: 't-1', event_id: 'e-1' });
    expect(ultimo()).toMatchObject({ level: 'info', msg: 'requisicao', request_id: 'r-1', tenant_id: 't-1', event_id: 'e-1' });
    expect(new Date(ultimo()['ts'] as string).toString()).not.toBe('Invalid Date');
  });

  it('warn e error vao para o fluxo de erro; info nao', () => {
    const { logger, linhas } = capturar();
    logger.info('a');
    logger.warn('b');
    logger.error('c');
    expect(linhas.map((l) => l.nivel)).toEqual(['info', 'warn', 'error']);
  });

  it('respeita o nivel minimo', () => {
    const linhas: string[] = [];
    const logger = createLogger({ level: 'warn', write: (l) => linhas.push(l) });
    logger.debug('x');
    logger.info('y');
    logger.warn('z');
    expect(linhas).toHaveLength(1);
  });

  it('child acrescenta campos fixos', () => {
    const { logger, ultimo } = capturar();
    logger.child({ job: 'expirar-reservas' }).info('inicio', { count: 3 });
    expect(ultimo()).toMatchObject({ job: 'expirar-reservas', count: 3 });
  });

  it('campo do chamador nao sobrescreve ts, level nem msg', () => {
    const { logger, ultimo } = capturar();
    logger.info('real', { msg: 'falso', level: 'debug', ts: 'ontem' });
    expect(ultimo()).toMatchObject({ msg: 'real', level: 'info' });
    expect(ultimo()['ts']).not.toBe('ontem');
  });

  it('nunca lanca por causa de um campo estranho (ciclo, Error, BigInt)', () => {
    const { logger, ultimo } = capturar();
    const ciclo: Record<string, unknown> = {};
    ciclo['eu'] = ciclo;
    expect(() => logger.info('x', { ciclo, erro: new Error('falhou'), grande: 10n })).not.toThrow();
    expect(ultimo()['erro']).toEqual({ name: 'Error', message: 'falhou' });
    expect(ultimo()['grande']).toBe('10');
  });
});

describe('dado pessoal e segredo nao vao para o log', () => {
  it('mascara e-mail, telefone e nome pelo NOME do campo', () => {
    const { logger, ultimo } = capturar();
    logger.info('pedido', {
      buyer_email: 'maria@example.com',
      phone: '+55 11 91234-5678',
      buyer_name: 'Maria Souza',
      order_id: 'o-1',
    });
    expect(ultimo()).toMatchObject({
      buyer_email: 'm***@example.com',
      phone: '***5678',
      buyer_name: 'M*** S***',
      order_id: 'o-1',
    });
    const texto = JSON.stringify(ultimo());
    expect(texto).not.toContain('maria@example.com');
    expect(texto).not.toContain('91234');
    expect(texto).not.toContain('Maria');
  });

  it('omite segredos: senha, token, cookie, autorizacao, assinatura, chave', () => {
    const { logger, ultimo } = capturar();
    logger.warn('x', {
      password: 'abc',
      access_token: 'tok',
      cookie: 'clubedarifa_session=zzz',
      authorization: 'Bearer zzz',
      'x-signature': 'ts=1,v1=abc',
      apiKey: 'k',
      ok: 'visivel',
    });
    const l = ultimo();
    for (const chave of ['password', 'access_token', 'cookie', 'authorization', 'x-signature', 'apiKey']) {
      expect(l[chave], chave).toBe('[redacted]');
    }
    expect(l['ok']).toBe('visivel');
  });

  it('vale em objetos aninhados e listas', () => {
    const { logger, ultimo } = capturar();
    logger.info('x', { pedido: { comprador: { email: 'a@b.com', telefone: '11 99999-0000' }, itens: [{ nome: 'Joao Pedro' }] } });
    const texto = JSON.stringify(ultimo());
    expect(texto).not.toContain('a@b.com');
    expect(texto).not.toContain('99999');
    expect(texto).not.toContain('Joao');
  });

  it('sanitize nao altera a entrada', () => {
    const entrada = { email: 'a@b.com' };
    sanitize(entrada);
    expect(entrada.email).toBe('a@b.com');
  });
});
