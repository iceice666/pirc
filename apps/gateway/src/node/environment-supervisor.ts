import type { SandboxedEnvironmentExecutor } from './environment-executor.js';
import type { ExecutionJournal } from '../environment/journal.js';
import type { ApprovalAuthority } from '../environment/approvals.js';
import type { LocalEnvironment } from '../environment/service.js';
import type { Binding } from '../environment/protocol.js';
import type { WriteBroker } from './write-broker.js';

/** Recovery is a trusted lifecycle action, never an execution/status RPC. */
export async function fenceEnvironment(options: {
  binding: Binding;
  environment: LocalEnvironment;
  executor: SandboxedEnvironmentExecutor;
  journal: ExecutionJournal;
  approvals: ApprovalAuthority;
  writes: WriteBroker;
}) {
  const quiesced = options.environment.quiesceBinding(options.binding, true);
  options.approvals.invalidate(options.binding);
  // Do not classify running work until the old process has actually terminated.
  await options.executor.closeAndWait();
  await quiesced;
  const recovered = options.journal.recover(options.binding);
  options.journal.retire(options.binding);
  options.writes.release(options.binding.sessionId);
  return recovered;
}
