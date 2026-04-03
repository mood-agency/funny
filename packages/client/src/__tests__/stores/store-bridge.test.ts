import { describe, test, expect, beforeEach, vi } from 'vitest';

/**
 * We test store-bridge by dynamically importing it fresh for each test
 * so the lazy refs (_projectStoreRef, _threadStoreRef) start as null.
 */

function createMockStore<T extends Record<string, any>>(initialState: T) {
  let state = { ...initialState };
  return {
    getState: () => state,
    setState: (partial: Partial<T>) => {
      state = { ...state, ...partial };
    },
    subscribe: vi.fn(),
    destroy: vi.fn(),
  };
}

// We need a fresh module for each test to reset the internal refs.
async function freshBridge() {
  // Clear the cached module so we get fresh lazy refs
  const modulePath = '@/stores/store-bridge';
  vi.resetModules();
  return import(modulePath);
}

describe('store-bridge', () => {
  describe('before registration', () => {
    test('batchUpdateThreads is a no-op and does not throw', async () => {
      const bridge = await freshBridge();
      expect(() =>
        bridge.batchUpdateThreads([{ projectId: 'p1', threads: [{ id: 't1' }], total: 1 }]),
      ).not.toThrow();
    });

    test('ensureThreadsLoaded is a no-op and does not throw', async () => {
      const bridge = await freshBridge();
      expect(() => bridge.ensureThreadsLoaded('p1')).not.toThrow();
    });

    test('clearProjectThreads is a no-op and does not throw', async () => {
      const bridge = await freshBridge();
      expect(() => bridge.clearProjectThreads('p1')).not.toThrow();
    });

    test('expandProject is a no-op and does not throw', async () => {
      const bridge = await freshBridge();
      expect(() => bridge.expandProject('p1')).not.toThrow();
    });

    test('selectProject is a no-op and does not throw', async () => {
      const bridge = await freshBridge();
      expect(() => bridge.selectProject('p1')).not.toThrow();
    });

    test('getProjectPath returns undefined', async () => {
      const bridge = await freshBridge();
      expect(bridge.getProjectPath('p1')).toBeUndefined();
    });
  });

  describe('after registration', () => {
    test('batchUpdateThreads delegates to thread store', async () => {
      const bridge = await freshBridge();

      const threadStore = createMockStore({
        threadsByProject: {} as Record<string, any[]>,
        threadTotalByProject: {} as Record<string, number>,
      });

      bridge.registerThreadStore(threadStore as any);

      const threads = [{ id: 't1', name: 'Thread 1' }];
      bridge.batchUpdateThreads([{ projectId: 'p1', threads, total: 1 }]);

      const state = threadStore.getState();
      expect(state.threadsByProject['p1']).toBe(threads);
      expect(state.threadTotalByProject['p1']).toBe(1);
    });

    test('batchUpdateThreads only updates changed entries', async () => {
      const bridge = await freshBridge();

      const existingThreads = [{ id: 't1' }];
      const threadStore = createMockStore({
        threadsByProject: { p1: existingThreads } as Record<string, any[]>,
        threadTotalByProject: { p1: 1 } as Record<string, number>,
      });

      const setStateSpy = vi.spyOn(threadStore, 'setState');
      bridge.registerThreadStore(threadStore as any);

      // Pass the same reference -- should NOT trigger setState
      bridge.batchUpdateThreads([{ projectId: 'p1', threads: existingThreads, total: 1 }]);

      expect(setStateSpy).not.toHaveBeenCalled();
    });

    test('batchUpdateThreads skips entries with null threads', async () => {
      const bridge = await freshBridge();

      const threadStore = createMockStore({
        threadsByProject: {} as Record<string, any[]>,
        threadTotalByProject: {} as Record<string, number>,
      });

      const setStateSpy = vi.spyOn(threadStore, 'setState');
      bridge.registerThreadStore(threadStore as any);

      bridge.batchUpdateThreads([{ projectId: 'p1', threads: null, total: 0 }]);

      expect(setStateSpy).not.toHaveBeenCalled();
    });

    test('ensureThreadsLoaded calls loadThreadsForProject when not loaded', async () => {
      const bridge = await freshBridge();

      const loadThreadsForProject = vi.fn();
      const threadStore = createMockStore({
        threadsByProject: {} as Record<string, any[]>,
        loadThreadsForProject,
      });

      bridge.registerThreadStore(threadStore as any);
      bridge.ensureThreadsLoaded('p1');

      expect(loadThreadsForProject).toHaveBeenCalledWith('p1');
    });

    test('ensureThreadsLoaded skips if threads already loaded', async () => {
      const bridge = await freshBridge();

      const loadThreadsForProject = vi.fn();
      const threadStore = createMockStore({
        threadsByProject: { p1: [{ id: 't1' }] } as Record<string, any[]>,
        loadThreadsForProject,
      });

      bridge.registerThreadStore(threadStore as any);
      bridge.ensureThreadsLoaded('p1');

      expect(loadThreadsForProject).not.toHaveBeenCalled();
    });

    test('clearProjectThreads delegates to thread store', async () => {
      const bridge = await freshBridge();

      const clearProjectThreads = vi.fn();
      const threadStore = createMockStore({
        clearProjectThreads,
      });

      bridge.registerThreadStore(threadStore as any);
      bridge.clearProjectThreads('p1');

      expect(clearProjectThreads).toHaveBeenCalledWith('p1');
    });

    test('expandProject adds to expandedProjects set', async () => {
      const bridge = await freshBridge();

      const projectStore = createMockStore({
        expandedProjects: new Set<string>(),
      });

      bridge.registerProjectStore(projectStore as any);
      bridge.expandProject('p1');

      const state = projectStore.getState();
      expect(state.expandedProjects.has('p1')).toBe(true);
    });

    test('expandProject does not update if project already expanded', async () => {
      const bridge = await freshBridge();

      const projectStore = createMockStore({
        expandedProjects: new Set<string>(['p1']),
      });

      const setStateSpy = vi.spyOn(projectStore, 'setState');
      bridge.registerProjectStore(projectStore as any);
      bridge.expandProject('p1');

      expect(setStateSpy).not.toHaveBeenCalled();
    });

    test('selectProject sets selectedProjectId on project store', async () => {
      const bridge = await freshBridge();

      const projectStore = createMockStore({
        selectedProjectId: null as string | null,
      });

      bridge.registerProjectStore(projectStore as any);
      bridge.selectProject('p1');

      expect(projectStore.getState().selectedProjectId).toBe('p1');
    });

    test('getProjectPath returns correct path', async () => {
      const bridge = await freshBridge();

      const projectStore = createMockStore({
        projects: [
          { id: 'p1', path: '/home/user/project-a' },
          { id: 'p2', path: '/home/user/project-b' },
        ],
      });

      bridge.registerProjectStore(projectStore as any);

      expect(bridge.getProjectPath('p1')).toBe('/home/user/project-a');
      expect(bridge.getProjectPath('p2')).toBe('/home/user/project-b');
    });

    test('getProjectPath returns undefined for unknown project', async () => {
      const bridge = await freshBridge();

      const projectStore = createMockStore({
        projects: [{ id: 'p1', path: '/home/user/project-a' }],
      });

      bridge.registerProjectStore(projectStore as any);

      expect(bridge.getProjectPath('unknown')).toBeUndefined();
    });
  });
});
