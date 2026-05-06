import { create } from 'zustand';

import { createClientLogger } from '@/lib/client-logger';

const log = createClientLogger('runner-status');

export type RunnerStatus = 'unknown' | 'online' | 'offline';

interface RunnerStatusState {
  status: RunnerStatus;
  setStatus: (status: RunnerStatus) => void;
  reset: () => void;
}

export const useRunnerStatusStore = create<RunnerStatusState>((set, get) => ({
  status: 'unknown',
  setStatus: (status) => {
    if (get().status === status) return;
    log.info('Runner status changed', { status });
    set({ status });
  },
  reset: () => set({ status: 'unknown' }),
}));
