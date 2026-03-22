/**
 * BaseAgentProcess — abstract base class for all provider adapters.
 *
 * Extracts the common lifecycle boilerplate shared by SDKClaudeProcess,
 * CodexProcess, and GeminiACPProcess:
 *
 *   - AbortController + _exited flag
 *   - start() → runProcess() error wrapper
 *   - kill() with abort
 *   - Helper methods for emitting CLIMessage (init, result, error)
 *   - finalize() for consistent cleanup
 *
 * Each provider extends this and implements `runProcess()` with its
 * SDK-specific logic. Override `kill()` for provider-specific cleanup
 * (e.g., killing a child process).
 */

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

import type {
  CLIMessage,
  CLISystemMessage,
  CLIResultMessage,
  ClaudeProcessOptions,
} from './types.js';

export type ResultSubtype =
  | 'success'
  | 'error_max_turns'
  | 'error_during_execution'
  | 'error_max_budget_usd';

export abstract class BaseAgentProcess extends EventEmitter {
  protected abortController = new AbortController();
  protected _exited = false;

  constructor(protected options: ClaudeProcessOptions) {
    super();
  }

  // ── IAgentProcess API (shared) ──────────────────────────────────

  start(): void {
    this.runProcess().catch((err) => {
      if (!this._exited) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async kill(): Promise<void> {
    this.abortController.abort();
  }

  get exited(): boolean {
    return this._exited;
  }

  // ── Protected helpers ───────────────────────────────────────────

  /** Whether the abort signal has been triggered. */
  protected get isAborted(): boolean {
    return this.abortController.signal.aborted;
  }

  /** Provider-specific run loop. Implement in subclass. */
  protected abstract runProcess(): Promise<void>;

  /** Emit a system:init CLIMessage. */
  protected emitInit(sessionId: string, tools: string[], model: string, cwd: string): void {
    const msg: CLISystemMessage = {
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      tools,
      model,
      cwd,
    };
    this.emit('message', msg);
  }

  /** Emit a result CLIMessage. */
  protected emitResult(params: {
    sessionId: string;
    subtype: ResultSubtype;
    startTime: number;
    numTurns: number;
    totalCost: number;
    result?: string;
    errors?: string[];
  }): void {
    const msg: CLIResultMessage = {
      type: 'result',
      subtype: params.subtype,
      is_error: params.subtype !== 'success',
      duration_ms: Date.now() - params.startTime,
      num_turns: params.numTurns,
      result: params.result,
      total_cost_usd: params.totalCost,
      session_id: params.sessionId,
      ...(params.errors ? { errors: params.errors } : {}),
    };
    this.emit('message', msg);
  }

  /**
   * Emit a provider error as a tool_use + tool_result pair so it renders
   * as a collapsible tool card in the UI with full history.
   */
  protected emitErrorToolCall(errorText: string): void {
    const toolCallId = randomUUID();
    // tool_use (assistant)
    this.emit('message', {
      type: 'assistant',
      message: {
        id: randomUUID(),
        content: [
          {
            type: 'tool_use',
            id: toolCallId,
            name: 'ProviderError',
            input: { error: errorText },
          },
        ],
      },
    } as CLIMessage);
    // tool_result (user) — mark as error
    this.emit('message', {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolCallId,
            content: errorText,
            is_error: true,
          },
        ],
      },
    } as CLIMessage);
  }

  /**
   * Extract a human-readable error message from an ACP RequestError or
   * generic Error. ACP RequestError objects carry a `.data.details` field
   * with the actionable message, while `.message` is just "Internal error".
   *
   * The raw `details` string often contains the full API error dump including
   * JSON metadata (quota violations, retry info, etc.). We extract just the
   * human-readable parts so the UI shows a clean message.
   */
  protected extractErrorMessage(err: unknown): string {
    if (err == null) return 'Unknown error';
    if (typeof err === 'string') return this.cleanErrorDetails(err);
    if (typeof err !== 'object') return String(err);

    const e = err as Record<string, unknown>;
    const base = typeof e.message === 'string' ? e.message : String(err);

    // ACP RequestError: { code, message, data: { details } }
    if (e.data && typeof e.data === 'object') {
      const details = (e.data as Record<string, unknown>).details;
      if (typeof details === 'string') {
        return this.cleanErrorDetails(details);
      }
    }

    return base;
  }

  /**
   * Clean up raw error details by extracting the human-readable parts
   * and stripping JSON metadata blobs, "For more information" boilerplate, etc.
   */
  private cleanErrorDetails(raw: string): string {
    let cleaned = raw
      // Strip trailing JSON array blobs like [{...},{...}] that APIs append
      .replace(/\s*\[\{[^]*\}\]\s*$/, '')
      // Strip "For more information..." / "To monitor..." boilerplate sentences
      .replace(/\.\s*For more information[^.]*\./gi, '.')
      .replace(/\.\s*To monitor[^.]*\./gi, '.')
      .trim();

    // Extract the main error line and any "Please retry" / quota info
    const lines = cleaned
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return raw;

    const mainLine = lines[0];
    const retryLine = lines.find((l) => /please retry in/i.test(l));
    const quotaLine = lines.find((l) => /quota exceeded/i.test(l));

    const parts = [mainLine];
    if (quotaLine && quotaLine !== mainLine) parts.push(quotaLine);
    if (retryLine && retryLine !== mainLine) parts.push(retryLine);

    return parts.join('\n');
  }

  /**
   * Parse stderr output and extract actionable error messages.
   * Returns a formatted error string if an error is found, null otherwise.
   *
   * Handles:
   * - ACP JSON-RPC errors with `data.details` (rate limits, auth failures)
   * - Generic "[Provider Error]:" patterns
   */
  protected parseStderrError(raw: string): string | null {
    // ACP JSON-RPC error pattern: "Error handling request ... { code, message, data: { details } }"
    const detailsMatch = raw.match(/details:\s*'([\s\S]*?)'\s*\n?\s*\}/);
    if (detailsMatch) {
      const details = detailsMatch[1];
      const firstLine = details.split('\n')[0].trim();
      const retryMatch = details.match(/Please retry in ([\d.]+s)/);
      const retryInfo = retryMatch ? `\n\nRetry in ${retryMatch[1]}.` : '';
      return `**Error from provider:** ${firstLine}${retryInfo}`;
    }

    // Generic error lines (e.g., "[GoogleGenerativeAI Error]: ...")
    const errorLineMatch = raw.match(/\[(\w+) Error\]:\s*(.*)/);
    if (errorLineMatch) {
      return `**Error from provider:** ${errorLineMatch[0].trim()}`;
    }

    // If it contains "error" (case-insensitive) and looks like an actual error, surface it
    if (/\berror\b/i.test(raw) && raw.length < 2000) {
      return `**Provider stderr:** ${raw}`;
    }

    return null;
  }

  /**
   * Mark the process as exited and emit the 'exit' event.
   * Call this in the `finally` block of `runProcess()`.
   */
  protected finalize(): void {
    this._exited = true;
    this.emit('exit', this.isAborted ? null : 0);
  }
}
