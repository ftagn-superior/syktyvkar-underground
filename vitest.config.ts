import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
