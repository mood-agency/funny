/**
 * OpenSWEProcess — adapter that wraps a remote OpenSWE / LangGraph deployment
 * behind the IAgentProcess EventEmitter interface.
 *
 * Uses **plain HTTP fetch + SSE** to communicate with the LangGraph REST API.
 * No LangChain/LangGraph SDK dependency — funny stays fully decoupled from
 * LangChain internals.
 *
 * The LangGraph server URL is read from:
 *   - `opts.env.OPENSWE_URL`       (per-thread override)
 *   - `OPENSWE_URL` env var         (global default)
 *   - fallback: http://localhost:2024
 *
 * Configuration passed to the run's `configurable`:
 *   - `repo.owner` / `repo.name` — derived from the git remote of `opts.cwd`
 *   - `source: "funny"` — identifies the trigger channel
 */

import { randomUUID } from 'crypto';

import { BaseAgentProcess } from './base-process.js';
import type { CLIMessage } from './types.js';

export class OpenSWEProcess extends BaseAgentProcess {
  private runId: string | null = null;
  private threadId: string | null = null;
  private baseUrl: string = '';

  private getBaseUrl(): string {
    return this.options.env?.OPENSWE_URL ?? process.env.OPENSWE_URL ?? 'http://localhost:2024';
  }

  protected async runProcess(): Promise<void> {
    this.baseUrl = this.getBaseUrl();

    // Parse repo info from cwd (best-effort)
    const repoConfig = await this.detectRepoConfig();

    const sessionId = this.options.sessionId ?? randomUUID();
    this.threadId = sessionId;

    // Emit init message
    this.emitInit(sessionId, [], this.options.model ?? 'openswe-default', this.options.cwd);

    const startTime = Date.now();
    let numTurns = 0;
    let lastResult = '';

    try {
      // 1. Create or reuse a LangGraph thread
      const thread = await this.createThread(sessionId);
      this.threadId = thread.thread_id;

      const configurable: Record<string, unknown> = {
        source: 'funny',
        repo: repoConfig,
        funny_thread_id: (this.options as any).threadId,
      };

      // 2. Stream the run via SSE
      const response = await fetch(`${this.baseUrl}/threads/${thread.thread_id}/runs/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistant_id: 'agent',
          input: { messages: [{ role: 'user', content: this.options.prompt }] },
          config: { configurable },
          stream_mode: ['messages-tuple', 'updates'],
          multitask_strategy: 'interrupt',
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenSWE server returned ${response.status}: ${errorText}`);
      }

      if (!response.body) {
        throw new Error('OpenSWE server returned no response body');
      }

      // 3. Parse the SSE stream
      for await (const { event, data } of this.parseSSE(response.body)) {
        if (this.isAborted) break;

        switch (event) {
          case 'metadata': {
            if (data.run_id) this.runId = data.run_id;
            break;
          }

          case 'messages': {
            // messages-tuple mode: data is [message, metadata]
            const [message] = data as [LangGraphMessage, unknown];
            const cliMsg = this.translateMessage(message);
            if (cliMsg) {
              this.emit('message', cliMsg);
            }
            break;
          }

          case 'updates': {
            // Updates carry node execution results — count as turns
            if (data && typeof data === 'object') {
              numTurns++;
              for (const [nodeName, nodeOutput] of Object.entries(data)) {
                if (nodeName === '__end__') continue;
                const messages = (nodeOutput as any)?.messages;
                if (Array.isArray(messages)) {
                  for (const msg of messages) {
                    if (msg.type === 'ai' || msg.role === 'assistant') {
                      const text = this.extractMessageText(msg);
                      if (text) lastResult = text;
                    }
                  }
                }
              }
            }
            break;
          }

          case 'error': {
            const errorText = data.message || data.error || 'Unknown OpenSWE error';
            this.emitErrorToolCall(errorText);
            break;
          }
        }
      }

      // Emit success result
      this.emitResult({
        sessionId,
        subtype: 'success',
        startTime,
        numTurns,
        totalCost: 0,
        result: lastResult || undefined,
      });
    } catch (err: any) {
      if (!this.isAborted) {
        const errorMsg = this.extractErrorMessage(err);
        this.emitErrorToolCall(errorMsg);
        this.emitResult({
          sessionId,
          subtype: 'error_during_execution',
          startTime,
          numTurns,
          totalCost: 0,
          result: errorMsg,
          errors: [errorMsg],
        });
      }
    } finally {
      this.finalize();
    }
  }

  override async kill(): Promise<void> {
    // Cancel the run on the LangGraph server if possible
    if (this.runId && this.threadId) {
      try {
        const url = `${this.getBaseUrl()}/threads/${this.threadId}/runs/${this.runId}/cancel`;
        await fetch(url, { method: 'POST' });
      } catch {
        // Best-effort cancellation
      }
    }
    await super.kill();
  }

  // ── LangGraph REST API calls ──────────────────────────────────

  private async createThread(threadId: string): Promise<{ thread_id: string }> {
    const response = await fetch(`${this.baseUrl}/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        thread_id: threadId,
        if_exists: 'do_nothing',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create OpenSWE thread: ${response.status} ${errorText}`);
    }

    return response.json();
  }

  // ── SSE stream parser ─────────────────────────────────────────

  private async *parseSSE(
    body: ReadableStream<Uint8Array>,
  ): AsyncGenerator<{ event: string; data: any }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';
    let currentData = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            currentData += line.slice(5).trim();
          } else if (line === '' && currentEvent && currentData) {
            // Empty line = end of SSE message
            try {
              const parsed = JSON.parse(currentData);
              yield { event: currentEvent, data: parsed };
            } catch {
              // Non-JSON data — skip
            }
            currentEvent = '';
            currentData = '';
          }
        }
      }

      // Flush any remaining buffered event
      if (currentEvent && currentData) {
        try {
          const parsed = JSON.parse(currentData);
          yield { event: currentEvent, data: parsed };
        } catch {
          // Non-JSON data — skip
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ── Message translation ────────────────────────────────────────

  private translateMessage(message: LangGraphMessage): CLIMessage | null {
    if (!message) return null;

    // AI/assistant message with text content
    if (message.type === 'ai' || message.type === 'AIMessageChunk') {
      const text = this.extractMessageText(message);
      const toolCalls = message.tool_calls ?? [];

      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: unknown }
      > = [];

      if (text) {
        content.push({ type: 'text', text });
      }

      for (const tc of toolCalls) {
        content.push({
          type: 'tool_use',
          id: tc.id ?? randomUUID(),
          name: tc.name ?? 'unknown',
          input: tc.args ?? {},
        });
      }

      if (content.length === 0) return null;

      return {
        type: 'assistant',
        message: {
          id: message.id ?? randomUUID(),
          content,
        },
      };
    }

    // Tool message (result of a tool call)
    if (message.type === 'tool') {
      const toolUseId = message.tool_call_id ?? '';
      const output =
        typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content ?? '');

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

    // Human message — skip (we already sent it)
    return null;
  }

  private extractMessageText(message: LangGraphMessage): string | null {
    if (typeof message.content === 'string') {
      return message.content || null;
    }
    if (Array.isArray(message.content)) {
      const texts = message.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text ?? '')
        .filter(Boolean);
      return texts.length > 0 ? texts.join('\n\n') : null;
    }
    return null;
  }

  // ── Repo detection ─────────────────────────────────────────────

  private async detectRepoConfig(): Promise<Record<string, string>> {
    try {
      const { execSync } = await import('child_process');
      const remote = execSync('git remote get-url origin', {
        cwd: this.options.cwd,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();

      // Parse owner/name from GitHub URL
      const match = remote.match(/[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
      if (match) {
        return { owner: match[1], name: match[2] };
      }
    } catch {
      // Not a git repo or no remote
    }
    return {};
  }
}

// ── LangGraph message types (minimal) ─────────────────────────────

interface LangGraphToolCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

interface LangGraphMessage {
  id?: string;
  type: string;
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  tool_calls?: LangGraphToolCall[];
  tool_call_id?: string;
  name?: string;
  [key: string]: unknown;
}
