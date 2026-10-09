import { createHash } from 'node:crypto';
import type { RuntimeDispatch, DeliveredMessage } from '../daemon/session-dispatch.js';
import type { SessionRow } from '../database.js';
import type { GatewaySessionAuthority } from './authority.js';
import type { GatewayAgentRuntime } from './runtime.js';
import type { WriterLease } from './contracts.js';
import type { Workspace } from '../types.js';
import { canonicalJson } from '../environment/json.js';
import { GatewayServiceDeliveries } from './service-delivery.js';

/** Scheduler/delegation adapter for fresh session identities. Operator supplies the
 * directory registration/provision callback; no legacy ID is automatically retargeted.
 */
export function gatewaySchedulerDispatch(options: {
  authority: GatewaySessionAuthority;
  runtime: GatewayAgentRuntime;
  create(
    workspace: Workspace,
    user: string,
    title: string,
  ): Promise<{ session: SessionRow; lease: WriterLease }>;
  writer(session: SessionRow, user: string): WriterLease;
  configure?(
    lease: WriterLease,
    user: string,
    message: DeliveredMessage,
    signal: AbortSignal,
  ): Promise<void>;
  waiting?(sessionId: string, user: string): boolean;
}): RuntimeDispatch & { close(): Promise<void> } {
  const deliveries = new GatewayServiceDeliveries({
    authority: options.authority,
    runtime: options.runtime,
    ...(options.configure ? { configure: options.configure } : {}),
  });
  return {
    close: () => deliveries.close(),
    start: async (workspace, user, title) => {
      const created = await options.create(workspace, user, title);
      if (
        created.lease.binding.workspaceId !== workspace.id ||
        created.session.ownerUser !== user ||
        created.session.piSessionId !== created.lease.binding.sessionId
      )
        throw new Error('Fresh scheduler session registration mismatch');
      options.authority.assertOwner(created.lease.binding.sessionId, user);
      return created.session;
    },
    deliver: async (session, user, message) => {
      if (!session.piSessionId) throw new Error('Scheduler identity unavailable');
      options.authority.assertFreshReference(session.piSessionId);
      const lease = options.writer(session, user);
      if (
        lease.binding.sessionId !== session.piSessionId ||
        lease.binding.workspaceId !== session.workspaceId ||
        lease.binding.nodeId !== session.nodeId
      )
        throw new Error('Scheduler session cannot be retargeted');
      options.authority.assertFreshReference(lease.binding.sessionId);
      options.authority.assertOwner(lease.binding.sessionId, user);
      const bytes = createHash('sha256')
        .update(`${lease.binding.sessionId}:${canonicalJson(message, 1024 * 1024)}`)
        .digest()
        .subarray(0, 16);
      bytes[6] = (bytes[6]! & 15) | 0x50;
      bytes[8] = (bytes[8]! & 63) | 128;
      const hex = bytes.toString('hex'),
        id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      const input = { runId: id, turnId: id, text: message.content, attachments: [] };
      deliveries.admit(lease, user, input, message);
    },
    progress: async (session, user, _at, isOurs) => {
      if (!session.piSessionId) throw new Error('Scheduler identity unavailable');
      options.authority.assertFreshReference(session.piSessionId);
      const lease = options.writer(session, user);
      if (
        lease.binding.sessionId !== session.piSessionId ||
        lease.binding.workspaceId !== session.workspaceId ||
        lease.binding.nodeId !== session.nodeId
      )
        throw new Error('Scheduler session cannot be retargeted');
      options.authority.assertFreshReference(lease.binding.sessionId);
      options.authority.assertOwner(lease.binding.sessionId, user);
      const target = options.authority
        .serviceMessages(lease.binding.sessionId, user)
        .find((message) =>
          isOurs({ role: 'custom', customType: message.customType, details: message.details }),
        );
      if (!target) return { state: 'queued' };
      const run = options.authority.serviceTurnRun(lease.binding.sessionId, user, target.turnId);
      if (!run) {
        const delivery = deliveries.status(target.turnId, user);
        if (delivery?.state === 'interrupted' || delivery?.state === 'failed')
          return {
            state: 'over',
            status: 'interrupted',
            failureReason: delivery.reason,
            answer: '',
          };
        return { state: delivery?.state === 'queued' ? 'queued' : 'working' };
      }
      if (run.state === 'running')
        return { state: options.waiting?.(lease.binding.sessionId, user) ? 'waiting' : 'working' };

      return {
        state: 'over',
        status:
          run.state === 'completed'
            ? 'succeeded'
            : run.state === 'failed'
              ? 'failed'
              : 'interrupted',
        failureReason: run.reason,
        answer: options.authority.runAnswer(lease.binding.sessionId, user, run.id),
      };
    },
  };
}
