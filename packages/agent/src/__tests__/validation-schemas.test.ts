import { describe, it, expect } from 'bun:test';
import { PipelineRunSchema, DirectorRunSchema } from '../validation/schemas.js';

describe('PipelineRunSchema', () => {
  // ── Requires branch and worktree_path ───────────────────────

  it('accepts valid input with branch and worktree_path', () => {
    const result = PipelineRunSchema.safeParse({
      branch: 'feature/login',
      worktree_path: '/tmp/worktrees/login',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing branch', () => {
    const result = PipelineRunSchema.safeParse({
      worktree_path: '/tmp/worktrees/login',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty branch string', () => {
    const result = PipelineRunSchema.safeParse({
      branch: '',
      worktree_path: '/tmp/worktrees/login',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing worktree_path', () => {
    const result = PipelineRunSchema.safeParse({
      branch: 'feature/login',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty worktree_path string', () => {
    const result = PipelineRunSchema.safeParse({
      branch: 'feature/login',
      worktree_path: '',
    });
    expect(result.success).toBe(false);
  });

  // ── Rejects branch starting with pipeline/ ──────────────────

  it('rejects branch starting with "pipeline/"', () => {
    const result = PipelineRunSchema.safeParse({
      branch: 'pipeline/feature-test',
      worktree_path: '/tmp/worktrees/test',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('pipeline/'))).toBe(true);
    }
  });

  it('accepts branch that contains but does not start with "pipeline/"', () => {
    const result = PipelineRunSchema.safeParse({
      branch: 'feature/pipeline/test',
      worktree_path: '/tmp/worktrees/test',
    });
    expect(result.success).toBe(true);
  });

  // ── Accepts optional config overrides ───────────────────────

  it('accepts config with tier override', () => {
    const result = PipelineRunSchema.safeParse({
      branch: 'feature/login',
      worktree_path: '/tmp/worktrees/login',
      config: { tier: 'large' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts config with agents override', () => {
    const result = PipelineRunSchema.safeParse({
      branch: 'feature/login',
      worktree_path: '/tmp/worktrees/login',
      config: { agents: ['tests', 'security'] },
    });
    expect(result.success).toBe(true);
  });

  it('accepts config with model override', () => {
    const result = PipelineRunSchema.safeParse({
      branch: 'feature/login',
      worktree_path: '/tmp/worktrees/login',
      config: { model: 'opus' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts config with maxTurns override', () => {
    const result = PipelineRunSchema.safeParse({
      branch: 'feature/login',
      worktree_path: '/tmp/worktrees/login',
      config: { maxTurns: 100 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects config with invalid tier', () => {
    const result = PipelineRunSchema.safeParse({
      branch: 'feature/login',
      worktree_path: '/tmp/worktrees/login',
      config: { tier: 'mega' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects config with invalid agent name', () => {
    const result = PipelineRunSchema.safeParse({
      branch: 'feature/login',
      worktree_path: '/tmp/worktrees/login',
      config: { agents: ['nonexistent'] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects config with maxTurns above 500', () => {
    const result = PipelineRunSchema.safeParse({
      branch: 'feature/login',
      worktree_path: '/tmp/worktrees/login',
      config: { maxTurns: 501 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects config with maxTurns below 1', () => {
    const result = PipelineRunSchema.safeParse({
      branch: 'feature/login',
      worktree_path: '/tmp/worktrees/login',
      config: { maxTurns: 0 },
    });
    expect(result.success).toBe(false);
  });

  // ── Accepts optional base_branch ────────────────────────────

  it('accepts optional base_branch', () => {
    const result = PipelineRunSchema.safeParse({
      branch: 'feature/login',
      worktree_path: '/tmp/worktrees/login',
      base_branch: 'develop',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.base_branch).toBe('develop');
    }
  });

  // ── Accepts optional metadata ───────────────────────────────

  it('accepts optional metadata record', () => {
    const result = PipelineRunSchema.safeParse({
      branch: 'feature/login',
      worktree_path: '/tmp/worktrees/login',
      metadata: { ticket: 'PROJ-123', priority: 1 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metadata).toEqual({ ticket: 'PROJ-123', priority: 1 });
    }
  });

  // ── Config is entirely optional ─────────────────────────────

  it('accepts undefined config', () => {
    const result = PipelineRunSchema.safeParse({
      branch: 'feature/login',
      worktree_path: '/tmp/worktrees/login',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.config).toBeUndefined();
    }
  });
});

describe('DirectorRunSchema', () => {
  // ── Accepts optional project_path ───────────────────────────

  it('accepts empty object', () => {
    const result = DirectorRunSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts undefined (entire schema is optional)', () => {
    const result = DirectorRunSchema.safeParse(undefined);
    expect(result.success).toBe(true);
  });

  it('accepts object with project_path', () => {
    const result = DirectorRunSchema.safeParse({
      project_path: '/home/user/project',
    });
    expect(result.success).toBe(true);
    if (result.success && result.data) {
      expect(result.data.project_path).toBe('/home/user/project');
    }
  });

  it('accepts object without project_path', () => {
    const result = DirectorRunSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success && result.data) {
      expect(result.data.project_path).toBeUndefined();
    }
  });

  it('rejects non-string project_path', () => {
    const result = DirectorRunSchema.safeParse({
      project_path: 123,
    });
    expect(result.success).toBe(false);
  });
});
