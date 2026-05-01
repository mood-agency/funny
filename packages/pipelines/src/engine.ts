/**
 * Lightweight, function-based pipeline engine.
 *
 * Pipelines are sequences of named nodes. Each node is an async function
 * that receives context + AbortSignal and returns updated context.
 * Nodes can be conditionally skipped via guards.
 * A single optional loop boundary allows review→fix cycles.
 *
 * Zero dependencies — works in both server and client.
 */

// ── Types ────────────────────────────────────────────────────

/** A node function: receives context and signal, returns updated context. */
export type NodeFn<T> = (ctx: T, signal: AbortSignal) => T | Promise<T>;

/**
 * A guard function: returns true to run the node, false to skip.
 *
 * May return a Promise — useful when the predicate is backed by an async
 * expression engine (e.g. JSONata). The engine awaits the result.
 */
export type GuardFn<T> = (ctx: T) => boolean | Promise<boolean>;

/**
 * Per-node retry configuration. When a node throws, the engine will retry
 * it up to `maxAttempts` times, optionally invoking `beforeRetry` to
 * mutate context (e.g. spawn a fixer agent) and/or sleep `delayMs` between
 * attempts. Cancellation via AbortSignal short-circuits the retry loop.
 */
export interface NodeRetryConfig<T> {
  /**
   * Total max attempts (including the initial try). May be a number or a
   * function of context to allow ctx-driven configuration without losing
   * type safety.
   * Default behavior (no `retry`): a single attempt, identical to pre-retry
   * engine semantics.
   */
  maxAttempts: number | ((ctx: T) => number);
  /** Optional delay (ms) between attempts. Default: 0. */
  delayMs?: number | ((ctx: T) => number);
  /**
   * Optional predicate: only retry if it returns true. Useful to bail out
   * on permanent errors (e.g. auth failures) while retrying transient ones.
   * May return a Promise. Default: always retry until `maxAttempts` is reached.
   */
  shouldRetry?: (err: Error, ctx: T, attempt: number) => boolean | Promise<boolean>;
  /**
   * Hook invoked between attempts (after a failed attempt, before the next).
   * Receives the error, the context as it was when the node started, and
   * the attempt number that just failed. Return value becomes the context
   * for the next attempt — use this to spawn a fixer agent, log, or reset
   * state. Throwing here aborts the retry loop and fails the pipeline.
   */
  beforeRetry?: (err: Error, ctx: T, attempt: number) => T | Promise<T>;
}

/** A single pipeline node. */
export interface PipelineNode<T> {
  name: string;
  execute: NodeFn<T>;
  /** If provided and returns false, the node is skipped. */
  when?: GuardFn<T>;
  /** Optional retry configuration. If absent, the node runs exactly once. */
  retry?: NodeRetryConfig<T>;
}

/** Loop configuration — allows jumping back to a previous node. */
export interface PipelineLoop<T> {
  /** Name of the node to jump back to. */
  from: string;
  /** Return true to exit the loop, false to continue iterating. */
  until: GuardFn<T>;
  /** Maximum iterations before the pipeline fails. Default: 10. */
  maxIterations?: number;
}

/** A complete pipeline definition. */
export interface PipelineDefinition<T> {
  name: string;
  nodes: PipelineNode<T>[];
  loop?: PipelineLoop<T>;
}

/** State change notification types. */
export type PipelineStateKind = 'entering' | 'completed' | 'skipped' | 'error' | 'terminal';

/** Emitted when a node changes state. */
export interface PipelineStateChange<T> {
  kind: PipelineStateKind;
  nodeName: string;
  ctx: T;
  iteration: number;
  error?: string;
  /** For 'terminal': final outcome. */
  outcome?: PipelineOutcome;
}

/** Callback for state changes. */
export type OnStateChange<T> = (change: PipelineStateChange<T>) => void;

/** Options for runPipeline. */
export interface PipelineRunOptions<T> {
  signal?: AbortSignal;
  onStateChange?: OnStateChange<T>;
  /** Override maxIterations from the loop config. */
  maxIterations?: number;
}

/** Pipeline run outcome. */
export type PipelineOutcome = 'completed' | 'failed' | 'cancelled';

/** Result returned by runPipeline. */
export interface PipelineRunResult<T> {
  outcome: PipelineOutcome;
  ctx: T;
  error?: string;
  /** How many loop iterations completed. */
  iterations: number;
}

// ── Builder helpers ──────────────────────────────────────────

/** Create a pipeline node. */
export function node<T>(
  name: string,
  execute: NodeFn<T>,
  opts?: { when?: GuardFn<T>; retry?: NodeRetryConfig<T> },
): PipelineNode<T> {
  return { name, execute, when: opts?.when, retry: opts?.retry };
}

/**
 * Embed an entire pipeline as a single node in a parent pipeline.
 * The sub-pipeline runs inline (same context, same signal) with its own
 * loop and maxIterations. State changes are forwarded to the parent's
 * onStateChange callback with prefixed node names: "parentName.childName".
 */
export function subPipeline<T>(
  name: string,
  pipeline: PipelineDefinition<T>,
  opts?: { when?: GuardFn<T>; maxIterations?: number },
): PipelineNode<T> {
  const execute: NodeFn<T> = async (ctx, signal) => {
    // Run the sub-pipeline inline. We pass a custom onStateChange that
    // is picked up by the runtime via a symbol on the context.
    const result = await runPipeline(pipeline, ctx, {
      signal,
      maxIterations: opts?.maxIterations ?? pipeline.loop?.maxIterations,
      // The parent runtime's onStateChange is forwarded via the _subPipelineParent symbol.
      // We prefix node names so the parent can distinguish sub-pipeline nodes.
      onStateChange: (change) => {
        // Forward to parent's onStateChange if available via the runtime context
        const parentCb = (ctx as any)?.[SUB_PIPELINE_PARENT_CB];
        if (parentCb) {
          parentCb({
            ...change,
            nodeName: `${name}.${change.nodeName}`,
          });
        }
      },
    });

    if (result.outcome === 'failed') {
      throw new Error(result.error ?? `Sub-pipeline "${pipeline.name}" failed`);
    }
    if (result.outcome === 'cancelled') {
      throw new Error('Pipeline cancelled');
    }
    return result.ctx;
  };

  return { name, execute, when: opts?.when };
}

/** Symbol used internally to pass parent onStateChange to sub-pipelines. */
export const SUB_PIPELINE_PARENT_CB = Symbol.for('pipeline:parentStateChange');

/** Create a pipeline definition. */
export function definePipeline<T>(def: PipelineDefinition<T>): PipelineDefinition<T> {
  // Validate loop.from references an existing node
  if (def.loop) {
    const fromNode = def.nodes.find((n) => n.name === def.loop!.from);
    if (!fromNode) {
      throw new Error(
        `Pipeline "${def.name}": loop.from "${def.loop.from}" does not match any node name`,
      );
    }
  }
  return def;
}

/**
 * Compose multiple node arrays into a single flat node list.
 * Useful for building pipelines from reusable node groups.
 */
export function compose<T>(...groups: PipelineNode<T>[][]): PipelineNode<T>[] {
  return groups.flat();
}

// ── Runtime ──────────────────────────────────────────────────

/**
 * Execute a pipeline definition with the given initial context.
 *
 * The pipeline runs nodes sequentially. When all nodes complete and
 * a loop is defined, it checks loop.until(ctx). If false, it jumps
 * back to loop.from and increments the iteration counter.
 */
export async function runPipeline<T>(
  pipeline: PipelineDefinition<T>,
  initialCtx: T,
  opts: PipelineRunOptions<T> = {},
): Promise<PipelineRunResult<T>> {
  const { signal, onStateChange } = opts;
  const maxIter = opts.maxIterations ?? pipeline.loop?.maxIterations ?? 10;

  let ctx = initialCtx;
  let iteration = 1;

  const emit = (change: PipelineStateChange<T>) => onStateChange?.(change);

  // Attach onStateChange to context so sub-pipelines can forward events.
  // Use a shallow copy to avoid mutating the caller's context (which would
  // cause infinite recursion when a subPipeline's onStateChange overwrites
  // the parent's callback on the same object).
  if (onStateChange) {
    ctx = { ...ctx, [SUB_PIPELINE_PARENT_CB]: onStateChange } as T;
  }

  // Resolve loop start index
  const loopFromIndex = pipeline.loop
    ? pipeline.nodes.findIndex((n) => n.name === pipeline.loop!.from)
    : -1;

  // Start from the first node
  let nodeIndex = 0;

  while (nodeIndex < pipeline.nodes.length) {
    const currentNode = pipeline.nodes[nodeIndex];

    // Check cancellation
    if (signal?.aborted) {
      emit({ kind: 'terminal', nodeName: currentNode.name, ctx, iteration, outcome: 'cancelled' });
      return { outcome: 'cancelled', ctx, iterations: iteration };
    }

    // Check guard (may be async — await the result).
    if (currentNode.when) {
      const allow = await currentNode.when(ctx);
      if (!allow) {
        emit({ kind: 'skipped', nodeName: currentNode.name, ctx, iteration });
        nodeIndex++;
        continue;
      }
    }

    // Execute node — with retry support. When `retry` is undefined, the loop
    // runs exactly once, preserving pre-retry semantics.
    emit({ kind: 'entering', nodeName: currentNode.name, ctx, iteration });

    const retryCfg = currentNode.retry;
    const maxAttempts = retryCfg
      ? Math.max(
          1,
          typeof retryCfg.maxAttempts === 'function'
            ? retryCfg.maxAttempts(ctx)
            : retryCfg.maxAttempts,
        )
      : 1;

    let attempt = 0;
    let lastError: Error | undefined;
    while (attempt < maxAttempts) {
      attempt++;
      try {
        ctx = await currentNode.execute(ctx, signal ?? new AbortController().signal);
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Cancellation always short-circuits, even if more attempts remain.
        if (signal?.aborted) break;

        if (!retryCfg || attempt >= maxAttempts) break;
        if (retryCfg.shouldRetry) {
          const allowRetry = await retryCfg.shouldRetry(lastError, ctx, attempt);
          if (!allowRetry) break;
        }

        if (retryCfg.beforeRetry) {
          try {
            ctx = await retryCfg.beforeRetry(lastError, ctx, attempt);
          } catch (hookErr) {
            // beforeRetry threw — abort retry loop with the hook's error.
            lastError = hookErr instanceof Error ? hookErr : new Error(String(hookErr));
            break;
          }
        }

        const delay =
          typeof retryCfg.delayMs === 'function' ? retryCfg.delayMs(ctx) : (retryCfg.delayMs ?? 0);
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    if (lastError) {
      const errorMsg = lastError.message;
      emit({ kind: 'error', nodeName: currentNode.name, ctx, iteration, error: errorMsg });
      emit({
        kind: 'terminal',
        nodeName: currentNode.name,
        ctx,
        iteration,
        error: errorMsg,
        outcome: 'failed',
      });
      return { outcome: 'failed', ctx, error: errorMsg, iterations: iteration };
    }

    emit({ kind: 'completed', nodeName: currentNode.name, ctx, iteration });

    nodeIndex++;

    // Check for loop boundary — after the last node
    if (nodeIndex >= pipeline.nodes.length && pipeline.loop && loopFromIndex >= 0) {
      const exit = await pipeline.loop.until(ctx);
      if (!exit) {
        iteration++;
        if (iteration > maxIter) {
          const errorMsg = `Max iterations reached (${maxIter})`;
          emit({
            kind: 'terminal',
            nodeName: currentNode.name,
            ctx,
            iteration: iteration - 1,
            error: errorMsg,
            outcome: 'failed',
          });
          return { outcome: 'failed', ctx, error: errorMsg, iterations: iteration - 1 };
        }
        // Jump back to loop start
        nodeIndex = loopFromIndex;
        continue;
      }
    }
  }

  // All nodes completed, loop exited (or no loop)
  const lastNode = pipeline.nodes[pipeline.nodes.length - 1];
  emit({
    kind: 'terminal',
    nodeName: lastNode?.name ?? pipeline.name,
    ctx,
    iteration,
    outcome: 'completed',
  });
  return { outcome: 'completed', ctx, iterations: iteration };
}
