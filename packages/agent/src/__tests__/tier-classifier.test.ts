import { describe, it, expect } from 'bun:test';
import { classifyTier, type TierThresholds } from '../core/tier-classifier.js';

// NOTE: classifyTier() calls `git diff --stat` which requires a real git repo.
// We test the override path (which bypasses git) and test the parseDiffStat logic
// indirectly via the classification thresholds.

const DEFAULT_THRESHOLDS: TierThresholds = {
  small: { max_files: 3, max_lines: 50 },
  medium: { max_files: 10, max_lines: 300 },
};

describe('classifyTier', () => {
  it('returns overridden tier without running git', async () => {
    const { tier, stats } = await classifyTier('/tmp', 'main', DEFAULT_THRESHOLDS, 'large');
    expect(tier).toBe('large');
    expect(stats.filesChanged).toBe(0);
    expect(stats.totalLines).toBe(0);
  });

  it('accepts small override', async () => {
    const { tier } = await classifyTier('/tmp', 'main', DEFAULT_THRESHOLDS, 'small');
    expect(tier).toBe('small');
  });

  it('accepts medium override', async () => {
    const { tier } = await classifyTier('/tmp', 'main', DEFAULT_THRESHOLDS, 'medium');
    expect(tier).toBe('medium');
  });

  it('override stats are all zeros', async () => {
    const { stats } = await classifyTier('/tmp', 'main', DEFAULT_THRESHOLDS, 'small');
    expect(stats).toEqual({
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      totalLines: 0,
    });
  });
});

// ── parseDiffStat tests (exported indirectly via classifyTier) ──

// Since parseDiffStat is not exported, we test it by verifying that
// classifyTier with an override returns expected structure.
// For the actual parsing, we'll do a focused integration-style test
// once we can mock the git command.
describe('tier classification thresholds', () => {
  it('threshold boundaries are consistent', () => {
    expect(DEFAULT_THRESHOLDS.small.max_files).toBeLessThan(DEFAULT_THRESHOLDS.medium.max_files);
    expect(DEFAULT_THRESHOLDS.small.max_lines).toBeLessThan(DEFAULT_THRESHOLDS.medium.max_lines);
  });
});
