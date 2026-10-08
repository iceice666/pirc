import path from 'node:path';
import { statSync } from 'node:fs';
import type { SandboxedEnvironmentExecutor } from './environment-executor.js';
import type { PreparedSandbox } from './sandbox.js';
import { withoutSecrets } from './secrets.js';
import { spawn } from 'node:child_process';
import { killGroup } from '../agent/tools/bash.js';
import { PathGuard } from '../agent/sandbox.js';
import { DOMAIN_PATTERN, isInside, realResolve } from '../sandbox-policy.js';
import type { AgentConfig } from '../agent/config.js';
import type { WriteBroker } from './write-broker.js';
import type { BrowserManager, BrowserTarget } from './browser.js';
import type { ApprovalAuthority } from '../environment/approvals.js';
import type { BrokerKind } from '../environment/broker.js';
import type { Descriptor, ExecutionIntent } from '../environment/protocol.js';
import { canonicalJson } from '../environment/json.js';
import { CONTROL_BYTES } from '../environment/protocol.js';

/** Explicitly provisioned node authority. No production session adopts it implicitly. */
export class EnvironmentAuthority {
  private domains = new Set<string>();
  constructor(
    private readonly options: {
      descriptor: Descriptor;
      config: AgentConfig;
      sandbox: PreparedSandbox;
      executor(): SandboxedEnvironmentExecutor;
      approvals: ApprovalAuthority;
      writes: WriteBroker;
      browser?: BrowserManager;
      classify?(
        payload: Record<string, any>,
        intent: ExecutionIntent,
        signal: AbortSignal,
      ): Promise<unknown>;
      confirm?(
        title: string,
        message: string,
        intent: ExecutionIntent,
        signal: AbortSignal,
      ): Promise<boolean>;
    },
  ) {}
  private check(intent: ExecutionIntent, signal: AbortSignal): void {
    signal.throwIfAborted();
    const descriptor = this.options.descriptor;
    if (
      canonicalJson(intent.binding, CONTROL_BYTES) !==
        canonicalJson(descriptor.binding, CONTROL_BYTES) ||
      intent.descriptorRevision !== descriptor.revision ||
      intent.policyRevision !== descriptor.policyRevision
    )
      throw new Error('Stale environment authority');
    if (!this.options.executor().healthy) throw new Error('Sandbox unavailable');
    if (
      !descriptor.capabilityCatalog.some(
        (entry) => entry.name === intent.capability && entry.placement === 'node',
      )
    )
      throw new Error('Capability unavailable');
  }
  invalidate(): void {
    this.options.approvals.invalidate(this.options.descriptor.binding);
    this.domains.clear();
    if (this.options.executor().healthy) this.options.executor().updateNetwork([]);
  }
  async request(
    kind: BrokerKind,
    payload: Record<string, any>,
    intent: ExecutionIntent,
    signal: AbortSignal,
  ): Promise<unknown> {
    this.check(intent, signal);
    const root = realResolve(this.options.config.workspace);
    if (kind === 'lease') {
      const guard = new PathGuard(
        root,
        this.options.config.pathPolicy,
        this.options.config.protectedPaths,
      );
      const resolved = guard.resolve(payload.root, 'write');
      if (guard.leaseRoot(resolved) !== resolved) throw new Error('Invalid lease root');
      const result = this.options.writes.acquire(intent.binding.sessionId, resolved);
      if (!result.granted) throw new Error(`Workspace lease held by ${result.holder}`);
      return null;
    }
    if (kind === 'classify') {
      if (!this.options.classify) throw new Error('Classifier unavailable');
      return this.options.classify(payload, intent, signal);
    }
    if (kind === 'ui') {
      if (intent.capability !== 'browser_handoff' || !this.options.confirm)
        throw new Error('Human handoff unavailable');
      return this.options.confirm(payload.title, payload.message, intent, signal);
    }
    if (kind === 'approval')
      return this.options.approvals.request(
        intent,
        {
          action: 'danger',
          finalArgumentDigest: payload.finalArgumentDigest,
          title: 'Allow this operation?',
          message: `${payload.action.text}\n\n${payload.reason}`,
        },
        signal,
        this.options.executor().remainingAbsoluteMs(),
      );
    if (kind === 'browser') {
      if (!this.options.browser) throw new Error('Browser unavailable');
      const expected: Record<string, string[]> = {
        web_fetch: ['fetch'],
        browser_handoff: ['handoff', 'wait_control', 'release', 'snapshot'],
      };
      const allowed = expected[intent.capability] ?? [intent.capability.replace(/^browser_/, '')];
      if (!allowed.includes(payload.op)) throw new Error('Invalid browser operation');
      const expectedArgs =
        intent.capability === 'browser_handoff'
          ? payload.op === 'handoff'
            ? { reason: payload.arguments.reason }
            : {}
          : payload.arguments;
      if (
        canonicalJson(payload.args, 8 * 1024 * 1024) !==
        canonicalJson(expectedArgs, 8 * 1024 * 1024)
      )
        throw new Error('Browser final arguments mismatch');
      const target: BrowserTarget = {
        sessionId: intent.binding.sessionId,
        workspaceId: intent.binding.workspaceId,
        root,
      };
      return this.options.browser.handle(target, payload.op, payload.args, signal);
    }
    if (kind !== 'sandbox') throw new Error('Unsupported authority request');
    const args = payload.args;
    if (payload.op === 'network') {
      if (
        intent.capability !== 'sandbox_allow_domains' ||
        JSON.stringify(args.domains) !== JSON.stringify(payload.arguments.domains) ||
        args.reason !== payload.arguments.reason
      )
        throw new Error('Network arguments mismatch');
      const domains: string[] = [
        ...new Set<string>(
          (Array.isArray(args.domains) ? args.domains : []).map((item: unknown) =>
            String(item).trim().toLowerCase(),
          ),
        ),
      ];
      if (
        !domains.length ||
        domains.length > 10 ||
        domains.some((item) => !DOMAIN_PATTERN.test(item))
      )
        throw new Error('Invalid domains');
      const existing = new Set([
        ...this.options.sandbox.policy.network.allowedDomains,
        ...this.domains,
      ]);
      const missing = domains.filter((item) => !existing.has(item));
      if (missing.length) {
        const approved = await this.options.approvals.request(
          intent,
          {
            action: 'network',
            finalArgumentDigest: payload.finalArgumentDigest,
            title: 'Allow network access?',
            message: `${missing.join(', ')}\n\n${String(args.reason).slice(0, 500)}`,
          },
          signal,
          this.options.executor().remainingAbsoluteMs(),
        );
        if (!approved) return { granted: [], denied: missing };
        this.check(intent, signal);
        for (const domain of missing) this.domains.add(domain);
        this.options.executor().updateNetwork(this.domains);
      }
      return { granted: domains, denied: [] };
    }
    if (
      intent.capability !== 'unsandboxed_bash' ||
      args.command !== payload.arguments.command ||
      args.reason !== payload.arguments.reason ||
      args.cwd !== payload.arguments.cwd ||
      args.timeoutMs !==
        (typeof payload.arguments.timeout === 'number'
          ? payload.arguments.timeout * 1000
          : undefined)
    )
      throw new Error('Host arguments mismatch');
    if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 20_000)
      throw new Error('Invalid host command');
    const cwd = realResolve(path.resolve(root, args.cwd || '.'));
    if (!isInside(cwd, root) || !statSync(cwd).isDirectory()) throw new Error('Invalid host cwd');
    if (!this.options.writes.leases(intent.binding.sessionId).includes(root))
      throw new Error('Missing workspace write lease');
    const approved = await this.options.approvals.request(
      intent,
      {
        action: 'host_exec',
        finalArgumentDigest: payload.finalArgumentDigest,
        title: 'Run a command outside the sandbox?',
        message: `$ ${args.command}\nin ${cwd}\n\n${String(args.reason).slice(0, 500)}`,
      },
      signal,
      this.options.executor().remainingAbsoluteMs(),
    );
    if (!approved) throw new Error('The user did not approve running outside the sandbox');
    this.check(intent, signal);
    // Re-resolve after the human wait: symlinks may have changed while approval was pending.
    if (realResolve(path.resolve(root, args.cwd || '.')) !== cwd || !statSync(cwd).isDirectory())
      throw new Error('Host cwd changed');
    return runEnvironmentHost(
      args.command,
      cwd,
      Math.min(Math.max(args.timeoutMs ?? 120_000, 1000), 3_600_000),
      signal,
    );
  }
}

export function runEnvironmentHost(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-c', command], {
      cwd,
      env: withoutSecrets(process.env),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let head = Buffer.alloc(0),
      tail = Buffer.alloc(0),
      bytes = 0;
    const collect = (chunk: Buffer) => {
      bytes += chunk.length;
      const room = 500_000 - head.length;
      head = Buffer.concat([head, chunk.subarray(0, Math.max(0, room))]);
      tail = Buffer.concat([tail, chunk.subarray(Math.max(0, room))]).subarray(-500_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let timedOut = false,
      aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      killGroup(child.pid, 'SIGTERM');
      killTimer ??= setTimeout(() => killGroup(child.pid, 'SIGKILL'), 1000);
    };
    const abort = () => {
      aborted = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.once('error', (error) => collect(Buffer.from(String(error))));
    child.once('close', async (exitCode) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      // Group descendants may ignore TERM after the leader closes; keep escalation armed.
      if (killTimer) await new Promise((resolve) => setTimeout(resolve, 1100));
      const truncated = bytes > head.length + tail.length;
      resolve({
        output: head.toString() + (truncated ? '\n[… output truncated …]\n' : '') + tail.toString(),
        exitCode: aborted || timedOut ? null : exitCode,
        timedOut,
        aborted,
        truncated,
      });
    });
  });
}
