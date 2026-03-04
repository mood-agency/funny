# Plan: Delegate Commit Operations to Claude Code Agent via `/commit`

## Problem

Currently, when the user clicks Commit in the review pane (right sidebar), the server's `git-workflow-service.ts` executes the git workflow directly (stage, run hooks, commit, push, PR, merge). If pre-commit hooks fail, the workflow stops and the user has to manually fix the issue and retry.

The goal is to instead **delegate the entire workflow to the Claude Code agent** by sending it a follow-up message with a commit instruction. The agent (Claude Code) has built-in skills `/commit` and `/commit-push-pr` that automatically handle pre-commit hook failures, re-stages, and retries — removing this burden from the user.

## Scope

- **Full workflow**: The agent handles everything the user selected (stage, hooks, commit, push, PR, merge).
- **Threads only**: Only delegate to the agent when a thread is active. Project-mode commits (no thread) keep the existing `git-workflow-service` workflow unchanged.

## Approach: Send a `/commit` or `/commit-push-pr` command to the agent via `sendMessage`

Instead of calling `git-workflow-service.executeWorkflow()`, the client will call `api.sendMessage()` with a prompt that uses Claude Code's built-in slash commands:

- **For `commit` and `amend` actions** → Send `/commit` (Claude Code handles staging, hooks, retries)
- **For `commit-push` and `commit-pr` and `commit-merge` actions** → Send `/commit-push-pr` (Claude Code handles commit + push + PR creation)

This is the same pattern used by `handleAskAgentResolve` (line 806 in ReviewPane.tsx).

The prompt will prefix the slash command with context about what files to stage and the desired commit message so the agent uses them instead of auto-generating.

## Changes

### 1. Client: `packages/client/src/components/ReviewPane.tsx`

Modify `handleCommitAction` (line 656) — when `effectiveThreadId` is available:

- Instead of calling `api.startWorkflow(effectiveThreadId, params)`, construct a prompt and call `api.sendMessage(effectiveThreadId, prompt)`.
- Choose the appropriate slash command based on the selected action:
  - `commit` or `amend` → `/commit`
  - `commit-push`, `commit-pr`, `commit-merge` → `/commit-push-pr`
- Include staging context and commit message in the prompt body.
- When `effectiveThreadId` is NOT available (project-mode), keep the existing `api.projectStartWorkflow()` call unchanged.

Similarly modify `handlePushOnly`, `handleMergeOnly`, and `handleCreatePROnly` — when `effectiveThreadId` is available, send agent message instead (these don't use `/commit` but a plain prompt instructing the agent to push/merge/create-pr).

### 2. Prompt Construction Helper

Add a `buildAgentCommitPrompt(params)` function that generates the agent message:

**For `commit` / `amend`:**
```
First stage these files: src/foo.ts, src/bar.ts

Then use /commit with this commit message:
fix: resolve authentication bug

Added proper token validation to the middleware
```

**For `commit-push` / `commit-pr` / `commit-merge`:**
```
First stage these files: src/foo.ts, src/bar.ts

Then use /commit-push-pr with this commit message:
fix: resolve authentication bug

Added proper token validation to the middleware
```

**For `push` only:** "Push the current branch to the remote."
**For `merge` only:** "Merge the current branch into {targetBranch} and clean up."
**For `create-pr`:** "Push and create a PR with title: '...' body: '...'"

The key advantage: Claude Code's `/commit` and `/commit-push-pr` skills automatically handle pre-commit hook failures — they fix issues, re-stage, and retry without user intervention.

### 3. Progress Feedback

Since the workflow is now handled by the agent's chat stream (not `git:workflow_progress` WS events), the commit progress modal won't apply for agent-delegated commits. Instead:

- Show a toast saying the commit task was sent to the agent.
- The user sees the agent working in the chat view (messages streaming with tool calls).
- After the agent completes, git status auto-refreshes via existing `git:status` WS events.

The existing workflow progress system remains for project-mode commits (no change).

### 4. UI State

- Clear `actionInProgress` immediately after `sendMessage` succeeds (the agent takes over).
- Clear commit title/body draft on success (same as current behavior).
- No need to change progress store — it simply won't be triggered for agent commits.

## Summary of Files Changed

| File | Change |
|------|--------|
| `packages/client/src/components/ReviewPane.tsx` | Modify `handleCommitAction`, `handlePushOnly`, `handleMergeOnly`, `handleCreatePROnly` to use `api.sendMessage()` when `effectiveThreadId` exists. Add `buildAgentCommitPrompt()` helper. |

## What Stays the Same

- Project-mode commits (no thread) — unchanged, still uses `git-workflow-service`
- Server-side `git-workflow-service.ts` — unchanged
- Server-side routes — unchanged
- WebSocket workflow progress — unchanged (still used for project-mode)
- Commit progress store/modal — unchanged (just won't be triggered for agent commits)
- All other git operations (stage, unstage, revert, diff) — unchanged

## Risks & Mitigations

1. **Agent might not be running**: `sendMessage` will start a new agent session if needed. This works the same as typing a message in the chat.
2. **Agent might be busy**: The message will either interrupt or queue based on project `followUpMode`. Same behavior as the existing `handleAskAgentResolve`.
3. **Slash commands are reliable**: `/commit` and `/commit-push-pr` are built-in Claude Code skills, not freeform prompts — they follow a well-defined workflow internally.
