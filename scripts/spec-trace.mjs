// Traceability check (SPEC clause 12.3): every requirement with a MUST-level keyword must be
// referenced by at least one conformance case, Gherkin scenario, or test.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const spec = readFileSync('spec/SPEC.md', 'utf8');
const requirements = [...spec.matchAll(/^\*\*(IBK-[A-Z]+-\d{3})\*\* \(([CHS, ]+)\): ([\s\S]*?)(?=\n\n)/gm)].map((m) => ({
  id: m[1],
  mandatory: /\b(MUST|SHALL|REQUIRED)\b/.test(m[3]),
}));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|feature)$/.test(name)) out.push(p);
  }
  return out;
}

const sources = [
  ...walk('packages/conformance/src'),
  ...walk('features'),
  ...readdirSync('packages').flatMap((p) => walk(join('packages', p)).filter((f) => f.includes('/test/'))),
];
const text = sources.map((f) => readFileSync(f, 'utf8')).join('\n');

const rows = requirements.map((r) => ({ ...r, refs: text.split(r.id).length - 1 }));
const missing = rows.filter((r) => r.mandatory && r.refs === 0);

console.log('Requirement      Level   References');
for (const r of rows) console.log(`${r.id.padEnd(16)} ${(r.mandatory ? 'MUST' : 'SHOULD').padEnd(7)} ${r.refs}`);
if (missing.length) {
  console.error(`\nUntraced MUST requirements: ${missing.map((r) => r.id).join(', ')}`);
  process.exit(1);
}
console.log(`\nAll ${rows.filter((r) => r.mandatory).length} MUST requirements are traced.`);
