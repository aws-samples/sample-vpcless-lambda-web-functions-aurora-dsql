import { defineConfig } from 'vitest/config';

// Unit tests only. None of them connects to AWS or to a database.
export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts', 'cdk/test/**/*.test.ts', 'web/test/**/*.test.ts'],
    environment: 'node',
    // Synthesizing the CDK stack takes a few seconds.
    testTimeout: 60_000,
  },
});
