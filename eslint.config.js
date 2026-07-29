import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-undef': 'off',
    },
  },
  {
    // src/shared doit rester du TypeScript pur : ni Electron, ni Node, ni DOM.
    // C'est ce qui garantit qu'il tourne indifféremment en worker, main ou renderer,
    // et qu'il reste testable sans harnais (PLAN.md §3.1).
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'electron/*', 'node:*', 'fs', 'path', 'os', 'child_process'],
              message: 'src/shared doit rester agnostique de la plateforme (PLAN.md §3.1).',
            },
          ],
        },
      ],
    },
  },
);
