import type { GatewaySessionAuthority } from './authority.js';
import type { WriterLease } from './contracts.js';

/** Snapshot compatibility projection. It never substitutes historical admission sandbox
 * status for live environment health, nor conceals that older history is paginated.
 */
export function runtimeClientSnapshot(options: {
  authority: GatewaySessionAuthority;
  lease: WriterLease;
  owner: string;
  running: boolean;
  sandbox?: { active: boolean; reason?: string };
}) {
  const { authority, lease, owner } = options;
  authority.assertOwner(lease.binding.sessionId, owner);
  const settings = authority.settings(lease.binding.sessionId, owner, lease.branchId),
    run = authority.latestRun(lease.binding.sessionId, owner, lease.branchId);
  const status =
    run?.state === 'completed'
      ? 'succeeded'
      : run?.state === 'running'
        ? 'running'
        : run?.state === 'failed'
          ? 'failed'
          : run
            ? 'interrupted'
            : undefined;
  const updatedAt = Date.now();
  return {
    authority: 'gateway',
    session: {
      id: lease.binding.sessionId,
      workspaceId: lease.binding.workspaceId,
      name: settings.title ?? 'New session',
      runnerState: options.running ? 'running' : 'stopped',
      runStatus: status,
      updatedAt,
    },
    run: run ? { id: run.id, status, failureReason: run.reason } : null,
    ...authority.recentHistory(lease.binding.sessionId, owner, lease.branchId),
    operations: [],
    interactions: [],
    queue: { steering: [], followUp: [] },
    notifications: [],
    widgets: {},
    statuses: {},
    watermark: {
      epoch: lease.binding.writerEpoch,
      sequence: authority.watermark(lease.binding.sessionId, owner, lease.branchId),
    },
    agent: { model: settings.model, thinkingLevel: settings.thinking },
    ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    runtime: { location: 'gateway', environmentNodeId: lease.binding.nodeId },
  };
}
