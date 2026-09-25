/**
 * Interactive shells for the web side panel. Each terminal is a PTY owned by
 * one session and rooted at its workspace. Terminals outlive browser
 * connections (a reconnect replays the retained scrollback) and end when the
 * shell exits, the user closes them, or the gateway shuts down.
 *
 * Not a sandbox: the shell has the gateway account's permissions, exactly
 * like the agent's own Bash tool.
 */
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { Subprocess, Terminal } from 'bun';
import { ApiError } from './errors.js';
import { killGroup } from './agent/tools/bash.js';

const SCROLLBACK_BYTES = 256 * 1024;
const PER_SESSION = 4;
const TOTAL = 24;
const EXITED_RETENTION_MS = 30 * 60_000;

export interface TerminalInfo {
  id: string;
  sessionId: string;
  title: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  exitCode: number | null;
  exited: boolean;
}

export type TerminalListener = (
  event: { type: 'output'; data: string } | { type: 'exit'; exitCode: number | null },
) => void;

interface Entry {
  info: TerminalInfo;
  terminal: Terminal;
  proc: Subprocess;
  /** Retained output (raw bytes) for replay on attach. */
  scrollback: Buffer[];
  scrollbackBytes: number;
  listeners: Set<TerminalListener>;
  decoder: TextDecoder;
}

export function defaultShell(preferred?: string): string {
  for (const shell of [preferred, process.env.SHELL])
    if (shell && shell.startsWith('/')) return shell;
  return '/bin/sh';
}

export class TerminalManager {
  private readonly terminals = new Map<string, Entry>();
  private closing = false;

  constructor(
    private readonly env: () => Record<string, string | undefined> = () => process.env,
    private readonly shell?: string,
  ) {}

  list(sessionId: string): TerminalInfo[] {
    return [...this.terminals.values()]
      .filter((entry) => entry.info.sessionId === sessionId)
      .map((entry) => ({ ...entry.info }));
  }

  create(sessionId: string, cwd: string, size: { cols: number; rows: number }): TerminalInfo {
    if (this.closing) throw new ApiError(503, 'runner_unavailable', 'Gateway is shutting down');
    if (process.platform === 'win32')
      throw new ApiError(400, 'invalid_input', 'Terminals require macOS or Linux');
    const live = [...this.terminals.values()].filter((entry) => !entry.info.exited);
    if (live.filter((entry) => entry.info.sessionId === sessionId).length >= PER_SESSION)
      throw new ApiError(409, 'conflict', `At most ${PER_SESSION} terminals per session`);
    if (live.length >= TOTAL) throw new ApiError(409, 'conflict', 'Too many open terminals');
    // Opening a new terminal discards this session's exited ones.
    for (const entry of this.terminals.values())
      if (entry.info.exited && entry.info.sessionId === sessionId)
        this.terminals.delete(entry.info.id);
    const cols = clamp(size.cols, 20, 500, 80);
    const rows = clamp(size.rows, 5, 200, 24);
    const id = randomUUID().slice(0, 8);
    const shell = defaultShell(this.shell);
    let entry: Entry | undefined;
    const terminal = new Bun.Terminal({
      cols,
      rows,
      name: 'xterm-256color',
      data: (_terminal, data) => {
        if (entry) this.output(entry, Buffer.from(data));
      },
    });
    let proc: Subprocess;
    try {
      // Via /bin/sh + exec: spawned directly, some shells (fish, zsh) come up
      // without the PTY as controlling terminal and lose job control.
      proc = Bun.spawn(['/bin/sh', '-c', 'exec "$0" -l', shell], {
        cwd,
        terminal,
        // Session leader owning the PTY: job control works, and a hangup to
        // the group reaches the shell's jobs too.
        detached: true,
        env: {
          ...this.env(),
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          PIRC_TERMINAL: '1',
          HOME: process.env.HOME ?? os.homedir(),
        },
      });
    } catch (error) {
      terminal.close();
      throw new ApiError(
        500,
        'runner_unavailable',
        `Could not start shell: ${(error as Error).message}`,
      );
    }
    entry = {
      info: {
        id,
        sessionId,
        title: shell.split('/').at(-1) ?? 'shell',
        cwd,
        cols,
        rows,
        createdAt: Date.now(),
        exitCode: null,
        exited: false,
      },
      terminal,
      proc,
      scrollback: [],
      scrollbackBytes: 0,
      listeners: new Set(),
      decoder: new TextDecoder(),
    };
    this.terminals.set(id, entry);
    const current = entry;
    void proc.exited.then((code) => {
      current.info.exited = true;
      current.info.exitCode = proc.signalCode ? null : code;
      // Drain what the PTY still holds, then tell listeners.
      setTimeout(() => {
        try {
          current.terminal.close();
        } catch {
          /* already closed */
        }
        for (const listener of current.listeners)
          listener({ type: 'exit', exitCode: current.info.exitCode });
      }, 50);
      // An exited terminal stays readable for a while, then its scrollback is freed.
      setTimeout(() => {
        if (this.terminals.get(id) === current) this.terminals.delete(id);
      }, EXITED_RETENTION_MS).unref();
    });
    return { ...entry.info };
  }

  private output(entry: Entry, chunk: Buffer): void {
    entry.scrollback.push(chunk);
    entry.scrollbackBytes += chunk.length;
    while (entry.scrollbackBytes > SCROLLBACK_BYTES && entry.scrollback.length > 1)
      entry.scrollbackBytes -= entry.scrollback.shift()!.length;
    const data = entry.decoder.decode(chunk, { stream: true });
    if (data) for (const listener of entry.listeners) listener({ type: 'output', data });
  }

  private lookup(sessionId: string, id: string): Entry {
    const entry = this.terminals.get(id);
    if (!entry || entry.info.sessionId !== sessionId)
      throw new ApiError(404, 'not_found', 'Terminal not found');
    return entry;
  }

  /** Subscribe; returns the retained scrollback to replay first, and an unsubscribe. */
  attach(
    sessionId: string,
    id: string,
    listener: TerminalListener,
  ): { info: TerminalInfo; replay: string; detach: () => void } {
    const entry = this.lookup(sessionId, id);
    entry.listeners.add(listener);
    // Replay decodes independently so a split code point at the start is dropped, not mangled.
    const replay = new TextDecoder().decode(Buffer.concat(entry.scrollback));
    return {
      info: { ...entry.info },
      replay,
      detach: () => entry.listeners.delete(listener),
    };
  }

  input(sessionId: string, id: string, data: string): void {
    const entry = this.lookup(sessionId, id);
    if (entry.info.exited || data.length > 65_536) return;
    entry.terminal.write(data);
  }

  resize(sessionId: string, id: string, cols: number, rows: number): void {
    const entry = this.lookup(sessionId, id);
    if (entry.info.exited) return;
    entry.info.cols = clamp(cols, 20, 500, entry.info.cols);
    entry.info.rows = clamp(rows, 5, 200, entry.info.rows);
    entry.terminal.resize(entry.info.cols, entry.info.rows);
  }

  close(sessionId: string, id: string): void {
    const entry = this.lookup(sessionId, id);
    this.terminals.delete(id);
    this.kill(entry);
  }

  closeSession(sessionId: string): void {
    for (const entry of [...this.terminals.values()])
      if (entry.info.sessionId === sessionId) {
        this.terminals.delete(entry.info.id);
        this.kill(entry);
      }
  }

  private kill(entry: Entry): void {
    for (const listener of entry.listeners) listener({ type: 'exit', exitCode: null });
    entry.listeners.clear();
    // The exit handler closes the PTY once the shell is gone.
    if (entry.info.exited) return;
    killGroup(entry.proc.pid, 'SIGHUP');
    const timer = setTimeout(() => killGroup(entry.proc.pid, 'SIGKILL'), 2_000);
    timer.unref();
    void entry.proc.exited.then(() => clearTimeout(timer));
  }

  shutdown(): void {
    this.closing = true;
    for (const entry of [...this.terminals.values()]) this.kill(entry);
    this.terminals.clear();
  }
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(min, Math.min(max, number));
}
