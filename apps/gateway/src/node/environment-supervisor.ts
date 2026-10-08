import {
  EnvironmentCleanupUnverified,
  type SandboxedEnvironmentExecutor,
} from './environment-executor.js';
import type { ExecutionJournal } from '../environment/journal.js';
import type { ApprovalAuthority } from '../environment/approvals.js';
import type { LocalEnvironment } from '../environment/service.js';
import type { Binding, ExecutionRecord } from '../environment/protocol.js';
import type { WriteBroker } from './write-broker.js';

/** Trusted startup must call this before executor provisioning, including after a node restart. */
export function restoreEnvironmentQuarantines(
  journal: ExecutionJournal,
  writes: WriteBroker,
): void {
  for (const entry of journal.quarantines())
    writes.quarantine(entry.binding.sessionId, entry.paths);
}

/** Recovery is a trusted lifecycle action, never an execution/status RPC. */
export async function fenceEnvironment(options: {
  binding: Binding;
  environment: LocalEnvironment;
  executor: SandboxedEnvironmentExecutor;
  journal: ExecutionJournal;
  approvals: ApprovalAuthority;
  writes: WriteBroker;
}): Promise<{ recovered: ExecutionRecord[]; quarantined?: string }> {
  const quiesced = options.environment.quiesceBinding(options.binding, true);
  void quiesced.catch(() => {});
  options.approvals.invalidate(options.binding);
  // Do not classify running work until the old process has actually terminated.
  let quarantined: string | undefined;
  try {
    await options.executor.closeAndWait();
  } catch (error) {
    // Persist a deny fence for every shutdown failure, but reconcile only when
    // the executor IPC and supervisor broker work have actually drained.
    options.writes.quarantine(options.binding.sessionId);
    options.journal.quarantine(options.binding, options.writes.leases(options.binding.sessionId));
    if (!(error instanceof EnvironmentCleanupUnverified)) throw error;
    quarantined = (error as Error).message;
  }
  await quiesced;
  // Recording unfinished work as unknown and retiring the generation only narrow
  // what it may do, so both happen even under quarantine; that is what lets the
  // gateway reconcile after a restart on platforms without aggregate fencing.
  const recovered = options.journal.recover(options.binding);
  options.journal.retire(options.binding);
  // A later successful close cannot silently clear an earlier persistent fence.
  if (
    !quarantined &&
    options.journal
      .quarantines()
      .some(
        (entry) =>
          entry.binding.nodeId === options.binding.nodeId &&
          (entry.binding.sessionId === options.binding.sessionId ||
            entry.binding.workspaceId === options.binding.workspaceId),
      )
  )
    quarantined = 'Binding remains quarantined; independent operator recovery required';
  // Releasing write leases is a regrant and still needs aggregate proof.
  if (quarantined) return { recovered, quarantined };
  options.writes.release(options.binding.sessionId);
  return { recovered };
}
