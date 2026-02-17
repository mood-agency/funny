import { describe, it, expect } from 'bun:test';
import { buildPipelinePrompt } from '../core/prompt-builder.js';
import type { PipelineRequest, Tier, AgentName } from '../core/types.js';

const DEFAULT_TIER_AGENTS: Record<Tier, AgentName[]> = {
  small: ['tests', 'style'],
  medium: ['tests', 'security', 'architecture', 'style', 'types'],
  large: ['tests', 'security', 'architecture', 'performance', 'style', 'types', 'docs', 'integration'],
};

function makeRequest(overrides: Partial<PipelineRequest> = {}): PipelineRequest {
  return {
    request_id: 'req-001',
    branch: 'feature/login',
    worktree_path: '/tmp/worktrees/login',
    ...overrides,
  };
}

describe('buildPipelinePrompt', () => {
  // ── Produces non-empty prompt string ────────────────────────

  it('produces a non-empty prompt string', () => {
    const prompt = buildPipelinePrompt(
      makeRequest(),
      'small',
      DEFAULT_TIER_AGENTS,
      2,
      'pipeline/',
    );
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  // ── Includes branch name ────────────────────────────────────

  it('includes the branch name in the prompt', () => {
    const prompt = buildPipelinePrompt(
      makeRequest({ branch: 'feature/auth-system' }),
      'small',
      DEFAULT_TIER_AGENTS,
      2,
      'pipeline/',
    );
    expect(prompt).toContain('feature/auth-system');
  });

  it('includes both the feature branch and the pipeline branch', () => {
    const prompt = buildPipelinePrompt(
      makeRequest({ branch: 'feature/checkout' }),
      'medium',
      DEFAULT_TIER_AGENTS,
      2,
      'pipeline/',
    );
    expect(prompt).toContain('feature/checkout');
    expect(prompt).toContain('pipeline/feature/checkout');
  });

  // ── Includes working directory ──────────────────────────────

  it('includes the working directory in the prompt', () => {
    const prompt = buildPipelinePrompt(
      makeRequest({ worktree_path: '/home/user/project/.worktrees/login' }),
      'small',
      DEFAULT_TIER_AGENTS,
      2,
      'pipeline/',
    );
    expect(prompt).toContain('/home/user/project/.worktrees/login');
  });

  // ── Includes agent instructions ─────────────────────────────

  it('includes agent instructions for the tier', () => {
    const prompt = buildPipelinePrompt(
      makeRequest(),
      'small',
      DEFAULT_TIER_AGENTS,
      2,
      'pipeline/',
    );
    // Small tier has tests and style agents
    expect(prompt).toContain('**tests**');
    expect(prompt).toContain('**style**');
  });

  it('includes all large tier agents when tier is large', () => {
    const prompt = buildPipelinePrompt(
      makeRequest(),
      'large',
      DEFAULT_TIER_AGENTS,
      2,
      'pipeline/',
    );
    for (const agent of DEFAULT_TIER_AGENTS.large) {
      expect(prompt).toContain(`**${agent}**`);
    }
  });

  it('uses config.agents override if provided', () => {
    const request = makeRequest({
      config: { agents: ['security', 'performance'] },
    });
    const prompt = buildPipelinePrompt(
      request,
      'small', // tier is small but config overrides agents
      DEFAULT_TIER_AGENTS,
      2,
      'pipeline/',
    );
    expect(prompt).toContain('**security**');
    expect(prompt).toContain('**performance**');
    // Should NOT contain default small-tier agents that aren't in the override
    expect(prompt).not.toContain('**style**');
  });

  // ── Includes base branch ────────────────────────────────────

  it('defaults to main as base branch when not specified', () => {
    const prompt = buildPipelinePrompt(
      makeRequest(),
      'small',
      DEFAULT_TIER_AGENTS,
      2,
      'pipeline/',
    );
    expect(prompt).toContain('main');
  });

  it('includes custom base branch when specified', () => {
    const prompt = buildPipelinePrompt(
      makeRequest({ base_branch: 'develop' }),
      'small',
      DEFAULT_TIER_AGENTS,
      2,
      'pipeline/',
    );
    expect(prompt).toContain('develop');
  });

  // ── Includes tier info ──────────────────────────────────────

  it('includes tier name in the prompt', () => {
    const prompt = buildPipelinePrompt(
      makeRequest(),
      'medium',
      DEFAULT_TIER_AGENTS,
      2,
      'pipeline/',
    );
    expect(prompt).toContain('medium');
  });

  // ── Includes max corrections ────────────────────────────────

  it('includes max corrections count', () => {
    const prompt = buildPipelinePrompt(
      makeRequest(),
      'small',
      DEFAULT_TIER_AGENTS,
      5,
      'pipeline/',
    );
    expect(prompt).toContain('5');
  });

  // ── Browser section when container info provided ────────────

  it('includes browser section when hasBrowserTools is true', () => {
    const prompt = buildPipelinePrompt(
      makeRequest(),
      'small',
      DEFAULT_TIER_AGENTS,
      2,
      'pipeline/',
      true,
    );
    expect(prompt).toContain('Browser Tools Available');
    expect(prompt).toContain('cdp_navigate');
    expect(prompt).toContain('cdp_screenshot');
    expect(prompt).toContain('cdp_get_dom');
  });

  it('browser section mentions E2E testing and visual verification', () => {
    const prompt = buildPipelinePrompt(
      makeRequest(),
      'small',
      DEFAULT_TIER_AGENTS,
      2,
      'pipeline/',
      true,
    );
    expect(prompt).toContain('E2E testing');
    expect(prompt).toContain('visual verification');
  });

  // ── No browser section without container info ───────────────

  it('does not include browser section when hasBrowserTools is false', () => {
    const prompt = buildPipelinePrompt(
      makeRequest(),
      'small',
      DEFAULT_TIER_AGENTS,
      2,
      'pipeline/',
      false,
    );
    expect(prompt).not.toContain('Browser Tools Available');
    expect(prompt).not.toContain('cdp_navigate');
  });

  it('does not include browser section when hasBrowserTools is undefined', () => {
    const prompt = buildPipelinePrompt(
      makeRequest(),
      'small',
      DEFAULT_TIER_AGENTS,
      2,
      'pipeline/',
    );
    expect(prompt).not.toContain('Browser Tools Available');
  });

  // ── Pipeline prefix in checkout command ─────────────────────

  it('uses the provided pipeline prefix in checkout command', () => {
    const prompt = buildPipelinePrompt(
      makeRequest({ branch: 'feature/x' }),
      'small',
      DEFAULT_TIER_AGENTS,
      2,
      'ci/',
    );
    expect(prompt).toContain('ci/feature/x');
  });

  // ── Agent count matches tier ────────────────────────────────

  it('includes correct agent count in prompt', () => {
    const prompt = buildPipelinePrompt(
      makeRequest(),
      'large',
      DEFAULT_TIER_AGENTS,
      2,
      'pipeline/',
    );
    // large tier has 8 agents
    expect(prompt).toContain(`${DEFAULT_TIER_AGENTS.large.length} agents`);
  });
});
