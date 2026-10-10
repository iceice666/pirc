import type { Binding, Descriptor } from '../environment/protocol.js';
import {
  modelArtifactImage,
  uiArtifact,
  type ArtifactReference,
} from '../environment/artifact-transfer.js';
import type { WriterLease } from './contracts.js';
import { GatewaySessionAuthority } from './authority.js';
import {
  validateTurnDescriptor,
  validateTurnInput,
  type TurnInput,
  type AuthorityTurn,
} from './turn-contracts.js';

export interface TurnEnvironment {
  describe(binding: Binding): Promise<Descriptor>;
  pinArtifact(binding: Binding, artifact: ArtifactReference): Promise<void>;
  fetchArtifact(
    binding: Binding,
    artifact: ArtifactReference,
    offset: number,
    limit: number,
  ): Promise<{ data: string; offset: number }>;
}

/**
 * Harness-only trusted supervisor adapter, not an HTTP/model/UI capability.
 * One instance per authority. It never replaces executors, starts models, grants
 * approval, resolves cwd, or interprets descriptor instructions as authorization.
 */
export class GatewayTurnLifecycle {
  private readonly preparing = new Set<string>();
  constructor(
    private readonly options: {
      authority: GatewaySessionAuthority;
      environment: TurnEnvironment;
      online(binding: Binding): boolean;
    },
  ) {}

  async begin(lease: WriterLease, value: TurnInput, signal?: AbortSignal): Promise<AuthorityTurn> {
    // Snapshot service inputs before crossing an async boundary.
    lease = structuredClone(lease);
    const input = validateTurnInput(value, lease.binding);
    this.options.authority.checkTurn(lease, input);
    const session = lease.binding.sessionId;
    if (this.preparing.has(session)) throw new Error('Turn preparation quota exceeded');
    // Recheck after every wait and reserve synchronously before any await. Multiple
    // service admissions must not all pass a separate asynchronous preflight.
    const waitingDeadline = Date.now() + 60000;
    while (this.preparing.size >= 4) {
      signal?.throwIfAborted();
      if (Date.now() >= waitingDeadline) throw new Error('Turn preparation deadline exceeded');
      await Bun.sleep(25);
    }
    signal?.throwIfAborted();
    this.options.authority.enrollTurns(lease);
    this.preparing.add(session);
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error('Turn preparation deadline exceeded')),
      60_000,
    );
    const cancellation = AbortSignal.any([deadline.signal, ...(signal ? [signal] : [])]);
    const wait = <T>(operation: Promise<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        const abort = () => {
          cancellation.removeEventListener('abort', abort);
          reject(cancellation.reason);
        };
        cancellation.addEventListener('abort', abort, { once: true });
        if (cancellation.aborted) abort();
        operation
          .then(resolve, reject)
          .finally(() => cancellation.removeEventListener('abort', abort));
      });
    const ready = () => {
      cancellation.throwIfAborted();
      if (!this.options.online(lease.binding)) throw new Error('Turn node offline');
    };
    const describe = async () => {
      ready();
      const descriptor = validateTurnDescriptor(
        await wait(this.options.environment.describe(lease.binding)),
        lease.binding,
      );
      ready();
      this.options.authority.checkTurn(lease, input, descriptor);
      return descriptor;
    };
    try {
      const descriptor = await describe();
      const previous = this.options.authority.checkTurn(lease, input, descriptor);
      if (previous) return previous; // Durable model bytes; do not redownload or append twice.
      const images = [];
      for (const artifact of input.attachments) {
        ready();
        // Pin before any durable reference. Failed admission may retain a conservative
        // orphan pin; never automatically unpin and risk an existing transcript.
        await wait(this.options.environment.pinArtifact(lease.binding, artifact));
        ready();
        images.push(
          await modelArtifactImage(
            lease.binding,
            artifact,
            async ({ binding, artifact, offset, limit }) => {
              ready();
              const reply = await wait(
                this.options.environment.fetchArtifact(binding, artifact, offset, limit),
              );
              ready();
              return reply;
            },
            cancellation,
          ),
        );
        ready();
      }
      // No turn starts with a descriptor that changed while attachments were loading.
      // Without attachments there is no such window: the admitted descriptor is current.
      if (input.attachments.length) {
        const current = await describe();
        if (current.revision !== descriptor.revision)
          throw new Error('Descriptor changed during turn preparation');
      }
      ready();
      return this.options.authority.commitTurn(lease, input, descriptor, images);
    } finally {
      clearTimeout(timer);
      this.preparing.delete(session);
    }
  }

  /** Stable entry/turn IDs let a future event sink deduplicate replay after restart. */
  project(sessionId: string, owner: string, branchId?: string, offset = 0) {
    return this.options.authority.turns(sessionId, owner, branchId, offset).map((turn) => ({
      type: 'turn.prepared' as const,
      turnId: turn.input.turnId,
      runId: turn.input.runId,
      entryId: turn.entryId,
      branchId: turn.branchId,
      text: turn.input.text,
      environment: {
        binding: turn.descriptor.binding,
        revision: turn.descriptor.revision,
        policyRevision: turn.descriptor.policyRevision,
        cwdDisplay: turn.descriptor.cwdDisplay,
        // This is the environment's admitted snapshot, not a live gateway sandbox badge.
        sandboxAtAdmission: turn.descriptor.sandboxStatus,
      },
      attachments: turn.input.attachments.map((artifact) => ({
        reference: uiArtifact(artifact, this.options.online(turn.descriptor.binding)),
        provenance: 'node-owned' as const,
        classification: 'private-session-content' as const,
        modelCopy: 'gateway-transcript' as const,
      })),
    }));
  }
}
