import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Writable } from 'node:stream';
import { killGroup } from '../agent/tools/bash.js';
import { JsonlParser } from './rpc-framing.js';
import { withoutSecrets } from './secrets.js';
import type { PreparedSandbox } from './sandbox.js';
import type { EnvironmentExecutor } from '../environment/service.js';
import {
  REQUEST_BYTES,
  RESULT_BYTES,
  terminalSchema,
  type ExecutionIntent,
  type ExecutionEvent,
  type Terminal,
} from '../environment/protocol.js';
import { canonicalJson } from '../environment/json.js';

/** Supervisor launches only a PreparedSandbox selected with environmentExecutor:true. */
export class SandboxedEnvironmentExecutor implements EnvironmentExecutor {
  private child: ChildProcessWithoutNullStreams;
  private ready = false;
  private closed = false;
  private active:
    | {
        intent: ExecutionIntent;
        resolve(value: Terminal): void;
        reject(error: Error): void;
        event(kind: ExecutionEvent['kind'], payload: ExecutionEvent['payload']): void;
        cleanup(): void;
      }
    | undefined;
  private readonly control: Writable | undefined;
  readonly started: Promise<void>;
  constructor(
    private readonly options: {
      sandbox: PreparedSandbox;
      cwd: string;
      /** Node-resolved trusted config hash, never supplied by a remote intent. */
      projectTrust?: string;
      request(
        kind: 'classify' | 'lease' | 'approval',
        payload: unknown,
        intent: ExecutionIntent,
        signal: AbortSignal,
      ): Promise<unknown>;
    },
  ) {
    if (!options.sandbox.status.active) throw new Error('Sandbox unavailable');
    const child = spawn(options.sandbox.command, options.sandbox.args, {
      cwd: options.cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: {
        ...withoutSecrets(process.env),
        ...options.sandbox.env,
        PIRC_SANDBOX: 'srt',
        PIRC_SANDBOX_POLICY: JSON.stringify(options.sandbox.policy.paths),
        PIRC_PROJECT_TRUST: options.projectTrust ?? '',
      },
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.control = child.stdio[3] as Writable | undefined;
    this.control?.on('error', () => undefined);
    this.started = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Executor startup timeout'));
        this.close();
      }, 30_000);
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
        this.fail(error);
      };
      const parser = new JsonlParser(RESULT_BYTES, (value) => {
        const message = value as Record<string, any>;
        if (message?.type === 'executor.ready' && !this.ready) {
          this.ready = true;
          clearTimeout(timer);
          resolve();
          return;
        }
        const active = this.active;
        if (!active || message?.executionId !== active.intent.executionId) {
          fail(new Error('Invalid executor reply'));
          return;
        }
        if (message.type === 'executor.result') {
          const terminal = terminalSchema.parse(message.terminal);
          this.active = undefined;
          active.cleanup();
          active.resolve(terminal);
        } else if (message.type === 'executor.progress') {
          active.event('progress', message.output);
        } else if (message.type === 'executor.request') {
          if (
            !['classify', 'lease', 'approval'].includes(message.kind) ||
            typeof message.id !== 'string'
          ) {
            fail(new Error('Invalid executor broker request'));
            return;
          }
          const controller = this.operationController!;
          void options
            .request(message.kind, message.payload, active.intent, controller.signal)
            .then(
              (value) => {
                if (this.active === active)
                  this.send({ type: 'executor.response', id: message.id, value: value ?? null });
              },
              (error) => {
                if (this.active === active)
                  this.send({
                    type: 'executor.response',
                    id: message.id,
                    error: String(error).slice(0, 8192),
                  });
              },
            )
            .catch(fail);
        } else fail(new Error('Unknown executor message'));
      });
      child.stdout.on('data', (chunk: Buffer) => {
        try {
          parser.push(chunk);
        } catch (error) {
          fail(error as Error);
        }
      });
      child.stderr.on('data', () => undefined); // Drain without retaining private hook/config output.
      child.on('error', fail);
      child.on('exit', () => fail(new Error('Sandbox executor exited; effects may be unknown')));
    });
  }
  private operationController: AbortController | undefined;
  get healthy(): boolean {
    return this.ready && !this.closed;
  }
  private send(value: unknown): void {
    if (this.closed || this.child.stdin.writableLength > REQUEST_BYTES)
      throw new Error('Executor IPC unavailable');
    this.child.stdin.write(`${canonicalJson(value, REQUEST_BYTES)}\n`);
  }
  async execute(
    intent: ExecutionIntent,
    signal: AbortSignal,
    event: (kind: ExecutionEvent['kind'], payload: ExecutionEvent['payload']) => void,
  ): Promise<Terminal> {
    await this.started;
    signal.throwIfAborted();
    if (!this.healthy || this.active) throw new Error('Executor unavailable or busy');
    return new Promise((resolve, reject) => {
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      this.operationController = new AbortController();
      const abort = () => {
        this.operationController?.abort();
        try {
          this.send({ type: 'executor.cancel', executionId: intent.executionId });
        } catch {
          /* kill below */
        }
        killTimer = setTimeout(
          () => this.fail(new Error('Executor cancelled; effects may be unknown')),
          1000,
        );
      };
      signal.addEventListener('abort', abort, { once: true });
      this.active = {
        intent,
        resolve,
        reject,
        event,
        cleanup: () => {
          clearTimeout(killTimer);
          signal.removeEventListener('abort', abort);
        },
      };
      try {
        this.send({ type: 'executor.start', intent });
      } catch (error) {
        this.fail(error as Error);
      }
      if (signal.aborted) abort();
    });
  }
  private fail(error: Error): void {
    if (this.active) {
      const active = this.active;
      this.active = undefined;
      active.cleanup();
      active.reject(error);
    }
    this.close();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.operationController?.abort();
    if (this.active) {
      const active = this.active;
      this.active = undefined;
      active.cleanup();
      active.reject(new Error('Executor stopped; outcome unknown'));
    }
    killGroup(this.child.pid, 'SIGKILL');
    this.options.sandbox.cleanup();
  }
}
