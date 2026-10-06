import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// ---------------------------------------------------------------------------
// Package boundary rules (ADR-0002, ADR-0006). Covered by tests/eslint-boundaries.test.ts.
//
// ESLint does not merge options of the same rule across config objects, so each
// scope composes the pattern lists it needs instead of relying on inheritance.
// ---------------------------------------------------------------------------

// The raw Google Ads SDK can mutate accounts; only the adapter package may touch it.
const platformSdkPatterns = [
  {
    group: ['google-ads-api', 'google-ads-api/**'],
    message: 'Google Ads SDK 只能在 packages/adapters 使用；請透過 PlatformAdapter（ADR-0004）。',
  },
];

// packages/core is pure logic: allowlist relative imports and zod, reject everything else.
const coreImportPatterns = [
  {
    regex: '^(?!\\.{1,2}(?:/|$)|zod(?:/|$))',
    message: 'packages/core 必須是無 I/O 的純邏輯，只能 import 相對路徑與 zod（ADR-0006）。',
  },
];

// Agents only get read tools and propose_* tools; they must not reach the platform adapters.
const agentImportPatterns = [
  ...platformSdkPatterns,
  {
    group: ['@arlo/adapters', '@arlo/adapters/platform', '@arlo/adapters/platform/**'],
    message: 'Agent 不得取得 PlatformAdapter；寫入請透過 propose_* tool 建立 ChangeSet（ADR-0006）。',
  },
];

const applyOpsMessage = 'applyOps 只能由 apps/worker/src/handlers/executor.ts 呼叫（ADR-0006）。';

// Files allowed to reference PlatformAdapter.applyOps: adapter implementations and the Executor.
const applyOpsAllowed = [
  'packages/adapters/**',
  'apps/worker/src/handlers/executor.ts',
  'apps/worker/src/handlers/executor.*test.ts',
];

export default defineConfig(
  globalIgnores(['**/.next/**', '**/dist/**', '**/coverage/**', '**/next-env.d.ts', '.claude/**']),

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    files: ['**/*.{js,mjs,cjs}', '*.config.{ts,mts}', 'scripts/**', 'tests/**'],
    languageOptions: { globals: globals.node },
  },

  {
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [nextPlugin.configs['core-web-vitals'], reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
    settings: { next: { rootDir: 'apps/web' } },
  },

  // --- boundaries -----------------------------------------------------------

  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['packages/adapters/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: platformSdkPatterns }],
    },
  },

  {
    files: ['**/*.{ts,tsx}'],
    ignores: applyOpsAllowed,
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "Identifier[name='applyOps']", message: applyOpsMessage },
        { selector: "Literal[value='applyOps']", message: applyOpsMessage },
      ],
    },
  },

  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: coreImportPatterns }],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'packages/core 不得讀取 process；設定請由呼叫端傳入。' },
        { name: 'fetch', message: 'packages/core 不得做網路 I/O。' },
        { name: 'WebSocket', message: 'packages/core 不得做網路 I/O。' },
      ],
    },
  },

  {
    files: ['packages/agents/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: agentImportPatterns }],
    },
  },
);
