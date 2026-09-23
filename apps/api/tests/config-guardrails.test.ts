import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

/**
 * Travas da configuracao.
 *
 * Toda combinacao perigosa precisa DERRUBAR o processo na subida, e nao virar
 * um sistema que sobe e se comporta de um jeito que ninguem pediu. As tres
 * abaixo so aparecem quando a API sai da maquina de quem desenvolve — e e
 * exatamente por isso que elas precisam de teste: nao ha ocasiao de descobri-las
 * por acidente antes do deploy.
 *
 * Roda sem banco.
 */

const CHAVE_MFA = Buffer.alloc(32, 7).toString('base64');

function base(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://app_user:x@localhost:5432/qualquer',
    MFA_ENCRYPTION_KEY: CHAVE_MFA,
    APP_BASE_DOMAIN: 'plataforma.local',
    CORS_ORIGINS: 'https://painel.example',
    SESSION_COOKIE_SECURE: 'true',
    ...overrides,
  };
}

describe('configuracao · ambientes aceitos', () => {
  it('staging e um ambiente de primeira classe', () => {
    // Sem isto, `NODE_ENV=staging` derrubaria a API na subida por "enum
    // invalido" — uma falha de configuracao disfarcada de falha de codigo.
    const config = loadConfig(base({ NODE_ENV: 'staging' }));
    expect(config.NODE_ENV).toBe('staging');
  });

  it('um ambiente desconhecido e recusado', () => {
    expect(() => loadConfig(base({ NODE_ENV: 'prod' }))).toThrow(/NODE_ENV/);
  });
});

describe('configuracao · cookie de sessao', () => {
  it('SameSite=None SEM Secure e recusado', () => {
    // O navegador DESCARTA esse cookie. Aceitar a combinacao produziria uma API
    // que responde 200 no login e 401 em tudo depois, sem dizer por que.
    expect(() =>
      loadConfig(base({ SESSION_COOKIE_SAMESITE: 'none', SESSION_COOKIE_SECURE: 'false' })),
    ).toThrow(/SESSION_COOKIE_SAMESITE/);
  });

  it('SameSite=None COM Secure e aceito: e a topologia cross-site', () => {
    const config = loadConfig(
      base({ SESSION_COOKIE_SAMESITE: 'none', SESSION_COOKIE_SECURE: 'true' }),
    );
    expect(config.SESSION_COOKIE_SAMESITE).toBe('none');
    expect(config.SESSION_COOKIE_SECURE).toBe(true);
  });

  it('o padrao continua sendo lax', () => {
    // Quem nao precisa de cross-site nao deve pagar por ele.
    expect(loadConfig(base()).SESSION_COOKIE_SAMESITE).toBe('lax');
  });

  it('staging e producao exigem cookie Secure', () => {
    for (const ambiente of ['staging', 'production']) {
      expect(() =>
        loadConfig(base({ NODE_ENV: ambiente, SESSION_COOKIE_SECURE: 'false' })),
      ).toThrow(/SESSION_COOKIE_SECURE/);
    }
  });

  it('desenvolvimento continua permitindo cookie sem Secure', () => {
    // Em localhost nao ha HTTPS, e exigir Secure impediria o cookie de ser
    // salvo — a trava protegeria o ambiente errado.
    expect(loadConfig(base({ NODE_ENV: 'development', SESSION_COOKIE_SECURE: 'false' }))).toBeTruthy();
  });
});

describe('configuracao · allowlist de origem', () => {
  it('staging e producao recusam allowlist vazia', () => {
    for (const ambiente of ['staging', 'production']) {
      expect(() => loadConfig(base({ NODE_ENV: ambiente, CORS_ORIGINS: '' }))).toThrow(
        /CORS_ORIGINS/,
      );
    }
  });

  it('a lista e separada por virgula e ignora espacos', () => {
    const config = loadConfig(
      base({ CORS_ORIGINS: ' https://a.example , https://b.example ,, ' }),
    );
    expect(config.corsOrigins).toEqual(['https://a.example', 'https://b.example']);
  });
});

describe('configuracao · seletor de comunidade por cabecalho', () => {
  it('producao RECUSA o cabecalho', () => {
    // Ele deixaria o cliente escolher a comunidade, ignorando o dominio.
    expect(() =>
      loadConfig(base({ NODE_ENV: 'production', TENANT_HEADER_ENABLED: 'true' })),
    ).toThrow(/TENANT_HEADER_ENABLED/);
  });

  it('staging PERMITE o cabecalho, e isso e deliberado', () => {
    // Com frontends e API em sites diferentes, a API nunca ve o hostname da
    // vitrine no `Host` — a resolucao por dominio nao tem o que ler. O
    // cabecalho e a unica forma de escolher a comunidade nessa topologia, e o
    // que ele expoe em staging e a marca publica de comunidades descartaveis.
    // As rotas autenticadas continuam conferindo o vinculo no banco.
    const config = loadConfig(base({ NODE_ENV: 'staging', TENANT_HEADER_ENABLED: 'true' }));
    expect(config.TENANT_HEADER_ENABLED).toBe(true);
  });
});

describe('configuracao · segredos obrigatorios', () => {
  it('sem DATABASE_URL o processo nao sobe', () => {
    const env = base();
    delete env['DATABASE_URL'];
    expect(() => loadConfig(env)).toThrow(/DATABASE_URL/);
  });

  it('sem MFA_ENCRYPTION_KEY o processo nao sobe', () => {
    const env = base();
    delete env['MFA_ENCRYPTION_KEY'];
    expect(() => loadConfig(env)).toThrow(/MFA_ENCRYPTION_KEY/);
  });

  it('MFA_ENCRYPTION_KEY com tamanho errado e recusada', () => {
    // 16 bytes passariam despercebidos ate a primeira cifragem falhar.
    expect(() =>
      loadConfig(base({ MFA_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') })),
    ).toThrow(/MFA_ENCRYPTION_KEY/);
  });

  it('nenhum segredo tem valor padrao embutido', () => {
    // Um padrao aqui faria a API subir "funcionando" com credencial conhecida.
    const env = base();
    delete env['DATABASE_URL'];
    delete env['MFA_ENCRYPTION_KEY'];
    expect(() => loadConfig(env)).toThrow();
  });
});
