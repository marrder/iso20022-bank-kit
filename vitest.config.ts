import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources, so tests never depend on a prior build.
const packages = readdirSync(new URL('./packages', import.meta.url));
const alias = Object.fromEntries(
  packages.map((p) => [`@iso20022-bank-kit/${p}`, fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url))]),
);

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    coverage: { provider: 'v8', include: ['packages/*/src/**'], reporter: ['text', 'lcov'] },
  },
});
