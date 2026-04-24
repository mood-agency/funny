# Architecture Evaluation Report

**Project:** funny — Claude Agent orchestration UI (Bun monorepo)
**Date:** 2026-04-24 (update; supersedes the 2026-04-23 report)
**Evaluation scope:** All `packages/*` excluding `chrome-extension`, `native-git`, `api-acp` (focus on the core five + `agent`/`pipelines`/`memory`).
**Methodology:** ATAM + SAAM-inspired, ISO 25010 attributes, coupling/instability metrics. Delta-focused against the 2026-04-23 baseline.

---

## 1. Executive Summary

One-day delta: **the shape is still good, the mass is getting worse.**

Package boundaries remain clean — `server` does not import `runtime`, `core` does not import Hono/Drizzle, `shared` stays at its foundation position. The agent-provider registry and the split server/runner architecture continue to do real work and were not dented by the week's feature commits (submodule stats, Project Files pane, PR tab redesign, publish-dialog remote URL tab, org-scoped GitHub search, security hardening).

What has measurably regressed in 24 hours:

- `client/components/ReviewPane.tsx`: **3035 → 3448 lines (+14%)**.
- `runtime/routes/git.ts`: **2180 → 2323 lines (+7%)**.
- A **new hotspot** has emerged that the prior report missed: `runtime/routes/github.ts` at **1857 lines**.
- The ">1000-line file" population in `packages/client` is now **12+ files** (CommitHistoryTab, ProjectHeader, PromptInputUI, TestDetailTabs, thread-store, ExpandedDiffDialog, PromptEditor, AgentTemplateSettings, SettingsDetailView, TerminalPanel, plus the three already called out). Yesterday's "concentrated mass in a handful of files" reads more like a systemic client-layer trend today.

On the positive side, **`neverthrow` adoption has ~3×'d in a day**: `Result<>` call-sites rose from ~37 to 115 and the number of files importing `neverthrow` reached 65. Try/catch is still dominant (624 blocks) but the direction of travel has reversed.

Top three actions remain: (1) land a `dependency-cruiser` + file-size fitness function in CI so the file-size trend can't keep drifting unobserved, (2) decompose `ReviewPane.tsx` and the `git.ts` / `github.ts` routers before any further feature lands on them, (3) scope the `neverthrow` mandate to specific modules so the 3× momentum doesn't stall.

---

## 2. Architecture Overview (unchanged)

- **Project type:** Local-first web app + remote-runner multi-tenant mode; Tauri desktop build; `bunx funny` CLI.
- **Stack:** TypeScript + Bun, Hono, Drizzle ORM + SQLite/PG, React 19 + Vite + Zustand + shadcn/ui, Socket.IO, `@anthropic-ai/claude-agent-sdk`, Playwright.
- **Style:** **Modular monolith with a detachable runner.** Data-plane: `Client → Server → Runner` over WS tunnel.
- **Verified package graph (2026-04-24):**

```
shared ──────────────────────────────────┐
   │ (types, errors, auth, runner-protocol, thread-machine, db schema)
   ▼
core ────────────────────────────────────┤  ← uses @funny/native-git
   │ (git/*, agents/*, containers/*, ports/*, symbols/*)
   ▼                                       │
runtime ──→ core + shared + pipelines + memory
   │ (Hono routes, agent-runner, pty-*, ws-broker, automation-*)
   │
server ───→ core + shared                  (still NEVER → runtime ✓)
   │ (auth, DB, project-manager, runner-manager, socketio hub, ws-tunnel)
   ▼
client ───→ shared only
   │ (React 19 SPA; /api + /ws to the server)
```

Guardrails spot-checked today: zero matches for `@funny/runtime` imports from `packages/server/src`, zero `hono`/`drizzle` imports from `packages/core/src`, zero `@funny/core` or `@funny/runtime` imports from `packages/shared/src`. The only layer exception remains `shared → @funny/evflow`, documented previously.

---

## 3. Quality Attribute Scorecard

| Attribute       | Score (prev) | Trend | Key finding |
|-----------------|:-----------:|:----:|-------------|
| Modifiability   | **2/5** (was 3/5) | ↓  | The fat-file population grew and got fatter; SRP score drops pulls modifiability with it. |
| Performance     | 3/5          | →  | No obvious N+1; `perf(runtime)` commit added user-projects caching and fixed a WS reconnect race. `ws-broker` still a single multiplexed stream — pragmatic, worth a metric. |
| Testability     | 3/5          | →  | Backend 48+15 test files (runtime+server), core 14, shared 9, agent 15; client stays at 35 tests across 387 source files (~9%). Zero direct coverage on `ReviewPane`/`VirtualDiff`. |
| Deployability   | 4/5          | →  | Server/runner separation intact; single `bunx funny` entry; WS tunnel supports NAT. |
| Security        | 4/5          | →  | Full audit pass landed (`a196855e`). Per-user runner isolation still enforced; AES-GCM token encryption in place. New recommendation: revisit `runtime/routes/github.ts` surface now that it's ~1857 lines — concentrated auth-sensitive code. |
| Reliability     | 3/5          | ↑  | `neverthrow` adoption tripling is a real improvement; WS broker remains a single coordination point. |

**Overall Architecture Health: 3.2 / 5** (was 3.3). The downgrade is entirely driven by Modifiability regressing as the client fat-file set grew.

---

## 4. Dependency Analysis

### 4.1 Package dependency graph

Still **acyclic**, verified from `package.json` workspace links:

| Package  | Imports (excl. self) |
|----------|----------------------|
| shared   | evflow |
| core     | native-git, shared |
| runtime  | core, memory, pipelines, shared |
| server   | core, shared |
| client   | shared |
| agent    | core, sdk, shared (+ orchestrator) |
| reviewbot| core, sdk, shared |
| pipelines| — (leaf) |

### 4.2 Coupling metrics (file counts refreshed)

| Package   | Ce | Ca | I = Ce/(Ce+Ca) | Files | Tests | Notes |
|-----------|:--:|:--:|:--------------:|:----:|:----:|-------|
| shared    | 1  | 5  | 0.17 | 36  |  9 | Correct foundation. |
| core      | 2  | 4  | 0.33 | 70  | 14 | Pure logic; no HTTP/DB. |
| runtime   | 4  | 1  | 0.80 | 171 | 48 | Correctly high-I consumer. |
| server    | 2  | 0  | 1.00 | 62  | 15 | Terminal layer. |
| client    | 1  | 0  | 1.00 | 387 | 35 | Terminal layer; **heaviest file mass in the repo.** |
| agent     | 3  | 0  | 1.00 | 50  | 15 | Terminal extension. |
| pipelines | 0  | 1  | 0.00 | 4   |  1 | Leaf. |

Numbers are stable at the package seam. The change is entirely **intra-package mass** in `client` and `runtime`.

### 4.3 Circular dependencies

**None detected at the package level.** File-level cycles inside `runtime/src/services` and `client/src/components` still unverified — `madge --circular` in CI remains an open, unaddressed fitness function.

### 4.4 Blast radius (refreshed)

| Module | Lines | Δ vs 2026-04-23 | Blast radius | Why |
|--------|------:|----------------:|--------------|-----|
| `shared/src/types.ts` | 1897 | — | **Very High** | Types used in every package. |
| `client/components/ReviewPane.tsx` | **3448** | **+413** | **Very High (was High)** | Single-file UI owner for stage/unstage/commit/push/PR; co-edit magnet. |
| `runtime/routes/git.ts` | **2323** | **+143** | **High** | Any non-trivial git route lands here. |
| `client/components/VirtualDiff.tsx` | 2015 | — | **High** | Diff-render hot path. |
| `runtime/routes/github.ts` | **1857** | — (newly surfaced) | **High** | GitHub CLI surface, auth-sensitive. |
| `client/lib/api.ts` | 1766 | +87 | **Medium-High** | Client-side route facade for the whole API. |
| `runtime/services/thread-service.ts` | 1456 | 0 | **High** | Orchestrator touching DB + ws-broker + agent-runner. |
| `shared/src/runner-protocol.ts` | 401 | +21 | **High** | Contract across the WS tunnel. |
| `runtime/services/team-client.ts` | 1193 | 0 | **Medium-High** | Runner↔server client. |

---

## 5. Design Principle Adherence

| Principle | Score (prev) | Notable violations |
|-----------|:------------:|--------------------|
| SRP | **1/5** (was 2/5) | 12+ client files >1000 lines; `ReviewPane.tsx` (3448) and `git.ts` (2323) grew in the last 24h. `github.ts` (1857) surfaced as a new multi-responsibility router. |
| OCP | 4/5 | Agent registry (`registerProvider`) remains genuinely extensible. |
| DIP | 4/5 | `core/src/ports/` abstractions + two `RuntimeServiceProvider` implementations (local SQLite / remote-over-WS) still stand. |
| ISP | 3/5 | Handlers still take the full `RuntimeServiceProvider` rather than narrow sub-ports. |
| Law of Demeter | 3/5 | Fat React components reach into Zustand store shape; `thread-store.ts` (1134) is a new hub. |
| Contracts | 5/5 | `WSEvent` discriminated union + `runner-protocol.ts` remain explicit and exhaustive. |

---

## 6. Findings

### CRITICAL

_None._ No layering violations, no new cycles, per-user runner isolation enforced, WS tunnel contract typed end-to-end.

### HIGH

- **Fat-file regression is measurable day-over-day.** `ReviewPane.tsx` +413 lines and `git.ts` +143 lines in one day means feature work is still piling onto the hottest files. This is the single biggest architectural risk because it directly undermines the product's own value prop (parallel agents on worktrees → merge conflicts). **Recommendation:** block further feature commits on these files until they're decomposed; decompose `ReviewPane` into `DiffList`/`DiffPanel`/`StagingBar`/`CommitBox`/`PRActions` and split `routes/git.ts` into domain sub-routers.
- **New hotspot surfaced: `runtime/routes/github.ts` (1857 lines).** GitHub CLI integration is auth-sensitive and was not called out in yesterday's report; at this size it is a review/audit bottleneck. **Recommendation:** split by verb — `github/pr.ts`, `github/search.ts`, `github/repo.ts`, `github/auth.ts`. Do this before adding any more GH features.
- **No fitness functions in CI yet.** The #1 quick-win from the 2026-04-23 report (dependency-cruiser + file-size ceiling) has not landed. Without it, the file-size trend above will continue unobserved. **Recommendation:** land a minimal `dependency-cruiser` config this week covering (a) package-layer rules, (b) a 1500-line ceiling with an explicit waiver list.
- **Client test coverage unchanged at ~9%** while client source grew. No tests directly cover `ReviewPane` or `VirtualDiff` despite their blast radius.

### MEDIUM

- **`neverthrow` adoption is now real but uneven.** 115 `Result<>` call-sites across 65 files, vs 624 try/catch + 264 raw `throw`. The direction is right; the policy in CLAUDE.md is still too broad to guide the next reviewer. **Recommendation:** scope it — "`core/**` must return `Result`; runtime services must return `Result` at service-method boundaries; Hono handlers may throw as the outer boundary." Put this in CLAUDE.md and in a lint rule.
- **Service Locator (`getServices()`) still in use.** Global-style access keeps new services easy to wire but hard to unit-test without mutating a singleton.
- **Aggregated `RuntimeServiceProvider`.** Consumers pay full dependency weight for narrow needs.
- **WS broker single multiplexed stream.** Client-side filtering scales until it doesn't; add a `threadId`-cardinality metric.

### LOW

- **`shared/src/types.ts` at 1897 lines.** Cross-package contract file; large by nature but a candidate for splitting by domain (`types/git.ts`, `types/thread.ts`, `types/ws.ts`).
- **`packages/server/:memory:` exists as a stray file/dir** in `git status`. Appears to be a SQLite in-memory URI mis-interpreted as a path. Worth a quick gitignore or cleanup — not architectural, but cosmetic.
- **No formal architecture doc pinning ownership.** The package boundaries are correct; they just aren't codified anywhere a reviewer would catch regressions.

---

## 7. Tradeoff Analysis

| Decision | Benefits | Costs | Aligned? |
|----------|----------|-------|----------|
| Always split server/runner | Real multi-tenant, NAT-friendly, clear trust boundary | Extra WS hop, duplicated routes, dual-process dev ergonomics | **Yes** — core product constraint. |
| Single multiplexed `/ws` | Simple broker, single reconnect path | Client-side filter, no per-thread backpressure | **Partially** — add a metric before scale. |
| Runtime has its own SQLite | Session/PTY survives restart in remote-runner mode | Two DBs to reason about, some duplication | **Yes** — required for remote-runner session resumption. |
| Service Locator pattern | Fast to wire | Hidden deps, harder unit testing | **Partially** — fine early, friction later. |
| `throw` + documented `neverthrow` policy | Pragmatic for Hono handlers | Policy vs reality gap still confuses contributors | **Moving the right way** (3× adoption in a day), but the policy text is still too broad. |
| Let fat files grow while iterating | Fastest feature throughput | Merge-conflict multiplier — ironic given worktree UX | **No** — trajectory is now clearly negative. |

---

## 8. Recommendations (Prioritized)

### Quick Wins (low effort, high impact)

1. **Land `dependency-cruiser` this week.** Encode: `server → runtime` forbidden; `core` must not import `hono`/`drizzle`; `shared` must not import `@funny/core` or `@funny/runtime`; files >1500 lines require an explicit waiver-list entry. This one change halts the file-size trend at the PR gate.
2. **Split `packages/client/src/lib/api.ts`** into `api/{projects,threads,git,github,automation,...}.ts`. Mechanical, no semantic change, removes a co-edit hotspot.
3. **Add `madge --circular` on `runtime/src` and `client/src/components`** to catch file-level cycles the package-level check can't see.
4. **Scope the `neverthrow` mandate in CLAUDE.md** ("required in `core/**` and runtime service methods; route handlers may throw"). Cheap; preserves the 3× momentum.
5. **Add a `packages/server/:memory:` gitignore** (or remove the stray path). Minor hygiene.

### Strategic Improvements (higher effort, high impact)

1. **Decompose `ReviewPane.tsx` (3448)** into `DiffList`/`DiffPanel`/`StagingBar`/`CommitBox`/`PRActions`. Extract diff-math into a pure, testable module with unit tests before moving UI.
2. **Split `runtime/routes/git.ts` (2323)** into `git/{status,diff,stage,commit,push,remote,worktree}.ts`. Mirror in client API facade.
3. **Split `runtime/routes/github.ts` (1857)** into `github/{pr,search,repo,auth}.ts` — now, not after the next feature.
4. **Migrate `core/src/git/**` to `Result<T, GitError>` end-to-end.** Smallest surface, highest value, already isolated; build momentum for the broader `neverthrow` rollout.
5. **Introduce narrower service interfaces (ISP).** Handlers should take `Pick<RuntimeServiceProvider, 'threadEvents' | 'git'>` rather than the full provider.

### Long-term Refactoring (foundational)

1. **Retire the Service Locator for new services.** Constructor-inject dependencies so tests can substitute doubles without a global reset.
2. **Sharded WS broker** once concurrent-thread load justifies it.
3. **One-page package-boundary doc** codifying: what each package may import, owned route prefixes, owned DB tables. Pair with the dependency-cruiser config from quick-win #1.
4. **Split `shared/src/types.ts` (1897)** into domain files; blast radius stays high but diffs become readable.

---

## 9. Suggested Fitness Functions

Concrete CI-runnable checks — each maps to a finding above. Numbering preserved from the prior report so the "which of these have we actually landed" question stays trivially auditable.

| # | Check | Tool | Fails when | Status |
|---|-------|------|-----------|:------:|
| 1 | Package layering (`server` ⇸ `runtime`; `core` ⇸ `hono`/`drizzle`; `shared` ⇸ `core`/`runtime`) | `dependency-cruiser` | Forbidden edge appears | **Not landed** |
| 2 | No file-level cycles in `runtime/src` or `client/src/components` | `madge --circular` | Any cycle introduced | **Not landed** |
| 3 | Source file ≤1500 lines (explicit waiver list) | Custom / ESLint | A file crosses the threshold | **Not landed — now urgent** |
| 4 | `shared` Ce ≤ 1 | Import-graph script | New `@funny/*` import added to shared | Not landed |
| 5 | `WSEvent` exhaustive handling | TS `never`-check in ws-broker | New event variant unhandled | Already enforced at type level |
| 6 | `core/src/git/**` returns `Result` (no `throw`) | ESLint scoped `no-throw-literal` | `throw` appears under `core/src/git` | Not landed |
| 7 | Interactive elements carry `data-testid` | ESLint/custom AST | Button/Input added without attribute (CLAUDE.md rule) | Not landed |
| 8 | All WS events carry `threadId` | TS type | Covered | Enforced |
| 9 | Runner-auth header on `/api/runner/*` | Custom route-audit | Route added without auth middleware | Not landed |
| 10 | **[New]** File-growth budget: no PR may add >100 lines to a file already over 1500 lines | Custom git-diff check | Violated | Not landed |

---

**Evaluator's note.** The architecture is structurally the same one evaluated yesterday and it is still in good shape. The new data point is that *inside those correct boundaries, the client and runtime-route layers grew measurable mass in 24 hours* — and the specific recommendation to guard that with CI was not acted on. This is a management/process signal more than a technical one: the architecture's shape is defended by nothing but reviewer attention, and reviewer attention is losing against feature velocity. Land fitness function #3 (file-size ceiling) and #10 (growth budget) first; everything else in this report can wait a week.
