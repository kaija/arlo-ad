import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Lint fixtures proving the package boundary rules in eslint.config.mjs take effect.
// Each case lints inline source as if it lived at `file` and lists the boundary rules that must fire.

const BOUNDARY_RULES = new Set(['no-restricted-imports', 'no-restricted-globals', 'no-restricted-syntax']);

const eslint = new ESLint({ cwd: fileURLToPath(new URL('..', import.meta.url)) });

async function boundaryViolations(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: file });
  const fired = (result?.messages ?? []).flatMap((m) => (m.ruleId && BOUNDARY_RULES.has(m.ruleId) ? [m.ruleId] : []));
  return [...new Set(fired)].sort();
}

type Case = { name: string; file: string; code: string; expected: string[] };

const cases: Case[] = [
  // packages/core: pure logic only
  { name: 'core may import relative modules', file: 'packages/core/src/tier/index.ts', code: "export { x } from '../changeset/x';", expected: [] },
  { name: 'core may import zod', file: 'packages/core/src/a.ts', code: "export { z } from 'zod';", expected: [] },
  { name: 'core rejects node builtins', file: 'packages/core/src/a.ts', code: "export { readFile } from 'node:fs';", expected: ['no-restricted-imports'] },
  { name: 'core rejects bare builtins', file: 'packages/core/src/a.ts', code: "import fs from 'fs';\nexport { fs };", expected: ['no-restricted-imports'] },
  { name: 'core rejects db clients', file: 'packages/core/src/a.ts', code: "import pg from 'pg';\nexport { pg };", expected: ['no-restricted-imports'] },
  { name: 'core rejects other workspace packages', file: 'packages/core/src/a.ts', code: "export * from '@arlo/db';", expected: ['no-restricted-imports'] },
  { name: 'core rejects process', file: 'packages/core/src/a.ts', code: 'export const url = process.env.DATABASE_URL;', expected: ['no-restricted-globals'] },
  { name: 'core rejects fetch', file: 'packages/core/src/a.ts', code: "export const r = fetch('https://example.com');", expected: ['no-restricted-globals'] },

  // packages/agents: no platform adapter, no SDK, no applyOps
  { name: 'agents may import core and db', file: 'packages/agents/src/tools.ts', code: "export * from '@arlo/core';\nexport * from '@arlo/db';", expected: [] },
  { name: 'agents reject platform adapter', file: 'packages/agents/src/tools.ts', code: "export { GoogleAdsAdapter } from '@arlo/adapters/platform';", expected: ['no-restricted-imports'] },
  { name: 'agents reject adapters root', file: 'packages/agents/src/tools.ts', code: "export * from '@arlo/adapters';", expected: ['no-restricted-imports'] },
  { name: 'agents reject Google Ads SDK', file: 'packages/agents/src/tools.ts', code: "export { GoogleAdsApi } from 'google-ads-api';", expected: ['no-restricted-imports'] },
  { name: 'agents reject applyOps', file: 'packages/agents/src/tools.ts', code: 'export const run = (a: { applyOps(): void }) => a.applyOps();', expected: ['no-restricted-syntax'] },

  // applyOps: Executor only
  { name: 'executor may call applyOps', file: 'apps/worker/src/handlers/executor.ts', code: "export const run = (a: { applyOps(id: string): void }) => a.applyOps('1');", expected: [] },
  { name: 'executor tests may call applyOps', file: 'apps/worker/src/handlers/executor.int.test.ts', code: "export const run = (a: { applyOps(id: string): void }) => a.applyOps('1');", expected: [] },
  { name: 'adapters may implement applyOps', file: 'packages/adapters/src/platform/fake.ts', code: 'export class Fake { applyOps() { return []; } }', expected: [] },
  { name: 'other worker handlers reject applyOps', file: 'apps/worker/src/handlers/sync.ts', code: "export const run = (a: Record<string, () => void>) => a['applyOps']?.();", expected: ['no-restricted-syntax'] },
  { name: 'web rejects destructured applyOps', file: 'apps/web/app/actions.ts', code: 'export const run = ({ applyOps }: { applyOps: () => void }) => applyOps;', expected: ['no-restricted-syntax'] },

  // Google Ads SDK: adapters only
  { name: 'adapters may use Google Ads SDK', file: 'packages/adapters/src/platform/google-ads.ts', code: "export { GoogleAdsApi } from 'google-ads-api';", expected: [] },
  { name: 'worker rejects Google Ads SDK', file: 'apps/worker/src/handlers/sync.ts', code: "export { GoogleAdsApi } from 'google-ads-api';", expected: ['no-restricted-imports'] },
  { name: 'web rejects Google Ads SDK', file: 'apps/web/app/page.tsx', code: "export { enums } from 'google-ads-api/build/src/protos';", expected: ['no-restricted-imports'] },
];

describe('eslint package boundaries', () => {
  it.each(cases)('$name', async ({ file, code, expected }) => {
    expect(await boundaryViolations(file, code)).toEqual(expected);
  });
});
