import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['dev/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['app/core.js'],
      thresholds: {
        lines: 80,
        branches: 80,
      },
    },
  },
});
