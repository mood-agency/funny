# Architecture Fitness Functions

Automated checks that guard the architectural properties called out in `ARCHITECTURE_EVAL.md`. Run them in CI on every PR and locally with `bun run fitness`.

| Script | Enforces |
|--------|----------|
| `check-layering.ts` | `server` does not import `runtime`; `core` does not import `hono` or `drizzle-orm`; `shared` does not import `core` or `runtime`. |
| `check-circular.ts` | No file-level circular imports within `core/src`, `runtime/src`, `server/src`, `client/src`. |
| `check-file-size.ts` | No source file over 1500 lines, except files on the explicit waiver list (each with a decomposition target). |
| `check-file-growth.ts` | No file already over 1500 lines may grow by more than 100 net lines in a single PR. Compares HEAD against `origin/master` (or `$BASE_REF`). |

## Adding a waiver

Edit `check-file-size.ts` and add an entry to `WAIVERS` with `{ current, target, note }`. The PR description MUST link to a decomposition plan. Waivers are expected to shrink — `target < current` is the norm.

## CI wiring

Add to your PR workflow:

```yaml
- run: bun run fitness
```

Or individual checks:

```yaml
- run: bun run fitness:layering
- run: bun run fitness:size
- run: bun run fitness:circular
- run: BASE_REF=origin/${{ github.base_ref }} bun run fitness:growth
```
