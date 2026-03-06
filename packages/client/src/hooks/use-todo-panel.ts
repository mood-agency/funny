import { useRef, useMemo } from 'react';

import { formatInput, getTodos } from '@/components/tool-cards/utils';
import type { TodoItem } from '@/components/tool-cards/utils';
import { useThreadStore } from '@/stores/thread-store';

export interface TodoSnapshot {
  todos: TodoItem[];
  toolCallId: string;
  progress: { completed: number; total: number };
}

/**
 * Extract only TodoWrite tool calls from messages.
 * Returns a stable reference when the TodoWrite calls haven't changed,
 * preventing downstream recomputes on every WS message update.
 */
function useTodoWriteCalls(): { id: string; input: any }[] {
  const prevRef = useRef<{ id: string; input: any }[]>([]);

  return useThreadStore((s) => {
    const messages = s.activeThread?.messages;
    if (!messages) {
      if (prevRef.current.length === 0) return prevRef.current;
      prevRef.current = [];
      return prevRef.current;
    }

    // Collect TodoWrite tool call references
    const calls: { id: string; input: any }[] = [];
    for (const msg of messages) {
      for (const tc of msg.toolCalls ?? []) {
        if (tc.name === 'TodoWrite') calls.push(tc);
      }
    }

    // Shallow compare: same length and same object references
    const prev = prevRef.current;
    if (prev.length === calls.length && calls.every((c, i) => c === prev[i])) {
      return prev;
    }

    prevRef.current = calls;
    return calls;
  });
}

/**
 * Returns all TodoWrite snapshots in chronological order.
 * Each snapshot represents the full todo state at that point in the conversation.
 */
export function useTodoSnapshots(): TodoSnapshot[] {
  const todoCalls = useTodoWriteCalls();

  return useMemo(() => {
    if (todoCalls.length === 0) return [];
    const snapshots: TodoSnapshot[] = [];

    for (const tc of todoCalls) {
      const parsed = formatInput(tc.input);
      const todos = getTodos(parsed);
      if (todos && todos.length > 0) {
        const completed = todos.filter((t) => t.status === 'completed').length;
        snapshots.push({
          todos,
          toolCallId: tc.id,
          progress: { completed, total: todos.length },
        });
      }
    }

    return snapshots;
  }, [todoCalls]);
}
