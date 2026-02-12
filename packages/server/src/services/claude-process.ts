/**
 * ClaudeProcess — spawns and manages a single claude CLI process.
 * Communicates via NDJSON over stdin/stdout.
 * Uses Bun.spawn for process management.
 */

import { EventEmitter } from 'events';
import { LineBuffer, decodeNDJSON } from '../utils/ndjson-transport.js';
import { getClaudeBinaryPath } from '../utils/claude-binary.js';

// ── CLI Message Types ──────────────────────────────────────────────

export interface CLISystemMessage {
  type: 'system';
  subtype: 'init';
  session_id: string;
  tools?: string[];
  model?: string;
  cwd?: string;
}

export interface CLIAssistantMessage {
  type: 'assistant';
  message: {
    id: string;
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: unknown }
    >;
    usage?: { input_tokens: number; output_tokens: number };
  };
  parent_tool_use_id?: string | null;
}

export interface CLIUserMessage {
  type: 'user';
  message: {
    content: Array<{
      type: 'tool_result';
      tool_use_id: string;
      content: string;
    }>;
  };
}

export interface CLIResultMessage {
  type: 'result';
  subtype:
  | 'success'
  | 'error_max_turns'
  | 'error_during_execution'
  | 'error_max_budget_usd';
  is_error: boolean;
  duration_ms: number;
  num_turns: number;
  result?: string;
  total_cost_usd: number;
  session_id: string;
  errors?: string[];
}

export type CLIMessage =
  | CLISystemMessage
  | CLIAssistantMessage
  | CLIUserMessage
  | CLIResultMessage;

// ── Process Options ────────────────────────────────────────────────

export interface ClaudeProcessOptions {
  prompt: string;
  cwd: string;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  sessionId?: string;
  permissionMode?: string;
  images?: any[];
}

// ── ClaudeProcess Class ────────────────────────────────────────────

const WATCHDOG_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const KILL_GRACE_MS = 3_000;

export class ClaudeProcess extends EventEmitter {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private lineBuffer = new LineBuffer();
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private stderrBuf = '';
  private _exited = false;
  private _killed = false;

  constructor(private options: ClaudeProcessOptions) {
    super();
  }

  start(): void {
    const binaryPath = getClaudeBinaryPath();
    const args = this.buildArgs();

    // Use Bun.spawn with pipe for all stdio to support protocol
    this.proc = Bun.spawn([binaryPath, ...args], {
      cwd: this.options.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'pipe',
    });

    console.log(`[claude-process] pid=${this.proc.pid} cwd=${this.options.cwd}`);

    // Standard initialization sequence
    // 1. Initialize Control Protocol Handshake
    this.sendInitialize();

    // 2. Send initial user prompt (text + images) via protocol
    // We do this immediately. The CLI buffers it until ready.
    this.sendInitialMessage();

    // Start reading stdout and stderr in background (non-blocking)
    this.readStdout();
    this.readStderr();

    // Handle process exit
    this.proc.exited
      .then((exitCode) => {
        console.log(`[claude-process] Process exited with code: ${exitCode}`);
        this._exited = true;
        this.clearWatchdog();

        // Flush any remaining buffered data
        const remaining = this.lineBuffer.flush();
        if (remaining) {
          try {
            const msg = decodeNDJSON(remaining) as CLIMessage;
            this.emit('message', msg);
          } catch {
            // Ignore incomplete trailing data
          }
        }

        if (exitCode !== 0 && exitCode !== null && !this._killed) {
          this.emit(
            'error',
            new Error(
              `claude process exited with code ${exitCode}. stderr: ${this.stderrBuf}`
            )
          );
        }
        this.emit('exit', exitCode, null);
      })
      .catch((err) => {
        this._exited = true;
        this.clearWatchdog();
        this.emit('error', err);
        this.emit('exit', null, null);
      });

    this.resetWatchdog();
  }

  private sendInitialize(): void {
    if (!this.proc?.stdin) return;

    // Hooks configuration to intercept tool usage
    const hooks = {
      "PreToolUse": [
        {
          "matcher": ".*", // Intercept ALL tools to check permissions/hooks
          "hookCallbackIds": ["tool_approval"]
        }
      ]
    };

    // Import types from shared if possible, or define interface locally
    // transforming structure to match SDKControlRequest
    const initReq = {
      type: 'control_request',
      request_id: crypto.randomUUID(), // Use built-in crypto for UUID
      request: {
        subtype: 'initialize',
        hooks
      }
    };

    try {
      const stdin = this.proc.stdin as import('bun').FileSink;
      stdin.write(JSON.stringify(initReq) + '\n');
      stdin.flush();
      console.log('[claude-process] Sent initialize handshake');
    } catch (err) {
      console.error('[claude-process] Failed to send initialize:', err);
    }
  }

  // Allow sending raw control responses from AgentRunner
  public sendControlResponse(response: any): void {
    if (!this.proc?.stdin) return;
    try {
      const stdin = this.proc.stdin as import('bun').FileSink;
      stdin.write(JSON.stringify(response) + '\n');
      stdin.flush();
    } catch (err) {
      console.error('[claude-process] Failed to send control response:', err);
    }
  }

  private async readStdout(): Promise<void> {
    if (!this.proc?.stdout) return;
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.resetWatchdog();
        const chunk = decoder.decode(value, { stream: true });
        const lines = this.lineBuffer.push(chunk);
        for (const line of lines) {
          // console.log('[claude-process] RAW stdout:', line); // Very verbose
          try {
            const msg = decodeNDJSON(line) as any;

            // Handle Control Requests internally or emit them
            if (msg.type === 'control_request') {
              console.log('[claude-process] RECV control_request:', JSON.stringify(msg, null, 2)); // LOG REQUESTS
              this.emit('control_request', msg);
            } else if (msg.type === 'control_response') {
              console.log('[claude-process] RECV control_response:', JSON.stringify(msg, null, 2));
            } else {
              // Normal message
              this.emit('message', msg);
            }
          } catch (e) {
            console.warn('[claude-process] Failed to parse NDJSON line:', line);
          }
        }

        // Yield the event loop
        if (lines.length > 0) {
          await new Promise<void>((r) => setTimeout(r, 0));
        }
      }
    } catch (err) {
      if (!this._exited) {
        console.error('[claude-process] stdout read error:', err);
      }
    }
  }

  private async readStderr(): Promise<void> {
    if (!this.proc?.stderr) return;
    const reader = (this.proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        console.error('[claude-process:stderr]', chunk.trimEnd());
        this.stderrBuf += chunk;
      }
    } catch {
      // Ignore stderr
    }
  }

  /**
   * Build CLI arguments for the claude command.
   */
  private buildArgs(): string[] {
    const args: string[] = [
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--permission-prompt-tool=stdio', // Enable Control Protocol
      '--verbose',
    ];

    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    if (this.options.permissionMode) {
      args.push('--permission-mode', this.options.permissionMode);
    }

    if (this.options.maxTurns) {
      args.push('--max-turns', String(this.options.maxTurns));
    }

    if (this.options.sessionId) {
      args.push('--resume', this.options.sessionId);
    }

    if (this.options.allowedTools && this.options.allowedTools.length > 0) {
      args.push('--allowedTools', this.options.allowedTools.join(','));
    }

    if (this.options.disallowedTools && this.options.disallowedTools.length > 0) {
      args.push('--disallowedTools', this.options.disallowedTools.join(','));
    }


    // NOTE: We do NOT pass the prompt as a positional argument anymore.
    // The prompt is sent via stdin using stream-json format after initialization.

    return args;
  }

  /**
   * Send the initial user message (prompt + optional images) via stdin using stream-json format.
   * This is required because we are using --input-format stream-json for the Control Protocol.
   */
  private sendInitialMessage(): void {
    if (!this.proc?.stdin) return;

    try {
      const stdin = this.proc.stdin as import('bun').FileSink;
      const content: any[] = [];

      const promptText = this.options.prompt?.trim();
      if (promptText) {
        content.push({ type: 'text', text: promptText });
      }

      if (this.options.images && this.options.images.length > 0) {
        content.push(...this.options.images);
      }

      if (content.length === 0) return;

      const message = {
        type: 'user',
        message: {
          role: 'user',
          content,
        },
      };

      const line = JSON.stringify(message) + '\n';
      stdin.write(line);
      stdin.flush();
      console.log('[claude-process] Sent initial user prompt via protocol');
    } catch (err) {
      console.error('[claude-process] Failed to send initial message:', err);
      this.emit('error', err);
    }
  }

  /**
   * Kill the process gracefully, then force after timeout.
   */
  async kill(): Promise<void> {
    if (!this.proc || this._exited) return;

    this._killed = true;
    this.proc.kill(); // SIGTERM by default

    await Promise.race([
      this.proc.exited,
      new Promise<void>((resolve) =>
        setTimeout(() => {
          if (!this._exited && this.proc) {
            this.proc.kill(9); // SIGKILL
          }
          resolve();
        }, KILL_GRACE_MS)
      ),
    ]);
  }

  get exited(): boolean {
    return this._exited;
  }

  private resetWatchdog(): void {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      console.error(
        '[claude-process] Watchdog timeout — no messages for 10 minutes'
      );
      this.kill();
    }, WATCHDOG_TIMEOUT_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }
}
