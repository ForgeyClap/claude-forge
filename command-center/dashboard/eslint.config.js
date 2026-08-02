import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    ignores: [
      // The real Forge install. Off limits — never linted, never modified.
      '.claude/**',
      // WP7a import: this project's own governance dir was neutralized/renamed to
      // '.claude-laptop-orig' on import (see command-center's T7-integration-plan.md) so it is
      // never mistaken for the Command Center's own active .claude/. Same off-limits rule as
      // above, just following the rename so lint doesn't reach into someone else's Forge install.
      '.claude-laptop-orig/**',
      'dist/**',
      'node_modules/**',
      'artifacts/**',
      'playwright-report/**',
      'test-results/**',
      // Stryker's mutant sandboxes — throwaway copies with @ts-nocheck injected.
      '.stryker-tmp/**',
      'reports/**',
      'brand/forge-tokens.css',
      // Zero-dependency CommonJS tooling, deliberately outside the app's module system.
      '**/*.cjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // The prototype must never reach the network. These are hard errors, not style.
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'The prototype is offline-only. No network calls are permitted.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='WebSocket']",
          message: 'The prototype is offline-only. WebSockets are not permitted.',
        },
        {
          selector: "NewExpression[callee.name='EventSource']",
          message: 'The prototype is offline-only. SSE is not permitted.',
        },
        {
          selector: "NewExpression[callee.name='XMLHttpRequest']",
          message: 'The prototype is offline-only. XHR is not permitted.',
        },
      ],
    },
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
