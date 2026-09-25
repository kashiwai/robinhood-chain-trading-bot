// ESLint flat config. Scope is intentionally narrow (src/tests/scripts) —
// dist/ and node_modules/ are never linted.
import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'
import security from 'eslint-plugin-security'
import prettier from 'eslint-config-prettier'

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'dashboard/**', 'docs/**'],
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: false,
        sourceType: 'module',
        ecmaVersion: 2022,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      security,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...security.configs.recommended.rules,
      // Financial code: never allow a silently-swallowed error or an any-typed
      // amount to slip past review.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'off', // requires type-aware parsing; see typecheck instead
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'security/detect-object-injection': 'off', // too many false positives on typed record access
      'security/detect-non-literal-fs-filename': 'off', // dbPath/killFile are intentionally config-driven
    },
  },
  {
    // CLI entrypoints and operator-facing scripts legitimately print to stdout.
    files: ['src/main.ts', 'scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  prettier,
]
