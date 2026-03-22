/**
 * GeminiACPProcess — adapter that wraps the Gemini CLI behind the
 * IAgentProcess EventEmitter interface, communicating via the
 * Agent Client Protocol (ACP) over stdio.
 *
 * Spawns `gemini --experimental-acp` as a subprocess and translates
 * ACP session updates into CLIMessage format so that AgentMessageHandler
 * works unchanged (same as SDKClaudeProcess and CodexProcess).
 *
 * Uses dynamic import of @agentclientprotocol/sdk so the server doesn't
 * crash if the SDK is not installed.
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { Readable, Writable } from 'stream';

import { inferACPToolName, buildACPToolInput, extractACPToolOutput } from './acp-tool-input.js';
import { BaseAgentProcess, type ResultSubtype } from './base-process.js';
import type { CLIMessage } from './types.js';

// Lazy-loaded SDK types (avoid crash if not installed)
type ACPSDK = typeof import('@agentclientprotocol/sdk');
type ACPClient = import('@agentclientprotocol/sdk').Client;
type ACPAgent = import('@agentclientprotocol/sdk').Agent;
type ACPSessionNotification = import('@agentclientprotocol/sdk').SessionNotification;
type ACPSessionUpdate = import('@agentclientprotocol/sdk').SessionUpdate;
type ACPRequestPermissionRequest = import('@agentclientprotocol/sdk').RequestPermissionRequest;
type ACPRequestPermissionResponse = import('@agentclientprotocol/sdk').RequestPermissionResponse;

/** Known Gemini CLI built-in tools (ACP doesn't expose a listTools API). */
const GEMINI_BUILTIN_TOOLS = [
  'read_file',
  'write_file',
  'replace',
  'list_directory',
  'glob',
  'grep_search',
  'run_shell_command',
  'web_fetch',
  'google_web_search',
  'codebase_investigator',
  'save_memory',
  'ask_user',
  'activate_skill',
  'cli_help',
];

export class GeminiACPProcess extends BaseAgentProcess {
  private childProcess: ChildProcess | null = null;

  // ── Overrides ──────────────────────────────────────────────────

  async kill(): Promise<void> {
    await super.kill();
    if (this.childProcess && !this.childProcess.killed) {
      this.childProcess.kill('SIGTERM');
    }
  }

  // ── Provider-specific run loop ─────────────────────────────────

  protected async runProcess(): Promise<void> {
    // Dynamic import — fails gracefully if SDK not installed
    let SDK: ACPSDK;
    try {
      SDK = await import('@agentclientprotocol/sdk');
    } catch {
      throw new Error(
        'ACP SDK not installed. Run: bun add @agentclientprotocol/sdk\n' +
          'Also ensure gemini-cli is installed: npm install -g @google/gemini-cli or see https://github.com/google/gemini-cli',
      );
    }

    const { ClientSideConnection, ndJsonStream } = SDK;

    // Resolve Gemini binary
    const geminiBin = this.resolveGeminiBinary();
    this.logger?.debug(
      `[gemini-acp] resolved binary: ${geminiBin}, platform: ${process.platform}, shell: ${process.platform === 'win32'}`,
    );

    // Build CLI args
    const args = ['--experimental-acp'];
    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    // Spawn gemini subprocess with stdio pipes
    // On Windows, shell: true is required to resolve .cmd/.bat wrappers
    // for npm-installed binaries like `gemini`
    const child = spawn(geminiBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      signal: this.abortController.signal,
      shell: process.platform === 'win32',
    });

    this.childProcess = child;

    // Handle process errors
    child.on('error', (err: any) => {
      if (!this._exited && !this.isAborted) {
        if (err.code === 'ENOENT') {
          this.emit(
            'error',
            new Error(
              "'gemini' binary not found in PATH or failed to spawn.\n" +
                'Please install it via: npm install -g @google/gemini-cli\n' +
                'Or see https://github.com/google/gemini-cli for details.',
            ),
          );
        } else {
          this.emit('error', err);
        }
      }
    });

    // Surface stderr errors as tool call cards so they appear in the thread
    // with full history. ACP subprocesses write JSON-RPC errors and API errors
    // to stderr — these are critical for the user (rate limits, auth failures, etc.).
    child.stderr?.on('data', (data: Buffer) => {
      const raw = data.toString().trim();
      if (!raw) return;

      const errorText = this.parseStderrError(raw);
      if (errorText) {
        this.emitErrorToolCall(errorText);
      }
    });

    try {
      // Wait for process to spawn successfully before proceeding
      await new Promise<void>((resolve, reject) => {
        child.on('spawn', resolve);
        child.on('error', reject);
      });
    } catch {
      // Error emitted by child.on('error') above, so we just return
      this._exited = true;
      return;
    }

    // Convert Node streams to Web streams for ACP SDK
    const outputStream = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    const inputStream = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;

    // Create ACP NDJSON stream
    const stream = ndJsonStream(outputStream, inputStream);

    const sessionId = this.options.sessionId ?? randomUUID();
    const startTime = Date.now();
    let numTurns = 0;
    let totalCost = 0;
    let lastAssistantText = '';

    // Current assistant message ID — rotated after each tool call so that
    // text blocks before and after tool calls become separate DB messages.
    let assistantMsgId = randomUUID();

    // Accumulate text chunks so we emit the full content, not just deltas
    let accumulatedText = '';

    // Track tool calls for deduplication and pending state.
    // Value: tool name while pending, 'done' after result emitted.
    const toolCallsSeen = new Map<string, string>();

    // Create ACP client implementation
    const acpClient: ACPClient = {
      // Handle streaming session updates from the agent
      sessionUpdate: async (params: ACPSessionNotification): Promise<void> => {
        if (this.isAborted) return;

        const update = params.update;
        const result = this.translateUpdate(update, assistantMsgId, toolCallsSeen, accumulatedText);
        accumulatedText = result.text;
        assistantMsgId = result.msgId;
      },

      // Auto-allow all permission requests (matches autoEdit behavior)
      requestPermission: async (
        params: ACPRequestPermissionRequest,
      ): Promise<ACPRequestPermissionResponse> => {
        // Find the first "allow" option
        const allowOption = params.options.find(
          (opt) => opt.kind === 'allow_once' || opt.kind === 'allow_always',
        );

        if (allowOption) {
          return {
            outcome: {
              outcome: 'selected',
              optionId: allowOption.optionId,
            },
          };
        }

        // Fallback — allow the first option
        return {
          outcome: {
            outcome: 'selected',
            optionId: params.options[0]?.optionId ?? '',
          },
        };
      },
    };

    // Create client-side ACP connection
    const connection = new ClientSideConnection((_agent: ACPAgent) => acpClient, stream);

    // Emit init message
    this.emitInit(
      sessionId,
      GEMINI_BUILTIN_TOOLS,
      this.options.model ?? 'gemini-3-flash-preview',
      this.options.cwd,
    );

    try {
      // Step 1: Initialize the ACP connection
      await connection.initialize({
        protocolVersion: 1,
        clientInfo: { name: 'funny', version: '1.0.0' },
        clientCapabilities: {},
      });

      // Step 2: Create a new session
      const sessionResponse = await connection.newSession({
        cwd: this.options.cwd,
        mcpServers: [],
      });

      // Step 3: Send the prompt
      const promptResponse = await connection.prompt({
        sessionId: sessionResponse.sessionId,
        prompt: [{ type: 'text', text: this.options.prompt }],
      });

      // Extract usage if available
      if (promptResponse.usage) {
        const u = promptResponse.usage;
        // Rough Gemini pricing estimate
        const inputTokens = u.inputTokens ?? 0;
        const outputTokens = u.outputTokens ?? 0;
        totalCost = (inputTokens * 0.00025 + outputTokens * 0.001) / 1000;
      }

      numTurns = 1;

      // Map stop reason
      const subtype: ResultSubtype =
        promptResponse.stopReason === 'end_turn'
          ? 'success'
          : promptResponse.stopReason === 'cancelled'
            ? 'error_during_execution'
            : promptResponse.stopReason === 'max_tokens'
              ? 'error_max_turns'
              : 'success';

      // Emit result
      this.emitResult({
        sessionId,
        subtype,
        startTime,
        numTurns,
        totalCost,
        result: lastAssistantText || undefined,
      });
    } catch (err: unknown) {
      if (!this.isAborted) {
        const errorMessage = this.extractErrorMessage(err);
        this.emitResult({
          sessionId,
          subtype: 'error_during_execution',
          startTime,
          numTurns,
          totalCost,
          result: errorMessage,
          errors: [errorMessage],
        });
      }
    } finally {
      // Clean up child process
      if (this.childProcess && !this.childProcess.killed) {
        this.childProcess.kill('SIGTERM');
      }
      this.finalize();
    }
  }

  // ── Update translation ──────────────────────────────────────

  /**
   * Translate an ACP SessionUpdate into CLIMessage(s).
   * Returns the updated accumulated text and assistant message ID.
   */
  private translateUpdate(
    update: ACPSessionUpdate,
    assistantMsgId: string,
    toolCallsSeen: Map<string, string>,
    accumulatedText: string,
  ): { text: string; msgId: string } {
    const ret = (text: string, msgId?: string) => ({ text, msgId: msgId ?? assistantMsgId });
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        // Text content from the agent (message or thought/reasoning)
        const content = update.content;
        if (content.type === 'text' && content.text) {
          // Accumulate the chunk so we emit the full text, not just the delta.
          // The handler uses the same assistantMsgId to update in-place,
          // so it needs the complete content each time.
          accumulatedText += content.text;

          const msg: CLIMessage = {
            type: 'assistant',
            message: {
              id: assistantMsgId,
              content: [{ type: 'text', text: accumulatedText }],
            },
          };
          this.emit('message', msg);
        }
        return ret(accumulatedText);
      }

      case 'tool_call': {
        const toolCallId = update.toolCallId;
        if (toolCallsSeen.has(toolCallId)) return ret(accumulatedText);

        const acpKind = (update as any).kind as string | undefined;
        const title = update.title || '';
        const locations = (update as any).locations as
          | Array<{ path: string; line?: number | null }>
          | undefined;
        console.debug(
          `[gemini-acp] tool_call: id=${toolCallId}, kind=${acpKind}, title=${title}, hasRawInput=${update.rawInput != null}`,
        );
        const toolName = inferACPToolName(acpKind, title);

        toolCallsSeen.set(toolCallId, toolName);

        const input = buildACPToolInput(toolName, {
          kind: acpKind,
          title,
          rawInput: update.rawInput,
          locations,
        });

        const msg: CLIMessage = {
          type: 'assistant',
          message: {
            id: randomUUID(),
            content: [
              {
                type: 'tool_use',
                id: toolCallId,
                name: toolName,
                input,
              },
            ],
          },
        };
        this.emit('message', msg);

        // If the tool_call already carries a completed status and output
        // (Gemini runs tools internally, so this can happen), emit the
        // result immediately without waiting for a separate tool_call_update.
        const tcStatus = (update as any).status as string | undefined;
        if (tcStatus === 'completed' || tcStatus === 'failed') {
          toolCallsSeen.set(toolCallId, 'done');
          const tcOutput = extractACPToolOutput(update.rawOutput, (update as any).content, title);
          this.emit('message', {
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: toolCallId,
                  content: tcOutput,
                },
              ],
            },
          } as CLIMessage);
        }

        return ret('', randomUUID());
      }

      case 'tool_call_update': {
        const toolCallId = update.toolCallId;
        console.debug(
          `[gemini-acp] tool_call_update: id=${toolCallId}, status=${update.status}, hasRawOutput=${update.rawOutput != null}, hasContent=${!!(update as any).content?.length}, title=${update.title ?? ''}`,
        );

        if (update.status === 'completed' || update.status === 'failed') {
          toolCallsSeen.set(toolCallId, 'done');
          const output = extractACPToolOutput(
            update.rawOutput,
            (update as any).content,
            update.title || '',
          );
          const msg: CLIMessage = {
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: toolCallId,
                  content: output,
                },
              ],
            },
          };
          this.emit('message', msg);
        }
        return ret(accumulatedText);
      }

      case 'plan': {
        // Plan update — format as assistant text
        const entries = update.entries ?? [];
        if (entries.length > 0) {
          const planText = entries
            .map((e: any, i: number) => {
              const status =
                e.status === 'completed' ? '[x]' : e.status === 'in_progress' ? '[~]' : '[ ]';
              return `${status} ${i + 1}. ${e.title ?? e.description ?? 'Task'}`;
            })
            .join('\n');

          // Close any pending Task (think/switch_mode) tool calls with the plan text
          for (const [tcId, tcState] of toolCallsSeen) {
            if (tcState === 'Task') {
              toolCallsSeen.set(tcId, 'done');
              this.emit('message', {
                type: 'user',
                message: {
                  content: [
                    {
                      type: 'tool_result',
                      tool_use_id: tcId,
                      content: planText,
                    },
                  ],
                },
              } as CLIMessage);
            }
          }

          // Plan text is a standalone block — don't mix with accumulated text
          const msg: CLIMessage = {
            type: 'assistant',
            message: {
              id: assistantMsgId,
              content: [{ type: 'text', text: `**Plan:**\n${planText}` }],
            },
          };
          this.emit('message', msg);
        }
        return ret(accumulatedText);
      }

      // Ignore other update types (available_commands_update, current_mode_update, etc.)
      default:
        return ret(accumulatedText);
    }
  }

  // ── Binary resolution ───────────────────────────────────────

  private resolveGeminiBinary(): string {
    // 1. GEMINI_BINARY_PATH env var
    const envPath = process.env.GEMINI_BINARY_PATH;
    if (envPath) return envPath;

    // 2. ACP_GEMINI_BIN env var (Python SDK convention)
    const acpEnvPath = process.env.ACP_GEMINI_BIN;
    if (acpEnvPath) return acpEnvPath;

    // 3. Default to 'gemini' in PATH (shell: true in spawn handles .cmd on Windows)
    return 'gemini';
  }
}
