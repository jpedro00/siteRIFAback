import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Lint do backend.
 *
 * `no-undef` fica LIGADO de proposito, com os globais declarados por ambiente.
 * E a rede de protecao contra o erro E1 da migracao NewStore -> XNAMAI, em que
 * `formattedNumbers` foi usada no lugar de `cleanNumbers` e so estourou em
 * producao como ReferenceError. O TypeScript estrito ja pega esse caso; manter
 * a regra cobre tambem os arquivos de configuracao em JavaScript.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      'no-undef': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      // E2: import com alias em regra de preco/estado, chamado pelo nome original.
      'no-duplicate-imports': 'error',
    },
  },

  // Backend, pacotes compartilhados, testes e configuracao: ambiente Node.
  {
    files: [
      'apps/api/**/*.ts',
      'apps/worker/**/*.ts',
      'packages/**/*.ts',
      // Scripts de apoio ao CI, em JavaScript puro.
      'scripts/**/*.{js,mjs}',
      '**/*.config.ts',
      '**/*.config.js',
      '**/tests/**/*.ts',
    ],
    languageOptions: {
      // `NodeJS` e o namespace de tipos de @types/node; existe so em tempo de
      // compilacao, mas o lint precisa conhece-lo para nao acusar no-undef.
      globals: { ...globals.node, NodeJS: 'readonly' },
    },
  },

  // `packages/shared` roda nos dois lados: o cliente HTTP usa fetch, URL e
  // AbortSignal, que existem no navegador e no Node 18+.
  {
    files: ['packages/shared/src/contracts/client.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },


  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/tests/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
