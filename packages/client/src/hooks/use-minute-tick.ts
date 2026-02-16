import { useSyncExternalStore } from 'react';

/**
 * Global minute-level tick for relative timestamps.
 * A single setInterval drives all subscribers — no per-component timers.
 */
let tick = 0;
const listeners = new Set<() => void>();

setInterval(() => {
  tick++;
  for (const cb of listeners) cb();
}, 60_000);

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot() {
  return tick;
}

/**
 * Returns a tick counter that increments every 60 seconds.
 * Any component calling this will re-render once per minute,
 * ensuring relative timestamps (timeAgo) stay fresh.
 */
export function useMinuteTick(): number {
  return useSyncExternalStore(subscribe, getSnapshot);
}
