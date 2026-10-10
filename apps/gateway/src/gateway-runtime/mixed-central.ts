import type { GatewaySessionAuthority } from './authority.js';
import type { GatewayCapabilities } from './capabilities.js';
import type { ExecutionIntent } from '../environment/protocol.js';
import { REQUEST_BYTES, validateIntent } from '../environment/protocol.js';
import { canonicalJson } from '../environment/json.js';
import { planPtc } from './ptc-contracts.js';
import { validateSchema } from '../agent/ptc/schema.js';
import { validatePtcResult } from '../environment/ptc-result.js';

/** Bound to authenticated node transport, never model/UI ingress. The node supervisor
 * has persisted preflight/final arguments and runs post hooks locally in the active
 * PTC executor. Original arguments remain the execution dedup identity.
 */
export class MixedCentral {
  constructor(
    private readonly options: {
      authority: GatewaySessionAuthority;
      capabilities: GatewayCapabilities;
      authorize(intent: ExecutionIntent): void;
    },
  ) {}
  async execute(
    value: ExecutionIntent,
    signal: AbortSignal,
    finalArguments?: ExecutionIntent['arguments'],
  ) {
    const intent = validateIntent(value);
    this.options.authorize(intent);
    if (!intent.parentExecutionId || !intent.innerOperationId || finalArguments === undefined)
      throw new Error('Mixed central dispatch requires node-final arguments');
    const parent = this.options.authority.executionIntent(intent.binding, intent.parentExecutionId);
    if (!parent.ptc) throw new Error('Parent PTC not dispatched');
    const descriptor = this.options.authority.executionDescriptor(parent);
    const plan = planPtc(parent.arguments, descriptor.capabilityCatalog);
    if (plan.placement !== 'node' || !plan.manifest.includes(intent.capability))
      throw new Error('Capability outside mixed parent manifest');
    const capability = descriptor.capabilityCatalog.find(
      (cap) => cap.name === intent.capability && cap.placement === 'gateway',
    );
    if (
      !capability ||
      validateSchema(finalArguments, capability.argumentSchema as Record<string, unknown>).length
    )
      throw new Error('Invalid mixed central final arguments');
    const journal = this.options.authority.inner;
    let known = false;
    try {
      journal.status(intent.binding, intent.parentExecutionId, intent.innerOperationId);
      known = true;
    } catch {
      /* A fresh inner operation: admission checks below. */
    }
    // Retries of an accepted operation only read durable evidence. A fresh operation needs
    // the active writer generation; a finished parent is sealed and refused by accept().
    if (!known) this.options.authority.assertActiveGeneration(intent.binding);
    const accepted = journal.accept(intent);
    // Final-argument evidence is immutable and durably bound before the central effect.
    if (accepted.fresh) {
      journal.bindFinalArguments(intent, finalArguments);
    } else {
      const recorded = journal.phase(intent, 'preflight');
      if (
        recorded.state !== 'completed' ||
        canonicalJson(recorded.result, REQUEST_BYTES) !==
          canonicalJson(finalArguments, REQUEST_BYTES)
      )
        throw new Error('Mixed final-argument conflict');
      if (accepted.operation.result?.output)
        return validatePtcResult(accepted.operation.result.output, intent.innerOperationId);
      throw new Error('Mixed central outcome unresolved; status only, never replay');
    }
    return this.options.capabilities.execute(
      intent,
      signal,
      undefined,
      finalArguments as Record<string, unknown>,
    );
  }
  async status(value: ExecutionIntent) {
    const intent = validateIntent(value);
    this.options.authorize(intent);
    if (!intent.parentExecutionId || !intent.innerOperationId)
      throw new Error('Missing mixed inner identity');
    const operation = this.options.authority.inner.status(
      intent.binding,
      intent.parentExecutionId,
      intent.innerOperationId,
    );
    if (canonicalJson(operation.intent, REQUEST_BYTES) !== canonicalJson(intent, REQUEST_BYTES))
      throw new Error('Mixed status identity conflict');
    if (!operation.result?.output) throw new Error('Central result unknown');
    return validatePtcResult(operation.result.output, intent.innerOperationId);
  }
}
