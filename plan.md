# Plan: Improve Client Code Quality — Render Stability Patterns

## Problem Summary

The render instability we fixed came from 4 recurring anti-patterns:

1. **Monolithic store objects** — Every WS event does `set({ activeThread: { ...activeThread, <field> } })`, creating a new `activeThread` reference. Components using `useThreadStore(s => s.activeThread)` re-render on every single update (cost, context_usage, messages, tool outputs, etc.) even if they only care about `status` or `initInfo`.

2. **Unstable `useNavigate()`** — React Router returns a new function on every route change, invalidating all `useCallback`s that depend on it.

3. **Bare `memo()` with object props** — Default `memo()` uses `===` which always fails when store objects are recreated.

4. **Conditional callback props** — `onAction={isDisabled ? undefined : handler}` alternates between `undefined` and a function reference.

## Planned Changes

### Step 1: Create `useStableNavigate()` hook

**File:** `packages/client/src/hooks/use-stable-navigate.ts` (new)

A reusable hook that wraps `useNavigate()` in a ref and returns a stable function. This eliminates the `navigateRef` boilerplate we manually added to Sidebar, ThreadList, and ProjectItem, and prevents the pattern from being forgotten in future components.

Then replace all `navigateRef` patterns in Sidebar.tsx, ThreadList.tsx, and ProjectItem.tsx with this hook.

### Step 2: Create `useStableCallback()` utility

**File:** `packages/client/src/hooks/use-stable-callback.ts` (new)

A generic hook for the "ref + useCallback" pattern. Useful for any callback that needs to be referentially stable while always calling the latest closure.

### Step 3: Refactor Sidebar.tsx, ThreadList.tsx, ProjectItem.tsx to use `useStableNavigate()`

Replace the manual `navigateRef` pattern in all three files with the new hook. This reduces boilerplate and makes the intent clearer.

### Step 4: Consolidate thread visual-equality helpers

**File:** `packages/client/src/lib/shallow-compare.ts` (new)

We have duplicate "visual fields only" comparison logic in ThreadList.tsx, ThreadItem.tsx, and Sidebar.tsx. Consolidate into a single utility with:
- `threadsVisuallyEqual(a, b)` — compares only render-relevant Thread fields
- `arraysEqual(a, b, eq)` — shallow array comparison with custom element comparator

Then update ThreadList.tsx, ThreadItem.tsx, Sidebar.tsx, and ProjectItem.tsx to import from this shared module.

### Step 5: Add granular selector hooks for `activeThread`

Instead of restructuring the store (high risk), add targeted selector hooks in `thread-selectors.ts` using `zustand/shallow`:
- `useActiveInitInfo()`
- `useActiveThreadStatus()`
- `useActiveThreadMessages()`

Then update ThreadView.tsx to use `useActiveInitInfo()` instead of `activeThread.initInfo`.

### Step 6: Add render stability documentation

Add a comment block to `thread-store.ts` documenting the 4 rules to follow.

## Files Changed

| File | Change Type |
|------|------------|
| `packages/client/src/hooks/use-stable-navigate.ts` | New |
| `packages/client/src/hooks/use-stable-callback.ts` | New |
| `packages/client/src/lib/shallow-compare.ts` | New |
| `packages/client/src/components/Sidebar.tsx` | Refactor |
| `packages/client/src/components/sidebar/ThreadList.tsx` | Refactor |
| `packages/client/src/components/sidebar/ProjectItem.tsx` | Refactor |
| `packages/client/src/components/sidebar/ThreadItem.tsx` | Refactor |
| `packages/client/src/stores/thread-selectors.ts` | Add selector hooks |
| `packages/client/src/components/ThreadView.tsx` | Use granular selectors |
| `packages/client/src/stores/thread-store.ts` | Add doc comments |

## What This Does NOT Change

- Store structure (no normalization) — too risky for one PR
- WS handler logic — unchanged
- Server code — unchanged
- Test files — behavior is unchanged
