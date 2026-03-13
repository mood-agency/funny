import path from 'path';

import { defineConfig } from 'vitest/config';

const shared = path.resolve(__dirname, '../shared/src');

export default defineConfig({
  resolve: {
    alias: {
      '@funny/shared/errors': path.join(shared, 'errors.ts'),
      '@funny/shared/models': path.join(shared, 'models.ts'),
      '@funny/shared/thread-machine': path.join(shared, 'thread-machine.ts'),
      '@funny/shared/pipeline-engine': path.join(shared, 'pipeline-engine.ts'),
      '@funny/shared/prompts': path.join(shared, 'prompts/index.ts'),
      '@funny/shared': path.join(shared, 'types.ts'),
      // Zod v4 ESM re-exports break Vite SSR transform; use CJS build instead
      zod: path.resolve(__dirname, 'node_modules/zod/index.cjs'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: [
      'dist/**',
      // Tests that depend on bun:sqlite (via test-db.ts helper or direct DB imports)
      'src/__tests__/db/**',
      'src/__tests__/routes/projects.test.ts',
      'src/__tests__/routes/git.test.ts',
      'src/__tests__/routes/threads.test.ts',
      'src/__tests__/services/project-manager.test.ts',
      'src/__tests__/services/thread-manager.test.ts',
      'src/__tests__/services/worktree-manager.test.ts',
      'src/__tests__/services/agent-runner.test.ts',
      'src/__tests__/services/agent-runner-class.test.ts',
      'src/__tests__/services/automation-manager.test.ts',
      // Tests that depend on Bun.spawn / Bun runtime
      'src/__tests__/utils/process.test.ts',
      'src/__tests__/utils/git-v2.test.ts',
    ],
  },
});
