import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    expect: { requireAssertions: true },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // CLI and watchdog composition are exercised by test/e2e.mjs.
      exclude: ['**/*.test.ts', 'src/index.ts', 'src/supervisor.ts'],
      reporter: ['text', 'text-summary'],
      thresholds: { perFile: true, lines: 85, functions: 85, statements: 85, branches: 85 },
    },
  },
})
