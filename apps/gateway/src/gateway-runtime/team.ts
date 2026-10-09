import { randomUUID } from 'node:crypto';
import {
  Team,
  type TeamChild,
  type TeamOptions,
  type TeamTask,
} from '../agent/features/team/team.js';
import type { GatewayAgentRuntime, RuntimeEvent } from './runtime.js';
import type { GatewaySessionAuthority } from './authority.js';
import type { WriterLease } from './contracts.js';

/** A child is another authoritative gateway session, never a node Agent subprocess.
 * Provision callback MUST resolve cwd and intersect policy on the bound node before
 * returning a fresh writer lease. This trusted adapter is not a provisioning endpoint.
 */
export function gatewayTeam(options: {
  authority: GatewaySessionAuthority;
  parent: WriterLease;
  owner: string;
  team: Omit<TeamOptions, 'runtime' | 'directory' | 'command'>;
  provision(
    request: {
      name: string;
      cwd: string;
      role: string;
      tools?: string[];
      mode: string;
      model: string;
      thinking: string;
      call(operation: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
    },
    signal?: AbortSignal,
  ): Promise<{
    runtime: GatewayAgentRuntime;
    lease: WriterLease;
    subscribe(listener: (event: RuntimeEvent) => void): () => void;
  }>;
}): Team {
  const record = (customType: string, data: unknown) =>
    options.authority.append(options.parent, randomUUID(), {
      type: 'custom',
      customType,
      data: JSON.parse(JSON.stringify(data)),
    });
  const team = new Team({
    ...options.team,
    directory: `gateway:${options.parent.binding.sessionId}`,
    command: [],
    runtime: {
      record: (entry) => {
        record('runtime.team.event', entry);
      },
      tasks: (tasks) => {
        record('runtime.team.tasks', tasks);
      },
      snapshot: (state) => {
        record('runtime.team.snapshot', state);
      },
      cwd: (_base, requested) => {
        if (typeof requested !== 'string' || requested.length > 4096 || requested.includes('\0'))
          throw new Error('Invalid child cwd');
        return requested;
      },
      launch: async (member, event, signal) => {
        const child = await options.provision(
          {
            name: member.name,
            cwd: member.cwd,
            role: member.kind,
            ...(member.tools ? { tools: member.tools } : {}),
            mode: member.mode,
            model: member.model,
            thinking: member.thinking,
            call: (operation, args, signal) => team.call(member.name, operation, args, signal),
          },
          signal,
        );
        if (
          child.lease.binding.nodeId !== options.parent.binding.nodeId ||
          child.lease.binding.workspaceId !== options.parent.binding.workspaceId
        )
          throw new Error('Child moved to foreign environment');
        let stopped = false,
          running = false,
          settle!: (code: number) => void;
        let activeRunId: string | undefined;
        let stopping: Promise<void> | undefined;
        const exited = new Promise<number>((resolve) => (settle = resolve));
        const unsubscribe = child.subscribe((value) => event(value));
        const rpc: TeamChild = {
          proc: { pid: 0 },
          stderr: '',
          exited,
          write: (message) => {
            if (message.type === 'configure') return; // Role/capabilities were validated at node provisioning.
            if (message.type === 'team_result')
              throw new Error('Child team-call relay requires bound broker');
            throw new Error('Unsupported gateway child message');
          },
          request: async (type, args = {}) => {
            if (stopped) throw new Error('Child stopped');
            if (type === 'get_state')
              return { sessionFile: `gateway:${child.lease.binding.sessionId}` };
            if (type !== 'prompt') throw new Error('Unsupported gateway child request');
            const input = {
              runId: activeRunId ?? randomUUID(),
              turnId: randomUUID(),
              text: String(args.message ?? ''),
              attachments: [],
            };
            options.authority.enrollServiceTurn(
              child.lease,
              input,
              member.mode === 'subagent' ? 'subagent.task' : 'team.message',
              { from: 'parent', member: member.name },
            );
            if (running) {
              child.runtime.steer(child.lease, options.owner, input);
              return {};
            }
            running = true;
            activeRunId = input.runId;
            event({ type: 'agent_start' });
            void child.runtime
              .run(child.lease, options.owner, input)
              .then(
                (state) => {
                  if (
                    state.state === 'failed' ||
                    state.state === 'unknown' ||
                    state.state === 'interrupted'
                  )
                    event({
                      type: 'message_end',
                      message: {
                        role: 'assistant',
                        stopReason: 'error',
                        errorMessage: state.reason ?? state.state,
                      },
                    });
                },
                (error) =>
                  event({
                    type: 'message_end',
                    message: {
                      role: 'assistant',
                      stopReason: 'error',
                      errorMessage: String(error),
                    },
                  }),
              )
              .finally(() => {
                running = false;
                activeRunId = undefined;
                if (!stopped) event({ type: 'agent_settled' });
              });
            return {};
          },
          stop: () => {
            if (stopping) return stopping;
            stopped = true;
            stopping = (async () => {
              try {
                await child.runtime.cancel(child.lease.binding.sessionId, options.owner);
              } finally {
                try {
                  await child.runtime.close();
                } finally {
                  unsubscribe();
                  settle(0);
                }
              }
            })();
            return stopping;
          },
        };
        return rpc;
      },
    },
  });
  const entries = ['runtime.team.event', 'runtime.team.tasks', 'runtime.team.snapshot'].flatMap(
    (type) =>
      options.authority.customEntries(
        options.parent.binding.sessionId,
        options.owner,
        options.parent.branchId,
        type,
        type === 'runtime.team.event' ? 10_000 : 1,
        type !== 'runtime.team.event',
      ),
  );
  const records = entries.flatMap((entry) =>
    entry.type === 'custom' && entry.customType === 'runtime.team.event'
      ? [entry.data as Record<string, any>]
      : [],
  );
  const tasks = entries.findLast(
    (entry) => entry.type === 'custom' && entry.customType === 'runtime.team.tasks',
  );
  const snapshot = entries.findLast(
    (entry) => entry.type === 'custom' && entry.customType === 'runtime.team.snapshot',
  );
  if (records.length || tasks || snapshot)
    team.restoreStopped({
      records,
      tasks: tasks?.type === 'custom' ? (tasks.data as TeamTask[]) : [],
      agents:
        snapshot?.type === 'custom'
          ? ((snapshot.data as { agents?: Record<string, any>[] }).agents ?? [])
          : [],
    });
  return team;
}
