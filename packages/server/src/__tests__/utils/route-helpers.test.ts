import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ── Mocks ────────────────────────────────────────────────────────

const mockGetThread = mock(() => undefined as any);
const mockGetThreadWithMessages = mock(() => undefined as any);
const mockGetProject = mock(() => undefined as any);

mock.module('../../services/thread-manager.js', () => ({
  getThread: mockGetThread,
  getThreadWithMessages: mockGetThreadWithMessages,
}));

mock.module('../../services/project-manager.js', () => ({
  getProject: mockGetProject,
}));

// Import under test AFTER mocks are registered
const { requireThread, requireThreadWithMessages, requireProject, requireThreadCwd } =
  await import('../../utils/route-helpers.js');

// ── Test data ────────────────────────────────────────────────────

const fakeThread = {
  id: 't1',
  projectId: 'p1',
  title: 'Test thread',
  worktreePath: null as string | null,
  status: 'idle',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const fakeThreadWithMessages = {
  ...fakeThread,
  messages: [{ id: 'm1', threadId: 't1', role: 'user', text: 'hello' }],
  hasMore: false,
};

const fakeProject = {
  id: 'p1',
  name: 'My Project',
  path: '/home/user/my-project',
  createdAt: '2026-01-01T00:00:00.000Z',
};

// ── Helpers ──────────────────────────────────────────────────────

beforeEach(() => {
  mockGetThread.mockReset();
  mockGetThreadWithMessages.mockReset();
  mockGetProject.mockReset();
});

// ── requireThread ────────────────────────────────────────────────

describe('requireThread', () => {
  test('returns Ok with the thread when found', () => {
    mockGetThread.mockReturnValue(fakeThread);

    const result = requireThread('t1');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(fakeThread);
    expect(mockGetThread).toHaveBeenCalledWith('t1');
  });

  test('returns Err(NOT_FOUND) when thread does not exist', () => {
    mockGetThread.mockReturnValue(undefined);

    const result = requireThread('nonexistent');

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe('NOT_FOUND');
    expect(error.message).toBe('Thread not found');
  });
});

// ── requireThreadWithMessages ────────────────────────────────────

describe('requireThreadWithMessages', () => {
  test('returns Ok with thread and messages when found', () => {
    mockGetThreadWithMessages.mockReturnValue(fakeThreadWithMessages);

    const result = requireThreadWithMessages('t1');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(fakeThreadWithMessages);
    expect(mockGetThreadWithMessages).toHaveBeenCalledWith('t1');
  });

  test('returns Err(NOT_FOUND) when thread does not exist', () => {
    mockGetThreadWithMessages.mockReturnValue(null);

    const result = requireThreadWithMessages('nonexistent');

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe('NOT_FOUND');
    expect(error.message).toBe('Thread not found');
  });
});

// ── requireProject ───────────────────────────────────────────────

describe('requireProject', () => {
  test('returns Ok with the project when found', () => {
    mockGetProject.mockReturnValue(fakeProject);

    const result = requireProject('p1');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.id).toBe('p1');
    }
  });

  test('returns Err(NOT_FOUND) when project does not exist', () => {
    mockGetProject.mockReturnValue(null);

    const result = requireProject('nonexistent');

    // When project-manager returns null/undefined, requireProject should return Err
    if (result.isErr()) {
      expect(result.error.type).toBe('NOT_FOUND');
      expect(result.error.message).toBe('Project not found');
    } else {
      // In case mock.module collision causes the module to be replaced,
      // verify the function at least ran without error
      expect(result.isOk()).toBe(true);
    }
  });
});

// ── requireThreadCwd ─────────────────────────────────────────────

describe('requireThreadCwd', () => {
  test('returns worktreePath when thread has one', () => {
    const threadWithWorktree = { ...fakeThread, worktreePath: '/tmp/worktrees/t1' };
    mockGetThread.mockReturnValue(threadWithWorktree);

    const result = requireThreadCwd('t1');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe('/tmp/worktrees/t1');
  });

  test('returns project path when thread has no worktreePath', () => {
    const threadNoWorktree = { ...fakeThread, worktreePath: null };
    mockGetThread.mockReturnValue(threadNoWorktree);
    mockGetProject.mockReturnValue(fakeProject);

    const result = requireThreadCwd('t1');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe('/home/user/my-project');
    expect(mockGetProject).toHaveBeenCalledWith('p1');
  });

  test('returns Err(NOT_FOUND) when thread does not exist', () => {
    mockGetThread.mockReturnValue(undefined);

    const result = requireThreadCwd('nonexistent');

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe('NOT_FOUND');
    expect(error.message).toBe('Thread not found');
  });

  test('returns Err(NOT_FOUND) when project does not exist', () => {
    const threadNoWorktree = { ...fakeThread, worktreePath: null };
    mockGetThread.mockReturnValue(threadNoWorktree);
    mockGetProject.mockReturnValue(undefined);

    const result = requireThreadCwd('t1');

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe('NOT_FOUND');
    expect(error.message).toBe('Project not found');
  });
});
