/**
 * Handler Registry — collects all reactive handlers and wires them
 * to the ThreadEventBus at server startup.
 *
 * To add a new handler:
 *   1. Create a file in this directory exporting an EventHandler
 *   2. Import it here and add it to the allHandlers array
 */

import { threadEventBus, type ThreadEventMap } from '../thread-event-bus.js';
import type { EventHandler, HandlerServiceContext } from './types.js';

// ── Import handlers ─────────────────────────────────────────────

import { commentHandler } from './comment-handler.js';
import { gitStatusHandler } from './git-status-handler.js';

// ── Handler list ────────────────────────────────────────────────

const allHandlers: EventHandler<any>[] = [
  commentHandler,
  gitStatusHandler,
];

// ── Registration ────────────────────────────────────────────────

/**
 * Wire all handlers to the event bus.
 * Call once at server startup.
 */
export function registerAllHandlers(ctx: HandlerServiceContext): void {
  for (const handler of allHandlers) {
    const wrappedListener = async (payload: any) => {
      try {
        if (handler.filter && !handler.filter(payload, ctx)) {
          return;
        }
        await handler.action(payload, ctx);
      } catch (err) {
        console.error(`[handler:${handler.name}] Error:`, err);
      }
    };

    threadEventBus.on(
      handler.event as keyof ThreadEventMap,
      wrappedListener as any,
    );
    console.log(`[handler-registry] Registered "${handler.name}" on "${handler.event}"`);
  }

  console.log(`[handler-registry] ${allHandlers.length} handler(s) registered`);
}
