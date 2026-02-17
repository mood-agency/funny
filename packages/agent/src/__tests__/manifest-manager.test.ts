import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ManifestManager } from '../core/manifest-manager.js';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';
import type { ManifestReadyEntry } from '../core/manifest-types.js';

const TEST_DIR = join(import.meta.dir, '..', '..', '.test-tmp-manifest');

function makeReadyEntry(overrides: Partial<ManifestReadyEntry> = {}): ManifestReadyEntry {
  return {
    branch: 'feature/login',
    pipeline_branch: 'pipeline/feature/login',
    worktree_path: '/tmp/worktrees/login',
    request_id: 'req-001',
    tier: 'small',
    pipeline_result: { tests: { status: 'pass', details: 'All tests pass' } },
    corrections_applied: [],
    ready_at: new Date().toISOString(),
    priority: 10,
    depends_on: [],
    base_main_sha: 'abc123',
    ...overrides,
  };
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

describe('ManifestManager', () => {
  // ── addToReady() adds branch entry ──────────────────────────

  it('addToReady() adds a branch entry', async () => {
    const manager = new ManifestManager(TEST_DIR);
    const entry = makeReadyEntry();

    await manager.addToReady(entry);

    const ready = await manager.getReadyEntries();
    expect(ready.length).toBe(1);
    expect(ready[0].branch).toBe('feature/login');
    expect(ready[0].request_id).toBe('req-001');
  });

  it('addToReady() preserves all entry fields', async () => {
    const manager = new ManifestManager(TEST_DIR);
    const entry = makeReadyEntry({
      branch: 'feature/checkout',
      tier: 'large',
      priority: 5,
      depends_on: ['feature/auth'],
      metadata: { ticket: 'PROJ-456' },
    });

    await manager.addToReady(entry);

    const ready = await manager.getReadyEntries();
    expect(ready[0].branch).toBe('feature/checkout');
    expect(ready[0].tier).toBe('large');
    expect(ready[0].priority).toBe(5);
    expect(ready[0].depends_on).toEqual(['feature/auth']);
    expect(ready[0].metadata).toEqual({ ticket: 'PROJ-456' });
  });

  it('addToReady() supports multiple entries', async () => {
    const manager = new ManifestManager(TEST_DIR);

    await manager.addToReady(makeReadyEntry({ branch: 'feature/a', request_id: 'req-a' }));
    await manager.addToReady(makeReadyEntry({ branch: 'feature/b', request_id: 'req-b' }));

    const ready = await manager.getReadyEntries();
    expect(ready.length).toBe(2);
  });

  // ── getReadyEntries() retrieves entries ─────────────────────

  it('getReadyEntries() returns empty array when no entries', async () => {
    const manager = new ManifestManager(TEST_DIR);
    const ready = await manager.getReadyEntries();
    expect(ready).toEqual([]);
  });

  it('getReadyEntries() returns all ready entries', async () => {
    const manager = new ManifestManager(TEST_DIR);

    await manager.addToReady(makeReadyEntry({ branch: 'feature/x' }));
    await manager.addToReady(makeReadyEntry({ branch: 'feature/y' }));
    await manager.addToReady(makeReadyEntry({ branch: 'feature/z' }));

    const ready = await manager.getReadyEntries();
    expect(ready.length).toBe(3);
    expect(ready.map((e) => e.branch)).toEqual(['feature/x', 'feature/y', 'feature/z']);
  });

  // ── findReady() ─────────────────────────────────────────────

  it('findReady() returns the matching entry', async () => {
    const manager = new ManifestManager(TEST_DIR);
    await manager.addToReady(makeReadyEntry({ branch: 'feature/login' }));

    const found = await manager.findReady('feature/login');
    expect(found).toBeDefined();
    expect(found!.branch).toBe('feature/login');
  });

  it('findReady() returns undefined for non-existent branch', async () => {
    const manager = new ManifestManager(TEST_DIR);
    const found = await manager.findReady('nonexistent');
    expect(found).toBeUndefined();
  });

  // ── moveToPendingMerge() transitions correctly ──────────────

  it('moveToPendingMerge() moves entry from ready to pending_merge', async () => {
    const manager = new ManifestManager(TEST_DIR);
    await manager.addToReady(makeReadyEntry({ branch: 'feature/login' }));

    await manager.moveToPendingMerge('feature/login', {
      pr_number: 42,
      pr_url: 'https://github.com/org/repo/pull/42',
      integration_branch: 'integration/feature/login',
      base_main_sha: 'def456',
    });

    const ready = await manager.getReadyEntries();
    expect(ready.length).toBe(0);

    const pending = await manager.getPendingMergeEntries();
    expect(pending.length).toBe(1);
    expect(pending[0].branch).toBe('feature/login');
    expect(pending[0].pr_number).toBe(42);
    expect(pending[0].pr_url).toBe('https://github.com/org/repo/pull/42');
    expect(pending[0].integration_branch).toBe('integration/feature/login');
  });

  it('moveToPendingMerge() preserves fields from ready entry', async () => {
    const manager = new ManifestManager(TEST_DIR);
    const readyEntry = makeReadyEntry({
      branch: 'feature/checkout',
      request_id: 'req-checkout',
      tier: 'medium',
      priority: 5,
    });
    await manager.addToReady(readyEntry);

    await manager.moveToPendingMerge('feature/checkout', {
      pr_number: 99,
      pr_url: 'https://github.com/org/repo/pull/99',
      integration_branch: 'integration/feature/checkout',
      base_main_sha: 'ghi789',
    });

    const pending = await manager.getPendingMergeEntries();
    expect(pending[0].request_id).toBe('req-checkout');
    expect(pending[0].tier).toBe('medium');
    expect(pending[0].priority).toBe(5);
  });

  it('moveToPendingMerge() does nothing if branch not in ready', async () => {
    const manager = new ManifestManager(TEST_DIR);

    await manager.moveToPendingMerge('nonexistent', {
      pr_number: 1,
      pr_url: 'https://github.com/org/repo/pull/1',
      integration_branch: 'integration/nonexistent',
      base_main_sha: 'abc',
    });

    const pending = await manager.getPendingMergeEntries();
    expect(pending.length).toBe(0);
  });

  // ── moveToMergeHistory() transitions correctly ──────────────

  it('moveToMergeHistory() moves entry from pending_merge to merge_history', async () => {
    const manager = new ManifestManager(TEST_DIR);
    await manager.addToReady(makeReadyEntry({ branch: 'feature/merged' }));
    await manager.moveToPendingMerge('feature/merged', {
      pr_number: 10,
      pr_url: 'https://github.com/org/repo/pull/10',
      integration_branch: 'integration/feature/merged',
      base_main_sha: 'aaa',
    });

    await manager.moveToMergeHistory('feature/merged', 'commit-sha-xyz');

    const pending = await manager.getPendingMergeEntries();
    expect(pending.length).toBe(0);

    const manifest = await manager.read();
    expect(manifest.merge_history.length).toBe(1);
    expect(manifest.merge_history[0].branch).toBe('feature/merged');
    expect(manifest.merge_history[0].commit_sha).toBe('commit-sha-xyz');
    expect(manifest.merge_history[0].pr_number).toBe(10);
  });

  it('moveToMergeHistory() does nothing if branch not in pending_merge', async () => {
    const manager = new ManifestManager(TEST_DIR);

    await manager.moveToMergeHistory('nonexistent', 'sha');

    const manifest = await manager.read();
    expect(manifest.merge_history.length).toBe(0);
  });

  // ── Duplicate prevention ────────────────────────────────────

  it('addToReady() prevents duplicate branch entries', async () => {
    const manager = new ManifestManager(TEST_DIR);
    const entry = makeReadyEntry({ branch: 'feature/dupe' });

    await manager.addToReady(entry);
    await manager.addToReady(entry); // Second add should be ignored

    const ready = await manager.getReadyEntries();
    expect(ready.length).toBe(1);
  });

  it('duplicate check is based on branch name', async () => {
    const manager = new ManifestManager(TEST_DIR);

    await manager.addToReady(makeReadyEntry({ branch: 'feature/same', request_id: 'req-1' }));
    await manager.addToReady(makeReadyEntry({ branch: 'feature/same', request_id: 'req-2' }));

    const ready = await manager.getReadyEntries();
    expect(ready.length).toBe(1);
    expect(ready[0].request_id).toBe('req-1'); // First entry kept
  });

  // ── State machine validation ────────────────────────────────

  it('full lifecycle: ready -> pending_merge -> merge_history', async () => {
    const manager = new ManifestManager(TEST_DIR);

    // Phase 1: Add to ready
    await manager.addToReady(makeReadyEntry({ branch: 'feature/lifecycle' }));
    let ready = await manager.getReadyEntries();
    expect(ready.length).toBe(1);

    // Phase 2: Move to pending_merge
    await manager.moveToPendingMerge('feature/lifecycle', {
      pr_number: 77,
      pr_url: 'https://github.com/org/repo/pull/77',
      integration_branch: 'integration/feature/lifecycle',
      base_main_sha: 'base-sha',
    });
    ready = await manager.getReadyEntries();
    expect(ready.length).toBe(0);
    let pending = await manager.getPendingMergeEntries();
    expect(pending.length).toBe(1);

    // Phase 3: Move to merge_history
    await manager.moveToMergeHistory('feature/lifecycle', 'final-sha');
    pending = await manager.getPendingMergeEntries();
    expect(pending.length).toBe(0);
    const manifest = await manager.read();
    expect(manifest.merge_history.length).toBe(1);
    expect(manifest.merge_history[0].branch).toBe('feature/lifecycle');
  });

  it('moveBackToReady() moves entry from pending_merge back to ready', async () => {
    const manager = new ManifestManager(TEST_DIR);
    await manager.addToReady(makeReadyEntry({ branch: 'feature/rollback' }));
    await manager.moveToPendingMerge('feature/rollback', {
      pr_number: 55,
      pr_url: 'https://github.com/org/repo/pull/55',
      integration_branch: 'integration/feature/rollback',
      base_main_sha: 'sha-abc',
    });

    await manager.moveBackToReady('feature/rollback');

    const pending = await manager.getPendingMergeEntries();
    expect(pending.length).toBe(0);

    const ready = await manager.getReadyEntries();
    expect(ready.length).toBe(1);
    expect(ready[0].branch).toBe('feature/rollback');
  });

  // ── removeFromReady() ───────────────────────────────────────

  it('removeFromReady() removes and returns the entry', async () => {
    const manager = new ManifestManager(TEST_DIR);
    await manager.addToReady(makeReadyEntry({ branch: 'feature/remove' }));

    const removed = await manager.removeFromReady('feature/remove');
    expect(removed).toBeDefined();
    expect(removed!.branch).toBe('feature/remove');

    const ready = await manager.getReadyEntries();
    expect(ready.length).toBe(0);
  });

  it('removeFromReady() returns undefined for non-existent branch', async () => {
    const manager = new ManifestManager(TEST_DIR);
    const removed = await manager.removeFromReady('nonexistent');
    expect(removed).toBeUndefined();
  });

  // ── Main head tracking ──────────────────────────────────────

  it('updateMainHead() and getMainHead() round-trip', async () => {
    const manager = new ManifestManager(TEST_DIR);

    await manager.updateMainHead('sha-latest');
    const head = await manager.getMainHead();
    expect(head).toBe('sha-latest');
  });

  // ── Persistence across instances ────────────────────────────

  it('data persists across ManifestManager instances', async () => {
    const manager1 = new ManifestManager(TEST_DIR);
    await manager1.addToReady(makeReadyEntry({ branch: 'feature/persist' }));

    const manager2 = new ManifestManager(TEST_DIR);
    const ready = await manager2.getReadyEntries();
    expect(ready.length).toBe(1);
    expect(ready[0].branch).toBe('feature/persist');
  });

  // ── write() sets last_updated ───────────────────────────────

  it('write() sets last_updated timestamp', async () => {
    const manager = new ManifestManager(TEST_DIR);
    await manager.addToReady(makeReadyEntry({ branch: 'feature/ts' }));

    const manifest = await manager.read();
    expect(manifest.last_updated).toBeTruthy();
    // Validate it's a valid ISO date string
    const date = new Date(manifest.last_updated);
    expect(date.getTime()).not.toBeNaN();
  });

  // ── read() returns empty manifest when no file exists ───────

  it('read() returns empty manifest when no file exists', async () => {
    const manager = new ManifestManager(TEST_DIR);
    const manifest = await manager.read();

    expect(manifest.main_branch).toBe('main');
    expect(manifest.main_head).toBe('');
    expect(manifest.ready).toEqual([]);
    expect(manifest.pending_merge).toEqual([]);
    expect(manifest.merge_history).toEqual([]);
  });
});
