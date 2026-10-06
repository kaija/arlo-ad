#!/usr/bin/env node
// Regenerates docs/adr/README.md from the ADR files and the kiro spec annotations,
// and reports acceptance criteria that no task references.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const SPEC = '.kiro/specs/arlo-ads-bot';
const ADR_DIR = 'docs/adr';
const tasks = readFileSync(`${SPEC}/tasks.md`, 'utf8').split('\n');
const reqs = readFileSync(`${SPEC}/requirements.md`, 'utf8').split('\n');

const push = (map, key, val) => (map[key] ??= []).push(val);
const adrIds = (s) => [...s.matchAll(/ADR-(\d{4})/g)].map((m) => m[1]);

const adrTasks = {};
const taskReqs = new Set();
let task;
for (const l of tasks) {
  task = l.match(/^\s*- \[[ x]\] (\d+\.\d+) /)?.[1] ?? task;
  const adr = l.match(/_ADR: (.+)_/);
  if (adr && task) adrIds(adr[1]).forEach((a) => push(adrTasks, a, task));
  const req = l.match(/_Requirements: (.+)_/);
  if (req) req[1].split(',').forEach((r) => taskReqs.add(r.trim()));
}

const adrReqs = {};
const criteria = [];
let reqNo;
for (const l of reqs) {
  reqNo = l.match(/^### Requirement (\d+)/)?.[1] ?? reqNo;
  const adr = l.match(/^ADR: (.+)/);
  if (adr && reqNo) adrIds(adr[1]).forEach((a) => push(adrReqs, a, `R${reqNo}`));
  const c = l.match(/^(\d+)\. /);
  if (c && reqNo) criteria.push(`${reqNo}.${c[1]}`);
}

const rows = readdirSync(ADR_DIR)
  .filter((f) => /^\d{4}-.*\.md$/.test(f))
  .sort()
  .map((f) => {
    const id = f.slice(0, 4);
    const title = readFileSync(`${ADR_DIR}/${f}`, 'utf8').split('\n')[0].split('：').slice(1).join('：');
    const t = adrTasks[id]?.join(', ') || (id === '0027' ? '全部（里程碑分組）' : '—');
    return `| [ADR-${id}](${f}) | ${title} | ${adrReqs[id]?.join(', ') || '—'} | ${t} |`;
  });

writeFileSync(
  `${ADR_DIR}/README.md`,
  `# Architecture Decision Records

設計決策紀錄。Spec 位於 [\`.kiro/specs/arlo-ads-bot/\`](../../${SPEC}/)。
下表由 \`node scripts/gen-adr-index.mjs\` 依 requirements.md 的 \`ADR:\` 與 tasks.md 的 \`_ADR:_\` 標註產生，請勿手動編輯表格。

| ADR | 標題 | Requirements | Tasks |
|---|---|---|---|
${rows.join('\n')}

## 慣例

- 新增 ADR：複製最近一份，編號遞增，Status 從 \`Proposed\` 開始；Accepted 後在 tasks.md 標註 \`_ADR: ADR-XXXX_\`，再重跑本腳本。
- 被取代：原 ADR 標記 \`Superseded by ADR-XXXX\`，不刪除。
`,
);

const uncovered = criteria.filter((c) => !taskReqs.has(c));
const orphanAdrs = rows.filter((r) => r.endsWith('| — |'));
console.log(`ADRs: ${rows.length}, criteria: ${criteria.length}`);
console.log(`Uncovered criteria: ${uncovered.join(', ') || 'none'}`);
console.log(`ADRs without tasks: ${orphanAdrs.length || 'none'}`);
if (uncovered.length || orphanAdrs.length) process.exitCode = 1;
