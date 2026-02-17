import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Mock dependencies
const mockEmit = mock(() => {});
const mockEmitToUser = mock(() => {});
mock.module('../../services/ws-broker.js', () => ({
  wsBroker: {
    emit: mockEmit,
    emitToUser: mockEmitToUser,
  },
}));

mock.module('../../services/project-manager.js', () => ({
  getProject: (id: string) => {
    if (id === 'p1') return { id: 'p1', path: '/tmp/project', userId: '__local__' };
    if (id === 'p2') return { id: 'p2', path: '/tmp/project2', userId: 'user1' };
    return null;
  },
}));

import { getRunningCommands, isCommandRunning } from '../../services/command-runner.js';

describe('command-runner', () => {
  beforeEach(() => {
    mockEmit.mockClear();
    mockEmitToUser.mockClear();
  });

  test('getRunningCommands returns empty array initially', () => {
    expect(getRunningCommands()).toEqual([]);
  });

  test('isCommandRunning returns false for unknown command', () => {
    expect(isCommandRunning('unknown-cmd')).toBe(false);
  });

  test('getRunningCommands returns array of strings', () => {
    const result = getRunningCommands();
    expect(Array.isArray(result)).toBe(true);
  });
});
