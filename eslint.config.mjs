import js from '@eslint/js';
import css from '@eslint/css';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['**/node_modules/**', 'dist/**', '.verify-tmp/**', 'verification/**', 'extension/vendor/**']),
  {
    files: ['*.mjs', 'extension/**/*.js', 'scripts/**/*.mjs', 'tests/**/*.mjs', 'bench/**/*.mjs', 'experiments/**/*.mjs', 'mcp/**/*.mjs'],
    extends: [js.configs.recommended],
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
  {
    files: ['extension/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.worker, ...globals.webextensions } },
  },
  {
    files: ['extension/lib/brightspace.js'],
    // Firefox exposes these page-realm helpers to content scripts.
    languageOptions: { globals: { content: 'readonly', cloneInto: 'readonly' } },
  },
  {
    // Browser checks and benchmark runners also contain functions evaluated in the page.
    files: ['*.mjs', 'scripts/**/*.mjs', 'tests/**/*.mjs', 'bench/**/*.mjs', 'experiments/**/*.mjs', 'mcp/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser, ...globals.webextensions } },
  },
  {
    files: ['extension/**/*.css'],
    plugins: { css },
    language: 'css/css',
    extends: ['css/recommended'],
    rules: {
      // Browser support follows the manifest minimums and browser tests, not global Baseline.
      'css/use-baseline': 'off',
      'css/no-important': 'off',
      // Some custom properties, including the thinking slider fill, are set by JavaScript.
      'css/no-invalid-properties': ['error', { allowUnknownVariables: true }],
    },
  },
]);
