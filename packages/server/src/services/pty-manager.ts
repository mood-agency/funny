/**
 * PtyManager — spawns and manages interactive PTY sessions.
 * Streams data to clients via WebSocket (wsBroker).
 */

import * as pty from 'node-pty';
import { wsBroker } from './ws-broker.js';

const isWindows = process.platform === 'win32';

const defaultShell = isWindows ? 'powershell.exe' : (process.env.SHELL || 'bash');

interface PtySession {
  process: pty.IPty;
  userId: string;
  /** Unique instance id to distinguish old vs new PTY with the same logical id */
  instanceId: number;
}

let nextInstanceId = 1;
const activePtys = new Map<string, PtySession>();

export function spawnPty(
  id: string,
  cwd: string,
  cols: number,
  rows: number,
  userId: string,
): void {
  // If a PTY with this ID already exists, keep it alive.
  // Killing and re-spawning on Windows causes CTRL_C to propagate
  // to the new process, killing it immediately.
  if (activePtys.has(id)) {
    return;
  }

  console.log(`[pty-manager] Spawning PTY ${id} in ${cwd} (${cols}x${rows})`);

  const ptyProcess = pty.spawn(defaultShell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: process.env as Record<string, string>,
  });

  // node-pty's WindowsTerminal re-throws socket errors unless the Terminal
  // EventEmitter has >= 2 'error' listeners (see windowsTerminal.js L92).
  // Adding two listeners prevents the unhandled throw when the socket closes
  // during kill/respawn race conditions.
  const ptyEmitter = ptyProcess as unknown as import('events').EventEmitter;
  const onPtyError = (err: Error) => {
    console.warn(`[pty-manager] PTY ${id} error: ${(err as any).code ?? err.message}`);
  };
  ptyEmitter.on('error', onPtyError);
  ptyEmitter.on('error', onPtyError);

  const myInstanceId = nextInstanceId++;
  const session: PtySession = { process: ptyProcess, userId, instanceId: myInstanceId };
  activePtys.set(id, session);

  ptyProcess.onData((data: string) => {
    // Guard: ignore data from a replaced PTY instance
    const current = activePtys.get(id);
    if (!current || current.instanceId !== myInstanceId) return;

    const event = {
      type: 'pty:data' as const,
      threadId: '',
      data: { ptyId: id, data },
    };
    if (userId && userId !== '__local__') {
      wsBroker.emitToUser(userId, event);
    } else {
      wsBroker.emit(event);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    // Only act if this is still the current instance —
    // a newer PTY may have already replaced us under the same id.
    const current = activePtys.get(id);
    if (!current || current.instanceId !== myInstanceId) {
      // Stale exit from a replaced PTY — ignore silently
      return;
    }
    console.log(`[pty-manager] PTY ${id} exited with code ${exitCode}`);
    activePtys.delete(id);
    const event = {
      type: 'pty:exit' as const,
      threadId: '',
      data: { ptyId: id, exitCode },
    };
    if (userId && userId !== '__local__') {
      wsBroker.emitToUser(userId, event);
    } else {
      wsBroker.emit(event);
    }
  });
}

export function writePty(id: string, data: string): void {
  const session = activePtys.get(id);
  if (session) {
    try {
      session.process.write(data);
    } catch (err: any) {
      // Socket may already be closed if the process is exiting
      console.warn(`[pty-manager] Write to PTY ${id} failed: ${err.message}`);
    }
  }
}

export function resizePty(id: string, cols: number, rows: number): void {
  const session = activePtys.get(id);
  if (session) {
    try {
      session.process.resize(cols, rows);
    } catch (err: any) {
      console.warn(`[pty-manager] Resize PTY ${id} failed: ${err.message}`);
    }
  }
}

export function killPty(id: string): void {
  const session = activePtys.get(id);
  if (session) {
    console.log(`[pty-manager] Killing PTY ${id}`);
    activePtys.delete(id);
    try {
      session.process.kill();
    } catch {
      // Already dead — ignore
    }
  }
}

export function killAllPtys(): void {
  for (const [id] of activePtys) {
    killPty(id);
  }
}
