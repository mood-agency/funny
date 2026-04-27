/**
 * PiACPProcess — adapter that wraps the `pi-acp` adapter
 * (https://github.com/svkozak/pi-acp) behind the IAgentProcess
 * EventEmitter interface, communicating via the Agent Client Protocol
 * (ACP) over stdio.
 *
 * Spawns `pi-acp` as a subprocess. `pi-acp` itself spawns `pi --mode rpc`
 * internally, so the user must have `pi` (@mariozechner/pi-coding-agent)
 * installed and configured with provider credentials separately. Funny
 * does not pass a `--model` flag — model/provider selection is owned by
 * pi's own settings (`~/.pi/agent/settings.json`).
 *
 * Translates ACP session updates into CLIMessage format so that
 * AgentMessageHandler works unchanged (same as GeminiACPProcess and
 * CodexACPProcess).
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { Readable, Writable } from 'stream';

import { createDebugLogger } from '../debug.js';
import { toACPMcpServers } from './acp-mcp.js';
import { inferACPToolName, buildACPToolInput, extractACPToolOutput } from './acp-tool-input.js';
import { BaseAgentProcess, type ResultSubtype } from './base-process.js';
import type { CLIMessage } from './types.js';

const dlog = createDebugLogger('acp-pi');

// Lazy-loaded SDK types (avoid crash if not installed)
type ACPSDK = typeof import('@agentclientprotocol/sdk');
type ACPClient = import('@agentclientprotocol/sdk').Client;
type ACPAgent = import('@agentclientprotocol/sdk').Agent;
type ACPSessionNotification = import('@agentclientprotocol/sdk').SessionNotification;
type ACPSessionUpdate = import('@agentclientprotocol/sdk').SessionUpdate;
type ACPRequestPermissionRequest = import('@agentclientprotocol/sdk').RequestPermissionRequest;
type ACPRequestPermissionResponse = import('@agentclientprotocol/sdk').RequestPermissionResponse;

/** Pi built-in tools surfaced via system:init. Matches `pi --tools` defaults. */
const PI_BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];

/**
 * Pi prepends a banner to its first agent_message_chunk, e.g.
 *   pi v0.70.2
 *   ---
 *
 *   ## Skills
 *   - /path/to/SKILL.md
 *   ...
 *
 * Strip the leading version line, the `---` separator, and any subsequent
 * `## Section` blocks (with their bullet lists) before the actual response.
 */
function stripPiBanner(text: string): string {
  const banner = /^pi v[\d.]+\s*\n-{3,}\s*\n+(?:##[^\n]*\n(?:[-*][^\n]*\n)*\n*)*/;
  return text.replace(banner, '').replace(/^\s+/, '');
}

export class PiACPProcess extends BaseAgentProcess {
  private childProcess: ChildProcess | null = null;

  /** Buffer for `agent_thought_chunk` text — collapsed into a single Think tool call. */
  private pendingThought: { id: string; text: string } | null = null;

  private flushPendingThought(): void {
    if (!this.pendingThought) return;
    const { id, text } = this.pendingThought;
    this.pendingThought = null;
    if (!text.trim()) return;

    this.emit('message', {
      type: 'assistant',
      message: {
        id: randomUUID(),
        content: [{ type: 'tool_use', id, name: 'Think', input: { content: text } }],
      },
    } as CLIMessage);

    this.emit('message', {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: id, content: text }],
      },
    } as CLIMessage);
  }

  // ── Overrides ──────────────────────────────────────────────────

  async kill(): Promise<void> {
    await super.kill();
    if (this.childProcess && !this.childProcess.killed) {
      this.childProcess.kill('SIGTERM');
    }
  }

  // ── Provider-specific run loop ─────────────────────────────────

  protected async runProcess(): Promise<void> {
    let SDK: ACPSDK;
    try {
      SDK = await import('@agentclientprotocol/sdk');
    } catch {
      throw new Error(
        'ACP SDK not installed. Run: bun add @agentclientprotocol/sdk\n' +
          'Also ensure pi-acp is available: npm install -g pi-acp ' +
          '(or rely on `npx -y pi-acp`). Pi itself must also be installed: ' +
          'npm install -g @mariozechner/pi-coding-agent',
      );
    }

    const { ClientSideConnection, ndJsonStream } = SDK;

    const { command, args } = this.resolvePiAcpCommand();
    dlog.info('spawning pi-acp', { command, args, cwd: this.options.cwd });

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      signal: this.abortController.signal,
      shell: process.platform === 'win32',
    });

    this.childProcess = child;

    child.on('error', (err: any) => {
      if (!this._exited && !this.isAborted) {
        if (err.code === 'ENOENT') {
          this.emit(
            'error',
            new Error(
              "'pi-acp' binary not found in PATH or failed to spawn.\n" +
                'Install via: npm install -g pi-acp\n' +
                'Also install pi: npm install -g @mariozechner/pi-coding-agent\n' +
                'Or set PI_ACP_BINARY_PATH to a custom location.\n' +
                'See https://github.com/svkozak/pi-acp for details.',
            ),
          );
        } else {
          this.emit('error', err);
        }
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      const raw = data.toString().trim();
      if (!raw) return;
      const errorText = this.parseStderrError(raw);
      if (errorText) this.emitErrorToolCall(errorText);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        child.on('spawn', resolve);
        child.on('error', reject);
      });
    } catch {
      this._exited = true;
      return;
    }

    const outputStream = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    const inputStream = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(outputStream, inputStream);

    let activeSessionId: string = this.options.sessionId ?? randomUUID();
    const startTime = Date.now();
    let numTurns = 0;
    const totalCost = 0;
    let lastAssistantText = '';

    let assistantMsgId: string = randomUUID();
    let accumulatedText = '';
    const toolCallsSeen = new Map<string, string>();

    // While loadSession is replaying historical session updates, drop them —
    // funny's DB already holds the persisted history and we don't want duplicates.
    let replayingHistory = false;

    const acpClient: ACPClient = {
      sessionUpdate: async (params: ACPSessionNotification): Promise<void> => {
        if (this.isAborted) return;
        if (replayingHistory) return;
        const result = this.translateUpdate(
          params.update,
          assistantMsgId,
          toolCallsSeen,
          accumulatedText,
        );
        accumulatedText = result.text;
        assistantMsgId = result.msgId;
        if (result.lastAssistantText) lastAssistantText = result.lastAssistantText;
      },

      requestPermission: async (
        params: ACPRequestPermissionRequest,
      ): Promise<ACPRequestPermissionResponse> => {
        const allowOption = params.options.find(
          (opt) => opt.kind === 'allow_once' || opt.kind === 'allow_always',
        );
        if (allowOption) {
          return {
            outcome: { outcome: 'selected', optionId: allowOption.optionId },
          };
        }
        return {
          outcome: { outcome: 'selected', optionId: params.options[0]?.optionId ?? '' },
        };
      },
    };

    const connection = new ClientSideConnection((_agent: ACPAgent) => acpClient, stream);

    try {
      const initResult = await connection.initialize({
        protocolVersion: 1,
        clientInfo: { name: 'funny', version: '1.0.0' },
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });

      const supportsLoadSession = initResult.agentCapabilities?.loadSession === true;
      const mcpCaps = (initResult.agentCapabilities as Record<string, any> | undefined)
        ?.mcpCapabilities;
      const supportsHttp = mcpCaps?.http === true;
      const supportsSse = mcpCaps?.sse === true;

      // Resume existing session if possible, else create a new one.
      // Filter MCP servers by what the agent advertises it supports — pi-acp
      // declares `mcpCapabilities: { http: false, sse: false }` and currently
      // never consumes the list at all, so passing HTTP/SSE entries causes
      // pi-acp to fail. Stdio is mandatory per ACP spec and always allowed.
      const allMcp = toACPMcpServers(this.options.mcpServers);
      const mcpServerList = allMcp.filter((s) => {
        const t = s.type as string | undefined;
        if (t === 'http') return supportsHttp;
        if (t === 'sse') return supportsSse;
        return true;
      });
      if (allMcp.length !== mcpServerList.length) {
        dlog.warn('dropped MCP servers unsupported by agent', {
          dropped: allMcp.length - mcpServerList.length,
          mcpCapabilities: mcpCaps,
        });
      }
      let sessionResponse: Awaited<ReturnType<typeof connection.newSession>> | null = null;
      if (this.options.sessionId && supportsLoadSession) {
        activeSessionId = this.options.sessionId;
        replayingHistory = true;
        try {
          await connection.loadSession({
            sessionId: this.options.sessionId,
            cwd: this.options.cwd,
            mcpServers: mcpServerList,
          });
        } finally {
          replayingHistory = false;
        }
      } else {
        sessionResponse = await connection.newSession({
          cwd: this.options.cwd,
          mcpServers: mcpServerList,
        });
        activeSessionId = sessionResponse.sessionId;
      }

      // Emit init with the real session id once known so the persisted
      // record matches what pi-acp wrote to its session store.
      this.emitInit(
        activeSessionId,
        PI_BUILTIN_TOOLS,
        this.options.model ?? 'pi-default',
        this.options.cwd,
      );

      const sessionModels = (sessionResponse as any)?.models;
      if (sessionModels) {
        dlog.info('session/new advertised models', {
          availableModels: JSON.stringify(sessionModels.availableModels),
          currentModelId: sessionModels.currentModelId,
        });
      }

      // Select the requested model via ACP if one was specified and it's not
      // the sentinel `default` (which means "use pi's configured default").
      const requestedModel = this.options.model;
      if (requestedModel && requestedModel !== 'default') {
        try {
          await connection.unstable_setSessionModel({
            sessionId: activeSessionId,
            modelId: requestedModel,
          });
          dlog.info('session/set_model applied', { modelId: requestedModel });
        } catch (e) {
          dlog.warn('session/set_model failed — falling back to pi default', {
            modelId: requestedModel,
            error: (e as Error)?.message,
          });
        }
      }

      const promptResponse = await connection.prompt({
        sessionId: activeSessionId,
        prompt: [{ type: 'text', text: this.options.prompt }],
      });

      numTurns = 1;

      const subtype: ResultSubtype =
        promptResponse.stopReason === 'end_turn'
          ? 'success'
          : promptResponse.stopReason === 'cancelled'
            ? 'error_during_execution'
            : promptResponse.stopReason === 'max_tokens'
              ? 'error_max_turns'
              : 'success';

      this.flushPendingThought();

      this.emitResult({
        sessionId: activeSessionId,
        subtype,
        startTime,
        numTurns,
        totalCost,
        result: lastAssistantText || undefined,
      });
    } catch (err: unknown) {
      this.flushPendingThought();
      if (!this.isAborted) {
        const errorMessage = this.extractErrorMessage(err);
        this.emitResult({
          sessionId: activeSessionId,
          subtype: 'error_during_execution',
          startTime,
          numTurns,
          totalCost,
          result: errorMessage,
          errors: [errorMessage],
        });
      }
    } finally {
      if (this.childProcess && !this.childProcess.killed) {
        this.childProcess.kill('SIGTERM');
      }
      this.finalize();
    }
  }

  // ── Update translation ──────────────────────────────────────

  private translateUpdate(
    update: ACPSessionUpdate,
    assistantMsgId: string,
    toolCallsSeen: Map<string, string>,
    accumulatedText: string,
  ): { text: string; msgId: string; lastAssistantText?: string } {
    const ret = (
      text: string,
      msgId?: string,
      lastAssistantText?: string,
    ): { text: string; msgId: string; lastAssistantText?: string } => ({
      text,
      msgId: msgId ?? assistantMsgId,
      lastAssistantText,
    });

    switch (update.sessionUpdate) {
      case 'agent_thought_chunk': {
        const content = update.content;
        if (content.type === 'text' && content.text) {
          if (!this.pendingThought) {
            this.pendingThought = { id: randomUUID(), text: '' };
          }
          this.pendingThought.text += content.text;
        }
        return ret(accumulatedText);
      }

      case 'agent_message_chunk': {
        this.flushPendingThought();
        const content = update.content;
        if (content.type === 'text' && content.text) {
          accumulatedText += content.text;
          const visible = stripPiBanner(accumulatedText);
          if (visible) {
            this.emit('message', {
              type: 'assistant',
              message: {
                id: assistantMsgId,
                content: [{ type: 'text', text: visible }],
              },
            } as CLIMessage);
          }
        }
        return ret(accumulatedText, assistantMsgId, stripPiBanner(accumulatedText));
      }

      case 'tool_call': {
        this.flushPendingThought();
        const toolCallId = update.toolCallId;
        if (toolCallsSeen.has(toolCallId)) return ret(accumulatedText);

        const acpKind = (update as any).kind as string | undefined;
        const title = update.title || '';
        const locations = (update as any).locations as
          | Array<{ path: string; line?: number | null }>
          | undefined;
        const toolName = inferACPToolName(acpKind, title);
        toolCallsSeen.set(toolCallId, toolName);

        const input = buildACPToolInput(toolName, {
          kind: acpKind,
          title,
          rawInput: update.rawInput,
          locations,
        });

        this.emit('message', {
          type: 'assistant',
          message: {
            id: randomUUID(),
            content: [{ type: 'tool_use', id: toolCallId, name: toolName, input }],
          },
        } as CLIMessage);

        const tcStatus = (update as any).status as string | undefined;
        if (tcStatus === 'completed' || tcStatus === 'failed') {
          toolCallsSeen.set(toolCallId, 'done');
          const tcOutput = extractACPToolOutput(update.rawOutput, (update as any).content, title);
          this.emit('message', {
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: toolCallId, content: tcOutput }],
            },
          } as CLIMessage);
        }

        return ret('', randomUUID());
      }

      case 'tool_call_update': {
        this.flushPendingThought();
        const toolCallId = update.toolCallId;
        if (update.status === 'completed' || update.status === 'failed') {
          toolCallsSeen.set(toolCallId, 'done');
          const output = extractACPToolOutput(
            update.rawOutput,
            (update as any).content,
            update.title || '',
          );
          this.emit('message', {
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: toolCallId, content: output }],
            },
          } as CLIMessage);
        }
        return ret(accumulatedText);
      }

      case 'plan': {
        this.flushPendingThought();
        const entries = update.entries ?? [];
        if (entries.length > 0) {
          const planText = entries
            .map((e: any, i: number) => {
              const status =
                e.status === 'completed' ? '[x]' : e.status === 'in_progress' ? '[~]' : '[ ]';
              return `${status} ${i + 1}. ${e.title ?? e.description ?? 'Task'}`;
            })
            .join('\n');

          this.emit('message', {
            type: 'assistant',
            message: {
              id: assistantMsgId,
              content: [{ type: 'text', text: `**Plan:**\n${planText}` }],
            },
          } as CLIMessage);
        }
        return ret(accumulatedText);
      }

      default:
        return ret(accumulatedText);
    }
  }

  // ── Binary resolution ───────────────────────────────────────

  private resolvePiAcpCommand(): { command: string; args: string[] } {
    const explicit = process.env.PI_ACP_BINARY_PATH || process.env.ACP_PI_BIN;
    if (explicit) return { command: explicit, args: [] };

    if (process.env.PI_ACP_USE_NPX === '1') {
      return { command: 'npx', args: ['-y', 'pi-acp'] };
    }

    return { command: 'pi-acp', args: [] };
  }
}
