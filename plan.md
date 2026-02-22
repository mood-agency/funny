# Plan: Enrich PromptTimeline with Todos, Questions & Plans

## Goal
Add TodoWrite, AskUserQuestion, and ExitPlanMode tool calls as distinct milestone items in the PromptTimeline sidebar, interleaved chronologically with user messages.

## Current Behavior
The timeline only shows user messages (`role === 'user'`), filtering out everything else. Tool calls (todos, questions, plans) are invisible.

## Proposed Changes

### 1. Extend `PromptMilestone` type

Add a `type` discriminator:
- `'prompt'` — user message (current behavior)
- `'todo'` — TodoWrite tool call
- `'question'` — AskUserQuestion tool call
- `'plan'` — ExitPlanMode tool call

Each type stores a short summary (e.g., "3/5 done" for todos, first question text for questions, "Plan" label for plans).

### 2. Update milestone extraction in `PromptTimeline.tsx`

Instead of filtering only `role === 'user'`, iterate ALL messages:
- User messages → `'prompt'` milestone (same as today)
- Assistant messages → scan `toolCalls[]` for `TodoWrite`, `AskUserQuestion`, `ExitPlanMode` and create milestones

Items stay chronologically ordered since messages are already sorted by timestamp.

### 3. Render different styles per type

Each type gets a small colored Lucide icon instead of the plain dot:
- `ListTodo` for todos (amber)
- `MessageCircleQuestion` for questions (blue)
- `FileCode2` for plans (purple)
- Plain dot for user prompts (unchanged)

Same click-to-scroll behavior — scrolls to the parent message element.

### 4. Files changed

**`packages/client/src/components/thread/PromptTimeline.tsx`** — Main changes:
- Add Lucide icon imports
- Extend `PromptMilestone` with `type`, optional `messageId` field
- Update `useMemo` to extract tool call milestones from assistant messages
- Render icon + colored styling per type in `TimelineMilestone`

**`packages/client/src/components/ThreadView.tsx`** — Minor:
- Pass `onScrollToMessage` to also handle scrolling to assistant message elements (already works since all messages have rendered elements)

No new files. No new dependencies. No translation changes needed.
