# Plan: Add Slice Descriptions + merge() to evflow

## Summary

Add `description` field to slices in the evflow DSL, add descriptions to all 5 slices in the shared model, add `merge()` for future model composition, and update generators.

## Changes

### 1. evflow DSL: Add `description` to slices

**`packages/evflow/src/types.ts`**
- Add `description?: string` to `SliceDef` (after `name`)
- Add `description?: string` to `SliceOptions` (after `ui`)

**`packages/evflow/src/event-model.ts`**
- Pass `opts.description` through in `slice()` method

### 2. evflow DSL: Add `merge()` method

**`packages/evflow/src/event-model.ts`**
- Add `merge(other: EventModel): void` — copies all elements, sequences, slices, and contexts from another model into this one

### 3. Update generators

**`packages/evflow/src/generators/ai-prompt.ts`**
- Render `slice.description` after `### ${slice.name}` heading

**`packages/evflow/src/generators/react-flow.ts`**
- Include `description` in slice group node data

### 4. Add slice descriptions to the shared model

**`packages/shared/src/evflow.model.ts`**
- Add `description` to all 5 `system.slice()` calls:
  - Thread Management
  - Git Operations
  - Pipeline
  - Watcher Lifecycle
  - Terminal Management

### 5. Tests

**`packages/evflow/src/__tests__/event-model.test.ts`**
- Add test: slice description is stored and returned in getData()
- Add test: merge() combines elements, sequences, slices, and contexts
