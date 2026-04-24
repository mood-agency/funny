/**
 * CodexProcess — adapter that wraps @openai/codex-sdk behind the
 * IAgentProcess EventEmitter interface.
 *
 * Translates Codex SDK events into CLIMessage format so that
 * AgentMessageHandler works unchanged (same as SDKClaudeProcess).
 *
 * Uses dynamic import so the server doesn't crash if @openai/codex-sdk
 * is not installed.
 */

import { randomUUID } from 'crypto';

import { BaseAgentProcess } from './base-process.js';
import type { CLIMessage } from './types.js';

// Lazy-loaded SDK types (avoid crash if not installed)
type CodexSDK = typeof import('@openai/codex-sdk');
type CodexInstance = import('@openai/codex-sdk').Codex;
type CodexThread = Awaited<ReturnType<CodexInstance['startThread']>>;

export class CodexProcess extends BaseAgentProcess {
  private threadId: string | null = null;

  // ── Provider-specific run loop ─────────────────────────────────

  protected async runProcess(): Promise<void> {
    // Dynamic import — fails gracefully if SDK not installed
    let SDK: CodexSDK;
    try {
      SDK = await import('@openai/codex-sdk');
    } catch {
      throw new Error('Codex SDK not installed. Run: npm install @openai/codex-sdk');
    }

    const { Codex } = SDK;

    const codexConfig: Record<string, any> = {};
    if (this.options.model) {
      codexConfig.model = this.options.model;
    }

    const codex = new Codex({ config: codexConfig });

    // Map effort level to Codex SDK's modelReasoningEffort values
    const effortMap: Record<string, string> = {
      low: 'low',
      medium: 'medium',
      high: 'high',
    };
    const modelReasoningEffort = this.options.effort
      ? (effortMap[this.options.effort] ?? 'high')
      : undefined;

    // Start or resume a thread
    let thread: CodexThread;
    const isResume = !!this.options.sessionId;

    const threadOpts: Record<string, any> = {
      workingDirectory: this.options.cwd,
      skipGitRepoCheck: true,
      ...(modelReasoningEffort && { modelReasoningEffort }),
    };

    if (isResume) {
      thread = codex.resumeThread(this.options.sessionId!, threadOpts);
    } else {
      thread = codex.startThread(threadOpts);
    }

    // Session ID is assigned by Codex on first run (emitted via `thread.started`).
    // For resumes we already have it; for new threads we wait for the event
    // before emitting init so the persisted sessionId matches what Codex wrote
    // to ~/.codex/sessions (otherwise resumeThread fails with
    // "state db missing rollout path for thread ...").
    let sessionId = this.options.sessionId ?? null;
    let initEmitted = false;
    const emitInitOnce = (id: string) => {
      if (initEmitted) return;
      sessionId = id;
      this.threadId = id;
      this.emitInit(id, [], this.options.model ?? 'gpt-5.4', this.options.cwd);
      initEmitted = true;
    };
    if (sessionId) emitInitOnce(sessionId);

    const startTime = Date.now();
    let totalCost = 0;
    let numTurns = 0;
    let lastResult = '';
    const assistantMsgId = randomUUID();

    try {
      const { events } = await thread.runStreamed(this.options.prompt);

      for await (const event of events) {
        if (this.isAborted) break;

        switch (event.type) {
          case 'thread.started': {
            const id = (event as any).thread_id;
            if (id) emitInitOnce(id);
            break;
          }

          case 'item.completed': {
            const item = (event as any).item;
            if (!item) break;

            // Translate Codex items to CLIMessage format
            const cliMsg = this.translateItem(item, assistantMsgId);
            if (cliMsg) {
              this.emit('message', cliMsg);
            }

            // Extract text for the final result
            if (
              item.type === 'agent_message' ||
              (item.type === 'message' && item.role === 'assistant')
            ) {
              const text = this.extractText(item);
              if (text) lastResult = text;
            }
            break;
          }

          case 'turn.completed': {
            numTurns++;
            const usage = (event as any).usage;
            if (usage) {
              // Estimate cost based on token usage (rough approximation)
              const inputTokens = usage.input_tokens ?? 0;
              const outputTokens = usage.output_tokens ?? 0;
              // Codex pricing is similar to GPT-4o class
              totalCost += (inputTokens * 0.0025 + outputTokens * 0.01) / 1000;
            }
            break;
          }
        }
      }

      // Fallback: if we never saw `thread.started` (older SDK), read the id
      // off the Thread instance which is populated after the first turn.
      if (!initEmitted) {
        const id = (thread as any).id ?? randomUUID();
        emitInitOnce(id);
      }

      // Emit success result
      this.emitResult({
        sessionId: sessionId!,
        subtype: 'success',
        startTime,
        numTurns,
        totalCost,
        result: lastResult || undefined,
      });
    } catch (err: any) {
      if (!this.isAborted) {
        if (!initEmitted) {
          const id = (thread as any).id ?? randomUUID();
          emitInitOnce(id);
        }
        this.emitResult({
          sessionId: sessionId!,
          subtype: 'error_during_execution',
          startTime,
          numTurns,
          totalCost,
          result: err.message,
          errors: [err.message],
        });
      }
    } finally {
      this.finalize();
    }
  }

  // ── Item translation ──────────────────────────────────────────

  private translateItem(item: any, assistantMsgId: string): CLIMessage | null {
    if (!item) return null;

    // Assistant message with text (codex-sdk emits `agent_message`;
    // keep the legacy `message` + role shape for older SDK/response variants)
    if (item.type === 'agent_message' || (item.type === 'message' && item.role === 'assistant')) {
      const text = this.extractText(item);
      if (!text) return null;

      return {
        type: 'assistant',
        message: {
          id: assistantMsgId,
          content: [{ type: 'text', text }],
        },
      };
    }

    // Function/tool call
    if (item.type === 'function_call' || item.type === 'tool_call') {
      const toolUseId = item.id ?? item.call_id ?? randomUUID();
      const name = item.name ?? item.function?.name ?? 'unknown';
      let input: unknown = {};

      try {
        const args = item.arguments ?? item.function?.arguments;
        input = typeof args === 'string' ? JSON.parse(args) : (args ?? {});
      } catch {
        input = { raw: item.arguments ?? '' };
      }

      // Emit as assistant message with tool_use block
      return {
        type: 'assistant',
        message: {
          id: randomUUID(),
          content: [{ type: 'tool_use', id: toolUseId, name, input }],
        },
      };
    }

    // Function/tool call output
    if (item.type === 'function_call_output' || item.type === 'tool_result') {
      const toolUseId = item.call_id ?? item.tool_use_id ?? '';
      const output =
        typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');

      return {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: output,
            },
          ],
        },
      };
    }

    return null;
  }

  /** Extract text content from a Codex message item. */
  private extractText(item: any): string | null {
    // codex-sdk AgentMessageItem: { type: 'agent_message', text: string }
    if (typeof item.text === 'string' && item.text.length > 0) return item.text;
    if (typeof item.content === 'string') return item.content;
    if (Array.isArray(item.content)) {
      const texts = item.content
        .filter((c: any) => c.type === 'output_text' || c.type === 'text')
        .map((c: any) => c.text ?? c.content ?? '')
        .filter(Boolean);
      return texts.length > 0 ? texts.join('\n\n') : null;
    }
    return null;
  }
}
