import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// End-to-end tests start real processes; run with: npm run test:e2e
export default defineConfig({
  resolve: base.resolve,
  test: { include: ['e2e/**/*.e2e.test.ts'], environment: 'node', testTimeout: 60_000, hookTimeout: 60_000, fileParallelism: false },
});
