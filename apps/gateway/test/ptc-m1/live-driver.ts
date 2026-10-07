/** Test-only Linux JSONL driver. No production agent or tool surface changes. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { NodeSandbox, srtSettings, sandboxBinDir } from '../../src/node/sandbox.js';
import { embeddedSeccomp } from '../../src/node/srt.js';
import { JsonlParser } from '../../src/node/rpc-framing.js';
import type { NodeConfig } from '../../src/config.js';
import type { ModelsConfig } from '../../src/models.js';
import type { Fixture } from './fixtures.js';
import { CgroupWindow } from './resources.js';
import { stopUnit } from './unit-lifecycle.js';
import type { DisposablePair } from './disposable-pair.js';

export interface DriverEvent {
  sequence: number;
  at: number;
  value: Record<string, any>;
}
export async function startMeasuredAgent(options: {
  binary: string;
  fixture: Fixture;
  models: ModelsConfig;
  /** Trusted controller/provider state; hidden except the selected admission socket directory. */
  providerStateDir: string;
  /** Deterministic in-memory service/oracle receiver. Never log or persist events. */
  onEvent: (event: DriverEvent, reply: (value: unknown) => void) => void;
  onFatal?: () => void;
  pair?: DisposablePair;
  /** Feature settings for the disposable config (round 4: session titles off, both arms). */
  features?: Record<string, unknown>;
  /** The prompt's settle deadline (default 180 s; longer for public-benchmark exercises). */
  trialDeadlineMs?: number;
}) {
  if (
    process.platform !== 'linux' ||
    !path.isAbsolute(options.binary) ||
    !path.isAbsolute(options.providerStateDir) ||
    !options.models.inference
  )
    throw new Error('Pinned Linux binary and private inference required');
  const paired = await options.pair?.acquire();
  const root = paired?.root ?? (await mkdtemp('/tmp/ptc-run-'));
  const removeRoot = () => (paired ? paired.release() : rm(root, { recursive: true, force: true }));
  let prepared: Awaited<ReturnType<NodeSandbox['prepare']>> | undefined;
  let childLaunched = false;
  try {
    const workspace = path.join(root, 'workspace');
    const state = path.join(root, 'state');
    const session = path.join(state, 'sessions', 'fixture');
    const configDir = path.join(root, 'config');
    const home = path.join(root, 'home');
    for (const dir of [workspace, state, session, configDir, home])
      await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const [name, content] of Object.entries(options.fixture.files)) {
      const file = path.resolve(workspace, name);
      if (!file.startsWith(`${workspace}/`)) throw new Error('Unsafe fixture file');
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    // Defaults (title, classifier, memory) stay enabled unless `features` overrides them (round 4
    // turns session titles off for both arms). Never inherit host config.
    await writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        ...(options.features ? { features: options.features } : {}),
        sandbox: {
          network: { defaultDomains: false, allowedDomains: [] },
          filesystem: {
            denyRead: [options.providerStateDir],
            denyWrite: [options.providerStateDir],
          },
        },
      }),
      { mode: 0o600 },
    );
    const srt = path.join(root, 'srt');
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(srt, `#!/bin/sh\nexec ${quote(options.binary)} srt "$@"\n`, { mode: 0o700 });
    const config: NodeConfig = {
      nodeId: 'evaluation',
      nodeToken: '',
      daemonUrl: 'ws://127.0.0.1:1',
      allowedUsers: new Set(),
      stateDir: state,
      databasePath: path.join(state, 'unused.sqlite'),
      sessionsDir: path.join(state, 'sessions'),
      uploadsDir: path.join(state, 'uploads'),
      agentCommand: options.binary,
      agentArgs: ['agent', '--session-dir', session],
      workspaces: [],
      chat: options.fixture.kind === 'chat',
      workspaceMemoryDir: path.join(state, 'memory'),
      memoryMirrorMs: 30000,
      eventBufferSize: 20,
      rpcMaxLineBytes: 16 * 1024 * 1024,
      uploadMaxBytes: 1024 * 1024,
      terminalsEnabled: false,
      browser: {
        enabled: false,
        ffmpeg: 'ffmpeg',
        profilesDir: path.join(state, 'browser'),
        idleMs: 60000,
        viewport: { width: 800, height: 600 },
      },
      sandbox: { srt },
      leaseTtlMs: 5000,
      interactionTtlMs: 5000,
      shutdownGraceMs: 1000,
    };
    const env = {
      PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
      HOME: home,
      PIRC_CONFIG_DIR: configDir,
    };
    const sandbox = (prepared = await new NodeSandbox(config, env).prepare({
      sessionId: 'fixture',
      workspaceRoot: workspace,
      sessionDir: session,
      inferenceSocket: options.models.inference.socketPath,
      protectedPaths: [
        options.binary,
        options.models.inference.socketPath,
        path.join(root, 'launch.sh'),
        path.join(root, 'launcher.pid'),
        srt,
      ],
    }));
    // The external command is still the binary's embedded srt; supply its bundled Linux
    // helper explicitly, as NodeSandbox does for its built-in invocation.
    const helper = embeddedSeccomp(sandboxBinDir(state));
    await writeFile(sandbox.settingsFile, JSON.stringify(srtSettings(sandbox.policy, [], helper)), {
      mode: 0o600,
    });
    const unit = `ptc-m1-${randomUUID()}.service`;
    // systemd captures every descendant even if it creates a new session/process group.
    // No Delegate=yes: an agent must not move processes out of the measured group.
    const launch = path.join(root, 'launch.sh');
    const pidFile = path.join(root, 'launcher.pid');
    await writeFile(
      launch,
      `#!/bin/sh\nset -eu\nprintf '%s' "$$" > ${quote(pidFile)}\nexec env -i ${Object.entries({
        ...env,
        PIRC_GATEWAY: '1',
        PIRC_BROWSER: '1',
        PIRC_WORKSPACE_KIND: options.fixture.kind === 'chat' ? 'chat' : 'directory',
        PIRC_WORKSPACE_MEMORY_DIR: config.workspaceMemoryDir,
        PIRC_SANDBOX: 'srt',
        PIRC_SANDBOX_POLICY: JSON.stringify(sandbox.policy.paths),
        ...sandbox.env,
      })
        .map(([key, value]) => `${key}=${quote(value)}`)
        .join(' ')} ${quote(sandbox.command)} ${sandbox.args.map(quote).join(' ')} 3</dev/null\n`,
      { mode: 0o700 },
    );
    const startup = performance.now();
    const child = spawn(
      'systemd-run',
      [
        '--user',
        '--quiet',
        '--pipe',
        '--wait',
        '--collect',
        `--unit=${unit}`,
        '--property=MemoryAccounting=yes',
        '--property=CPUAccounting=yes',
        '--property=KillMode=control-group',
        '--property=NoNewPrivileges=yes',
        '--property=LimitCORE=0',
        `--working-directory=${workspace}`,
        launch,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    ) as ChildProcessWithoutNullStreams;
    childLaunched = true;
    let sequence = 0;
    let failure: Error | null = null;
    let exited = false;
    let counter = 0;
    let activeTrial = false;
    let started = false;
    let settled: { at: number } | null = null;
    let resourceEnd: Promise<Awaited<ReturnType<CgroupWindow['end']>>> | null = null;
    const pending = new Map<
      string,
      {
        resolve: (value: Record<string, any>) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    let wake: (() => void) | null = null;
    const fail = () => {
      if (failure) return;
      failure = new Error('Evaluation agent transport failed');
      try {
        options.onFatal?.();
      } catch {
        /* retain failure */
      }
      void stopUnit(unit).catch(() => undefined);
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(failure);
      }
      pending.clear();
      wake?.();
    };
    const reply = (value: unknown) => {
      if (exited || failure) throw new Error('Evaluation agent unavailable');
      child.stdin.write(`${JSON.stringify(value)}\n`);
    };
    const parser = new JsonlParser(16 * 1024 * 1024, (raw) => {
      if (!raw || typeof raw !== 'object') throw new Error('Invalid agent frame');
      const value = raw as Record<string, any>;
      const event = { sequence: ++sequence, at: performance.now(), value };
      if (value.type === 'response') {
        const waiter = pending.get(value.id);
        if (waiter) {
          pending.delete(value.id);
          clearTimeout(waiter.timer);
          waiter.resolve(value);
        }
      }
      if (activeTrial && value.type === 'agent_start') started = true;
      if (activeTrial && started && value.type === 'agent_settled' && !settled) {
        settled = { at: event.at };
        resourceEnd = resources!.end();
        void resourceEnd.catch(() => fail());
        wake?.();
      }
      options.onEvent(event, reply);
    });
    child.stdout.on('data', (chunk) => {
      try {
        parser.push(chunk);
      } catch {
        fail();
      }
    });
    child.stdout.on('end', () => {
      try {
        parser.end();
      } catch {
        fail();
      }
    });
    // Drain, but do not persist or echo potentially content-bearing stderr.
    child.stderr.on('data', () => undefined);
    child.stdin.on('error', fail);
    child.on('error', fail);
    const exit = new Promise<void>((resolve) =>
      child.once('close', (code) => {
        exited = true;
        if (code !== 0 && !closing) fail();
        if (pending.size || (activeTrial && !settled)) fail();
        resolve();
      }),
    );
    const send = (value: Record<string, unknown>) =>
      new Promise<Record<string, any>>((resolve, reject) => {
        const id = `evaluation-${++counter}`;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Evaluation RPC timeout'));
        }, 30000);
        pending.set(id, { resolve, reject, timer });
        try {
          reply({ ...value, id });
        } catch {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error('Evaluation RPC unavailable'));
        }
      });
    let resources: CgroupWindow | null = null;
    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= (async () => {
        child.stdin.end();
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          exit,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 10000);
          }),
        ]);
        clearTimeout(timer);
        let cleanupFailed = false;
        try {
          await stopUnit(unit);
          if (resources && !(await resources.empty())) cleanupFailed = true;
        } catch {
          cleanupFailed = true;
        }
        const terminationVerified = !cleanupFailed;
        if (!terminationVerified) options.pair?.invalidate();
        child.kill('SIGKILL');
        try {
          await resources?.close();
        } catch {
          cleanupFailed = true;
        }
        try {
          if (terminationVerified) sandbox.cleanup();
        } catch {
          cleanupFailed = true;
        }
        try {
          if (terminationVerified) await removeRoot();
        } catch {
          cleanupFailed = true;
        }
        if (cleanupFailed || failure) throw new Error('Evaluation cleanup or transport failed');
      })());
    try {
      reply({
        type: 'configure',
        models: options.models,
        capabilities: options.fixture.id === 'permission-rejection' ? { web_search: false } : {},
      });
      const state = await send({ type: 'get_state' });
      if (!state.success || typeof state.data?.sessionId !== 'string')
        throw new Error('Evaluation startup rejected');
      const startupMs = performance.now() - startup;
      const pid = Number(await readFile(pidFile, 'utf8'));
      if (!/^Max core file size\s+0\s+0\s/m.test(await readFile(`/proc/${pid}/limits`, 'utf8')))
        throw new Error('Measured unit core limit is not zero');
      resources = await CgroupWindow.attach(pid, unit);
      return {
        workspace,
        sessionId: state.data.sessionId as string,
        startupMs,
        send,
        reply,
        async prompt() {
          if (activeTrial) throw new Error('One prompt per measured process');
          await resources!.begin();
          activeTrial = true;
          const dispatch = performance.now();
          const acknowledgment = await send({ type: 'prompt', message: options.fixture.prompt });
          if (!acknowledgment.success) throw new Error('Evaluation prompt rejected');
          let deadlineExceeded = false;
          const settle = (ms: number) =>
            new Promise<boolean>((resolve) => {
              const timer = setTimeout(() => {
                wake = null;
                resolve(false);
              }, ms);
              wake = () => {
                clearTimeout(timer);
                wake = null;
                resolve(true);
              };
            });
          if (!settled && !failure && !(await settle(options.trialDeadlineMs ?? 180000))) {
            // With an explicit deadline (public-benchmark exercises) the trial is stopped and
            // counted as a failed attempt; otherwise, as before, it is an evaluation failure.
            if (!options.trialDeadlineMs) throw new Error('Evaluation trial deadline');
            deadlineExceeded = true;
            await send({ type: 'abort' }).catch(() => undefined);
            if (!settled && !failure && !(await settle(60000)))
              throw new Error('Evaluation trial deadline');
          }
          if (failure || !settled) throw new Error('Evaluation did not settle');
          const end = settled as { at: number };
          const measured = await resourceEnd!;
          return {
            wallMs: end.at - dispatch,
            startupMs,
            cpuMs: measured.cpuMs,
            cgroupMemoryPeakBytes: measured.cgroupMemoryPeakBytes,
            resourceStartLeadMs: dispatch - measured.startSampleAt,
            resourceEndLagMs: measured.endSampleAt - end.at,
            memoryWindow: 'unit-start-through-post-settled-sample' as const,
            cpuWindow: 'pre-dispatch-through-post-settled-sample' as const,
            ...(deadlineExceeded ? { deadlineExceeded: true } : {}),
          };
        },
        close,
      };
    } catch {
      await close();
      throw new Error('Evaluation startup failed');
    }
  } catch {
    if (!childLaunched) {
      prepared?.cleanup();
      await removeRoot();
    }
    throw new Error('Evaluation startup failed');
  }
}
