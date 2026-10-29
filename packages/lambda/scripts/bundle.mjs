// Bundles the Lambda into packages/lambda/build/index.mjs (one file; AWS SDK v3 comes from the runtime).

import { rmSync } from 'node:fs';
import { build } from 'esbuild';

const outdir = new URL('../build/', import.meta.url).pathname;
rmSync(outdir, { recursive: true, force: true });
await build({
  entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
  outfile: `${outdir}index.mjs`,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: true,
  sourcemap: 'linked',
  external: ['@aws-sdk/*'],
  // Some dependencies are CommonJS and call require() at runtime.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  conditions: ['source'],
  alias: Object.fromEntries(
    ['iso20022', 'swift-mt', 'core', 'simulator', 'connector-bac', 'graphql', 'mcp'].map((p) => [
      `@iso20022-bank-kit/${p}`,
      new URL(`../../${p}/src/index.ts`, import.meta.url).pathname,
    ]),
  ),
});
console.log(`Bundled to ${outdir}index.mjs`);
