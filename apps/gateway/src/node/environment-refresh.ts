import type { Descriptor } from '../environment/protocol.js';
import type { LocalEnvironment } from '../environment/service.js';
import type { ApprovalAuthority } from '../environment/approvals.js';
import type { HookReceipts } from '../environment/hook-receipts.js';
import type { ExecutionJournal } from '../environment/journal.js';
import type { SandboxedEnvironmentExecutor } from './environment-executor.js';
import type { EnvironmentAuthority } from './environment-authority.js';
import type { WriteBroker } from './write-broker.js';
import { fenceEnvironment } from './environment-supervisor.js';
import { EnvironmentCleanupUnverified } from './environment-executor.js';

/** Policy/config refresh is a fenced executor-generation replacement, never a partial setter. */
export async function replaceEnvironment(options: {
  previous: Descriptor;
  next: Descriptor;
  environment: LocalEnvironment;
  executor: SandboxedEnvironmentExecutor;
  authority: EnvironmentAuthority;
  approvals: ApprovalAuthority;
  receipts: HookReceipts;
  journal: ExecutionJournal;
  writes: WriteBroker;
  /** New authority and executor must both be constructed from the same trusted config snapshot. */
  create(): Promise<SandboxedEnvironmentExecutor>;
  backgroundActive(): boolean;
}) {
  if (
    options.previous.binding.sessionId !== options.next.binding.sessionId ||
    options.previous.binding.nodeId !== options.next.binding.nodeId ||
    options.previous.binding.workspaceId !== options.next.binding.workspaceId ||
    options.previous.binding.executorEpoch === options.next.binding.executorEpoch
  )
    throw new Error('Refresh requires a fresh executor generation on the same session/workspace');
  await options.environment.quiesceBinding(options.previous.binding);
  if (options.backgroundActive())
    throw new Error(
      'Binding quiesced; explicit background-job stop/handoff required before policy refresh',
    );
  options.authority.invalidate();
  options.approvals.invalidate(options.previous.binding);
  options.receipts.invalidate(options.previous.binding);
  const fenced = await fenceEnvironment({ ...options, binding: options.previous.binding });
  if (fenced.quarantined) throw new EnvironmentCleanupUnverified(fenced.quarantined);
  const executor = await options.create();
  await executor.started;
  options.environment.provision(options.next, executor);
  return executor;
}
