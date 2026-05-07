# Plan: ThreadContext Migration — Eliminar `activeThread` global

## Problema

La app asume un solo `activeThread` global en el store Zustand. 23+ archivos leen `s.activeThread` directamente. La vista de columnas (grid) necesita N hilos simultáneos y usa un hack `threadOverride` para parchear los hooks. Esto no escala y no permite restaurar estado por URL.

## Decisión arquitectónica

Crear un **React Context** (`ThreadContext`) que le dice a cada componente "de qué hilo leer". El store sigue teniendo `activeThread` (para la vista single-thread) y `liveThreads` (para la grid), pero los componentes ya NO leen de `s.activeThread` directamente — usan hooks context-aware.

**No hay fallback**: si un componente no tiene provider, los hooks lanzan error. Migración completa.

### Ubicación del provider

```
App.tsx
  └─ <ThreadProvider threadId={selectedThreadId} source="active">
       ├─ Center panel
       │    ├─ <ThreadView /> (single-thread)
       │    │    o
       │    ├─ <LiveColumnsView />
       │    │    └─ <ThreadProvider threadId={colId} source="live">  ← override
       │    │         └─ <ThreadColumn />
       │    └─ <TerminalPanel />  (hidden when grid is open)
       └─ Right panel
            ├─ <ReviewPane />     (hidden when grid is open)
            └─ <ActivityPane />   (hidden when grid is open)
```

- **Single-thread view**: todo lee del App-level provider (`source: "active"` → `s.activeThread`)
- **Grid view**: cada columna tiene su propio provider anidado (`source: "live"` → `s.liveThreads[id]`). El right pane y terminal están ocultos en grid mode.
- React Context usa el provider **más cercano**, así las columnas overridean automáticamente.

---

## FASE 1: Crear infraestructura

### 1.1 Crear `packages/client/src/stores/thread-context.tsx`

```typescript
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useThreadStore } from './thread-store';
import type { ThreadWithMessages } from './thread-types';

interface ThreadContextValue {
  threadId: string | null;
  source: 'active' | 'live';
}

const ThreadContext = createContext<ThreadContextValue | null>(null);

export function ThreadProvider({
  threadId,
  source,
  children,
}: {
  threadId: string | null;
  source: 'active' | 'live';
  children: ReactNode;
}) {
  const value = useMemo(() => ({ threadId, source }), [threadId, source]);
  return <ThreadContext.Provider value={value}>{children}</ThreadContext.Provider>;
}

// Internal — used by all public hooks
function useThreadContext(): ThreadContextValue {
  const ctx = useContext(ThreadContext);
  if (!ctx) throw new Error('useThread* hooks require a <ThreadProvider> ancestor');
  return ctx;
}

// Resolves the thread from the correct store path
function resolveThread(
  state: { activeThread: ThreadWithMessages | null; liveThreads: Record<string, ThreadWithMessages> },
  ctx: ThreadContextValue,
): ThreadWithMessages | null {
  if (!ctx.threadId) return null;
  return ctx.source === 'active'
    ? state.activeThread
    : state.liveThreads[ctx.threadId] ?? null;
}

// ── Public hooks (replace useActive* from thread-selectors.ts) ──

export function useThreadId(): string | null {
  const ctx = useThreadContext();
  return ctx.threadId;
}

export function useThreadSource(): 'active' | 'live' {
  const ctx = useThreadContext();
  return ctx.source;
}

// Generic selector — for custom one-off reads
export function useThreadSelector<T>(selector: (thread: ThreadWithMessages | null) => T): T {
  const ctx = useThreadContext();
  return useThreadStore((s) => selector(resolveThread(s, ctx)));
}

// Named convenience hooks
export function useThreadStatus() {
  const ctx = useThreadContext();
  return useThreadStore((s) => resolveThread(s, ctx)?.status ?? null);
}

export function useThreadProjectId() {
  const ctx = useThreadContext();
  return useThreadStore((s) => resolveThread(s, ctx)?.projectId ?? null);
}

export function useThreadWorktreePath() {
  const ctx = useThreadContext();
  return useThreadStore((s) => resolveThread(s, ctx)?.worktreePath ?? null);
}

export function useThreadBranch() {
  const ctx = useThreadContext();
  return useThreadStore((s) => resolveThread(s, ctx)?.branch ?? null);
}

export function useThreadMessages() {
  const ctx = useThreadContext();
  return useThreadStore((s) => resolveThread(s, ctx)?.messages ?? null);
}

export function useThreadEvents() {
  const ctx = useThreadContext();
  return useThreadStore((s) => resolveThread(s, ctx)?.threadEvents);
}

export function useCompactionEvents() {
  const ctx = useThreadContext();
  return useThreadStore((s) => resolveThread(s, ctx)?.compactionEvents);
}

export function useThreadInitInfo() {
  // Needs ref-stability logic from current useActiveInitInfo — copy it
  const ctx = useThreadContext();
  const prevRef = useRef<AgentInitInfo | undefined>(undefined);
  return useThreadStore((s) => {
    const next = resolveThread(s, ctx)?.initInfo;
    if (!next) { prevRef.current = undefined; return undefined; }
    const prev = prevRef.current;
    if (prev && prev.cwd === next.cwd && prev.model === next.model
        && prev.tools.length === next.tools.length
        && prev.tools.every((t, i) => t === next.tools[i])) {
      return prev;
    }
    prevRef.current = next;
    return next;
  });
}

export function useThreadCore() {
  // Like useActiveThreadCore but context-aware
  const ctx = useThreadContext();
  return useThreadStore(
    useShallow((s) => {
      const t = resolveThread(s, ctx);
      if (!t) return null;
      const { messages, threadEvents, compactionEvents, ...core } = t;
      return core;
    })
  );
}

// ── Imperative utility (for event handlers, not hooks) ──
export function getThreadById(threadId: string): ThreadWithMessages | null {
  const state = useThreadStore.getState();
  if (state.activeThread?.id === threadId) return state.activeThread;
  return state.liveThreads[threadId] ?? null;
}
```

### 1.2 Update `packages/client/src/stores/thread-selectors.ts`

**Action**: Mark all `useActive*` hooks as `@deprecated` with a message pointing to the new hooks from `thread-context.tsx`. DO NOT delete them yet — they serve as a safety net during migration. They will be deleted at the end after all consumers are migrated.

---

## FASE 2: Place providers

### 2.1 `packages/client/src/App.tsx`

Wrap the main panel group with `<ThreadProvider>`:

```typescript
import { ThreadProvider } from '@/stores/thread-context';

// Inside the component:
const selectedThreadId = useThreadStore((s) => s.selectedThreadId);

// In JSX — wrap <div data-testid="main-panel-group">:
<ThreadProvider threadId={selectedThreadId} source="active">
  <div className="flex min-h-0 flex-1 overflow-hidden" data-testid="main-panel-group">
    {/* ... existing center panel + right panel ... */}
  </div>
</ThreadProvider>
```

### 2.2 `packages/client/src/components/live-columns/ThreadColumn.tsx`

Wrap the column content with a nested `<ThreadProvider>`:

```typescript
import { ThreadProvider } from '@/stores/thread-context';

// In JSX:
return (
  <ThreadProvider threadId={threadId} source="live">
    {/* existing column content */}
  </ThreadProvider>
);
```

**Also remove**: the `threadOverride` useMemo and its prop-passing to `PromptInput`.

---

## FASE 3: Migrate all consumers

Each file below currently reads `s.activeThread`. Replace with the new context-aware hooks.

### 3.1 Components using `useActive*` selector hooks

These files import from `thread-selectors.ts`. Update imports to use `thread-context.tsx` hooks instead.

| File | Current import | New import |
|------|---------------|------------|
| `components/ThreadView.tsx` | `useActiveThreadCore` | `useThreadCore` |
| `components/thread/ThreadChatView.tsx` | `useActiveMessages`, `useActiveThreadEvents`, `useActiveCompactionEvents` | `useThreadMessages`, `useThreadEvents`, `useCompactionEvents` |

### 3.2 Components with direct `useThreadStore(s => s.activeThread?.X)` selectors

For each file, replace every `useThreadStore(s => s.activeThread?.X)` with the corresponding named hook or `useThreadSelector(t => t?.X)`.

#### `components/ReviewPane.tsx` (7 selectors)
```
s.activeThread?.worktreePath     → useThreadWorktreePath()
s.activeThread?.projectId        → useThreadProjectId()
s.activeThread?.mode === 'worktree' → useThreadSelector(t => t?.mode === 'worktree')
s.activeThread?.baseBranch       → useThreadSelector(t => t?.baseBranch)
resolveThreadBranch(s.activeThread) → useThreadSelector(t => t ? resolveThreadBranch(t) : undefined)
s.activeThread?.status === 'running' → useThreadSelector(t => t?.status === 'running')
```

#### `components/ActivityPane.tsx` (6 selectors)
```
s.activeThread?.messages         → useThreadMessages()
s.activeThread?.id               → useThreadId()
s.activeThread?.status === 'running' → useThreadSelector(t => t?.status === 'running')
s.activeThread?.worktreePath     → useThreadWorktreePath()
s.activeThread?.projectId        → useThreadProjectId()
```

#### `components/CommitHistoryTab.tsx` (5 selectors)
```
s.activeThread?.baseBranch       → useThreadSelector(t => t?.baseBranch)
resolveThreadBranch(s.activeThread) → useThreadSelector(t => t ? resolveThreadBranch(t) : undefined)
s.activeThread?.status === 'running' → useThreadSelector(t => t?.status === 'running')
s.activeThread?.projectId        → useThreadProjectId()
s.activeThread?.mode === 'worktree' → useThreadSelector(t => t?.mode === 'worktree')
```

#### `components/ProjectFilesPane.tsx` (1 selector)
```
s.activeThread?.worktreePath     → useThreadWorktreePath()
```

#### `components/TerminalPanel.tsx` (1 selector)
```
s.activeThread?.worktreePath     → useThreadWorktreePath()
```

#### `components/thread/ProjectHeader.tsx` (many selectors)
This file has two types of reads:

**Hook selectors (lines ~123-148)** — replace with `useThreadSelector`:
```
s.activeThread?.id               → useThreadId()
s.activeThread?.projectId        → useThreadProjectId()
s.activeThread?.title            → useThreadSelector(t => t?.title)
s.activeThread?.mode             → useThreadSelector(t => t?.mode)
s.activeThread?.branch           → useThreadBranch()
s.activeThread?.pinned           → useThreadSelector(t => t?.pinned)
s.activeThread?.stage            → useThreadSelector(t => t?.stage)
s.activeThread?.messages?.length → useThreadSelector(t => (t?.messages?.length ?? 0) > 0)
s.activeThread?.status           → useThreadStatus()
s.activeThread?.worktreePath     → useThreadWorktreePath()
s.activeThread?.parentThreadId   → useThreadSelector(t => t?.parentThreadId)
s.activeThread?.agentTemplateId  → useThreadSelector(t => t?.agentTemplateId)
```

**Imperative reads (line ~227)** — use `getThreadById`:
```typescript
// Before: const messages = useThreadStore.getState().activeThread?.messages;
// After:
const threadId = useThreadId(); // from context
// In handler: const messages = getThreadById(threadId!)?.messages;
```

NOTE: `ProjectHeader` is used in BOTH `ThreadView` and potentially shared. Since both views have a provider, it will work in both contexts.

#### `components/thread/header/HeaderRightActions.tsx` (6 selectors)
```
s.activeThread?.id               → useThreadId()
s.activeThread?.projectId        → useThreadProjectId()
s.activeThread?.stage            → useThreadSelector(t => t?.stage)
s.activeThread?.status           → useThreadStatus()
s.activeThread?.worktreePath     → useThreadWorktreePath()
s.activeThread?.branch           → useThreadBranch()
```

#### `components/thread/header/HeaderLeftSection.tsx` (5 selectors)
```
s.activeThread?.id               → useThreadId()
s.activeThread?.projectId        → useThreadProjectId()
s.activeThread?.title            → useThreadSelector(t => t?.title)
s.activeThread?.parentThreadId   → useThreadSelector(t => t?.parentThreadId)
s.activeThread?.agentTemplateId  → useThreadSelector(t => t?.agentTemplateId)
```

#### `components/thread/header/use-more-actions-menu.ts` (9 selectors + 1 imperative)
**Hook selectors:**
```
s.activeThread?.id               → useThreadId()
s.activeThread?.projectId        → useThreadProjectId()
s.activeThread?.title            → useThreadSelector(t => t?.title)
s.activeThread?.mode             → useThreadSelector(t => t?.mode)
resolveThreadBranch(s.activeThread) → useThreadSelector(...)
s.activeThread?.pinned           → useThreadSelector(t => t?.pinned)
s.activeThread?.worktreePath     → useThreadWorktreePath()
s.activeThread?.messages?.length → useThreadSelector(...)
s.activeThread?.status           → useThreadStatus()
```

**Imperative (line 119):**
```typescript
// const messages = useThreadStore.getState().activeThread?.messages;
const messages = getThreadById(threadId!)?.messages;
```

#### `components/thread/WorkflowEventCard.tsx` (1 selector)
```
s.activeThread?.projectId        → useThreadProjectId()
```

#### `components/thread/PipelineEventCard.tsx` (1 selector)
```
s.activeThread?.projectId        → useThreadProjectId()
```

#### `components/tool-cards/EditFileCard.tsx` (1 selector)
```
s.activeThread?.id               → useThreadId()
```

#### `components/tool-cards/utils.ts` (2 selectors)
```
s.activeThread?.projectId        → useThreadProjectId()
s.activeThread?.worktreePath     → useThreadWorktreePath()
```

#### `hooks/use-todo-panel.ts` (1 selector)
```
s.activeThread?.messages         → useThreadMessages()
```

#### `components/mobile/ChatView.tsx` (1 selector)
```
// Uses useAppStore which is a facade over thread-store
s.activeThread                   → useThreadCore() or useThreadSelector(t => t)
```
Note: also uses `s.selectThread` — leave that as-is (it's an action, not a read).

### 3.3 `hooks/use-prompt-input-state.ts` — Remove `threadOverride`

**Major cleanup:**
1. Remove the `ThreadOverride` interface entirely
2. Remove `threadOverride` from `UsePromptInputStateArgs`
3. Remove the `threadSource` callback
4. Replace ALL thread reads with context hooks:
   - `useThreadId()` for threadId
   - `useThreadStatus()` for status
   - `useThreadSelector(t => t?.model)` for model
   - etc.
5. For `storeQueuedCount`, use `useThreadSelector(t => t?.queuedCount ?? 0)`
6. For imperative reads in handlers (`handleQueueDelete`, etc.), use `getThreadById(threadId)`
7. Remove the `threadIdProp` parameter (use `useThreadId()` from context instead)

### 3.4 `components/PromptInput.tsx` — Remove `threadOverride` prop

1. Remove `ThreadOverride` import
2. Remove `threadOverride` and `threadIdProp` from props
3. Remove passing them to `usePromptInputState`
4. The hook now gets everything from context

### 3.5 Imperative `getState()` calls — Use `getThreadById()`

#### `hooks/use-review-actions.ts` (line 471)
```typescript
// Before: const worktreePath = useThreadStore.getState().activeThread?.worktreePath;
// After: const worktreePath = getThreadById(threadId)?.worktreePath;
// Where threadId comes from the hook's parameter or from useThreadId() in the calling component
```
This hook is called from components that will have the context. The component should pass `threadId` to the hook, or the hook can accept it as param.

#### `hooks/use-notifications.ts` (line 23)
```typescript
// Before: return useThreadStore.getState().activeThread?.id === threadId;
// After: keep as-is — this is a global check "is this thread the focused one?"
// It correctly uses activeThread because it's asking "should I suppress this notification?"
```
Leave this one unchanged — it's legitimately asking about the globally focused thread.

#### `hooks/use-global-shortcuts.ts` (lines 40, 54, 66)
```typescript
// Before: const activeThreadProjectId = useThreadStore.getState().activeThread?.projectId ?? null;
// After: keep as-is — global shortcuts operate on the focused thread
```
Leave unchanged — global shortcuts correctly use `activeThread`.

#### `hooks/ws-event-dispatch.ts` (lines 478, 595)
Leave unchanged — WS event dispatching is store-internal logic.

### 3.6 Store internals — DO NOT TOUCH

These files are store-level logic and should NOT use the React Context:
- `stores/thread-store.ts` — keeps `activeThread` and `liveThreads` as-is
- `stores/thread-ws-handlers.ts` — keeps updating both data paths
- `stores/ui-store.ts` — keeps clearing `activeThread` on navigation

---

## FASE 4: Cleanup

### 4.1 Delete deprecated hooks from `thread-selectors.ts`

Remove these hooks (all consumers are now migrated):
- `useActiveThreadStatus`
- `useActiveThreadId`
- `useActiveThreadWorktreePath`
- `useActiveThreadProjectId`
- `useActiveThreadBranch`
- `useActiveInitInfo`
- `useActiveMessages`
- `useActiveThreadEvents`
- `useActiveCompactionEvents`
- `useActiveThreadCore`

Keep the pure functions (`selectLastMessage`, `selectFirstMessage`, etc.) — they take a thread parameter and are context-independent.

### 4.2 Delete `ThreadOverride` from everywhere

Verify no references to `ThreadOverride` or `threadOverride` remain.

### 4.3 Rename `activeThread` variable names in components

In components that used `const activeThread = useActiveThreadCore()`, rename to `const thread = useThreadCore()` for clarity. This is optional but improves readability.

---

## FASE 5: Tests

### 5.1 Update test helpers

In `__tests__/helpers/render.tsx`, add `ThreadProvider` wrapping:
```typescript
function renderWithProviders(ui, { threadId, source = 'active', ...options } = {}) {
  return render(
    <MemoryRouter>
      <ThreadProvider threadId={threadId} source={source}>
        {ui}
      </ThreadProvider>
    </MemoryRouter>,
    options
  );
}
```

### 5.2 Update existing tests

- `__tests__/stores/app-store.test.ts` — These test the store directly (not components), so they should NOT need ThreadContext. Keep reading `getState().activeThread` in tests.
- `__tests__/stores/thread-store-actions.test.ts` — Same, store-level tests stay as-is.
- Any component tests that render components using the new hooks need the `ThreadProvider` wrapper.

---

## Build order

Execute in this exact sequence:

1. **Create** `stores/thread-context.tsx` (new file, no deps)
2. **Deprecate** hooks in `stores/thread-selectors.ts` (add @deprecated, no breakage)
3. **Add provider** in `App.tsx` (wraps main panel, no breakage — nothing consumes yet)
4. **Add provider** in `ThreadColumn.tsx` + remove `threadOverride` useMemo
5. **Migrate** `PromptInput.tsx` + `use-prompt-input-state.ts` (remove threadOverride)
6. **Migrate** all other consumer components (Group B files, one by one)
7. **Migrate** imperative `getState()` calls that need `getThreadById()`
8. **Delete** deprecated hooks from `thread-selectors.ts`
9. **Update** test helpers and tests
10. **Type-check**: `bunx tsc --noEmit --project packages/client/tsconfig.json`
11. **Build**: `cd packages/client && bun run build`

---

## Verification checklist

- [ ] `bunx tsc --noEmit` passes (only pre-existing errors)
- [ ] `bun run build` succeeds
- [ ] No file imports `useActive*` from `thread-selectors.ts` (grep to verify)
- [ ] No file reads `s.activeThread` in a React hook/selector (grep: only store internals, ws-handlers, ui-store, and imperative global-shortcuts/notifications should remain)
- [ ] No reference to `threadOverride` or `ThreadOverride` anywhere
- [ ] `getThreadById` is used for all imperative reads in event handlers

---

## Files summary

| Action | File | What changes |
|--------|------|-------------|
| **CREATE** | `stores/thread-context.tsx` | Context, provider, all hooks, `getThreadById` |
| **MODIFY** | `stores/thread-selectors.ts` | Deprecate `useActive*`, keep pure functions |
| **MODIFY** | `App.tsx` | Wrap main-panel-group with `<ThreadProvider>` |
| **MODIFY** | `live-columns/ThreadColumn.tsx` | Add `<ThreadProvider>`, remove `threadOverride` |
| **MODIFY** | `PromptInput.tsx` | Remove `threadOverride` prop |
| **MODIFY** | `hooks/use-prompt-input-state.ts` | Remove `ThreadOverride`, use context hooks |
| **MODIFY** | `components/ReviewPane.tsx` | 7 selectors → context hooks |
| **MODIFY** | `components/ActivityPane.tsx` | 6 selectors → context hooks |
| **MODIFY** | `components/CommitHistoryTab.tsx` | 5 selectors → context hooks |
| **MODIFY** | `components/ProjectFilesPane.tsx` | 1 selector → context hook |
| **MODIFY** | `components/TerminalPanel.tsx` | 1 selector → context hook |
| **MODIFY** | `thread/ProjectHeader.tsx` | ~15 selectors → context hooks |
| **MODIFY** | `thread/header/HeaderRightActions.tsx` | 6 selectors → context hooks |
| **MODIFY** | `thread/header/HeaderLeftSection.tsx` | 5 selectors → context hooks |
| **MODIFY** | `thread/header/use-more-actions-menu.ts` | 10 selectors → context hooks |
| **MODIFY** | `thread/WorkflowEventCard.tsx` | 1 selector → context hook |
| **MODIFY** | `thread/PipelineEventCard.tsx` | 1 selector → context hook |
| **MODIFY** | `tool-cards/EditFileCard.tsx` | 1 selector → context hook |
| **MODIFY** | `tool-cards/utils.ts` | 2 selectors → context hooks |
| **MODIFY** | `hooks/use-todo-panel.ts` | 1 selector → context hook |
| **MODIFY** | `hooks/use-review-actions.ts` | 1 imperative → `getThreadById` |
| **MODIFY** | `mobile/ChatView.tsx` | 1 selector → context hook |
| **MODIFY** | `thread/ThreadChatView.tsx` | Update imports to new hooks |
| **MODIFY** | `components/ThreadView.tsx` | Update imports to new hooks |
| **NO TOUCH** | `stores/thread-store.ts` | Store internals stay as-is |
| **NO TOUCH** | `stores/thread-ws-handlers.ts` | WS handlers stay as-is |
| **NO TOUCH** | `stores/ui-store.ts` | Navigation clearing stays as-is |
| **NO TOUCH** | `hooks/use-notifications.ts` | Global check, legitimate `activeThread` use |
| **NO TOUCH** | `hooks/use-global-shortcuts.ts` | Global shortcuts, legitimate `activeThread` use |
| **NO TOUCH** | `hooks/ws-event-dispatch.ts` | WS dispatching, store-internal |
