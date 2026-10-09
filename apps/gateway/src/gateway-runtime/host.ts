import type { Database } from 'bun:sqlite';
import { GatewaySessionAuthority } from './authority.js';
import { GatewayAgentRuntime, type RuntimeModel, type RuntimeEvent } from './runtime.js';
import { GatewayCapabilities, type CentralCapability } from './capabilities.js';
import { DirectCentral } from './direct-central.js';
import { GatewayPtcService } from './ptc-service.js';
import { MixedCentral } from './mixed-central.js';
import { GatewayWorkspaceMemory } from './workspace-memory.js';
import { GatewayWorkspaceRecords } from './workspace-records.js';
import { GatewayAssistantContext } from './assistant-context.js';
import type { WorkspaceSelection, WorkspaceSelectionContext } from './workspace-selection.js';
import { recall } from '../agent/features/memory/recall.js';
import type { Candidate, FreshWorkspaceSnapshot } from '../agent/features/memory/workspace.js';
import { GatewayInteractions } from './interactions.js';
import { GatewayEnvironmentInteractions } from './environment-interactions.js';
import { productCapabilities } from './product-services.js';
import { GatewayGoals } from './goals.js';
import { branchFeatures } from './branch-features.js';
import { memoryCapabilities } from './memory-services.js';
import { ExecutionJournal } from '../environment/journal.js';
import type {
  Environment,
  Binding,
  ExecutionIntent,
  ExecutionEvent,
} from '../environment/protocol.js';
import type { TurnEnvironment } from './turn-lifecycle.js';
import type { ToolSpec } from '../agent/providers/types.js';
import type { GatewayInference } from '../backends/inference.js';
import type { MemoryBudgets } from '../daemon/memory.js';
import type { NodeHookRoute } from '../environment/gateway-operation.js';

/** Explicit fresh-runtime composition. Importing/constructing this host never registers
 * production endpoints, provisions nodes, adopts writers or remaps legacy records.
 * Existing central records share the passed GatewayDatabase.raw connection.
 */
export function createGatewayRuntimeHost(options: {
  database: Database;
  journal: ExecutionJournal;
  owner(binding: Binding): string;
  environment: Environment & TurnEnvironment;
  online(binding: Binding): boolean;
  inference: Pick<GatewayInference, 'run'>;
  models: readonly RuntimeModel[];
  authorizeModel(binding: Binding, model: RuntimeModel): void;
  authorize(intent: ExecutionIntent, args: Record<string, unknown>): void;
  workerExecutable: string;
  ptcWorkerExecutable: string;
  systemPrompt: string;
  tools: readonly ToolSpec[];
  event?(event: RuntimeEvent): void;
  hooks?(intent: ExecutionIntent): NodeHookRoute | undefined;
  services?: ReadonlyMap<string, CentralCapability>;
  memory?: {
    budgets: MemoryBudgets;
    chat(binding: Binding): boolean;
    /** Chat recall stays local unless the trusted chat policy enables remote recall. */
    remoteRecall?(binding: Binding): boolean;
    workspaces?(
      binding: Binding,
    ): Parameters<typeof import('../agent/features/assistant/index.js').renderWorkspaces>[0];
  };
  humanRun?(intent: ExecutionIntent): boolean;
  workspaceMemory?: {
    /** Optional chat-only discovery of authorized fresh node bindings. No legacy records. */
    bindings?(intent: ExecutionIntent): Promise<readonly Binding[]>;
    snapshot(binding: Binding): Promise<FreshWorkspaceSnapshot>;
    append(
      binding: Binding,
      input: {
        operationId: string;
        content: string;
        relevance: string;
        branchId: string;
        sourceMemoryIds: string[];
        origins: string[];
      },
    ): Promise<import('../agent/features/memory/workspace.js').FreshWorkspaceAppendResult>;
    select?(
      candidates: Candidate[],
      signal: AbortSignal,
      context?: WorkspaceSelectionContext,
    ): Promise<
      | WorkspaceSelection
      | Array<{ content: string; relevance: string; sourceMemoryIds: string[]; origins: string[] }>
    >;
    maxTokens: number;
    retire?(
      binding: Binding,
      input: Parameters<
        import('../node/fresh-workspace-memory.js').FreshWorkspaceMemory['retire']
      >[1],
    ): Promise<{ operationId: string; retired: string[] }>;
  };
  observationalMemory?: {
    observeAfterTokens: number;
    reflectAfterTokens: number;
    chunkTokens: number;
    poolTarget: number;
    maxTurns: number;
    maxTokens: number;
    model?: { provider: string; id: string; thinking?: RuntimeModel['thinking'] };
    fallbackModels?: readonly {
      provider: string;
      id: string;
      thinking?: RuntimeModel['thinking'];
    }[];
  };
}) {
  const authority = new GatewaySessionAuthority(options.database),
    interactions = new GatewayInteractions(authority);
  const goals = new GatewayGoals(authority);
  const environmentInteractions = new GatewayEnvironmentInteractions(authority);
  const workspaceRecords = new GatewayWorkspaceRecords(authority);
  const assistant = options.memory
    ? new GatewayAssistantContext({ authority, ...options.memory })
    : undefined;
  const refreshWorkspaceRecords = async (intent: ExecutionIntent, signal: AbortSignal) => {
    const service = options.workspaceMemory!;
    const bindings =
      service.bindings && options.memory?.chat(intent.binding)
        ? await service.bindings(intent)
        : [intent.binding];
    if (bindings.length > 64) throw new Error('Fresh workspace discovery quota exceeded');
    const scopes = new Set<string>(),
      owner = options.owner(intent.binding);
    for (const binding of bindings) {
      signal.throwIfAborted();
      authority.assertOwner(binding.sessionId, owner);
      if (!options.online(binding)) throw new Error('Fresh workspace source node offline');
      const snapshot = await service.snapshot(binding);
      signal.throwIfAborted();
      workspaceRecords.sync(binding, owner, snapshot);
      scopes.add(`${binding.nodeId}/${snapshot.repositoryKey}`);
    }
    return [...scopes];
  };
  const services = new Map(options.services ?? []);
  for (const [name, capability] of branchFeatures(
    (intent) => authority.executionBranch(intent),
    (intent) => authority.humanTurn(intent) && (!options.humanRun || options.humanRun(intent)),
    authority,
    goals,
  ))
    if (!services.has(name)) services.set(name, capability);
  if (options.memory)
    for (const [name, capability] of memoryCapabilities({
      authority,
      owner: (intent) => options.owner(intent.binding),
      budgets: options.memory.budgets,
      chat: (intent) => options.memory!.chat(intent.binding),
      revisions: (intent) => assistant!.revisions(intent),
      recordRevision: (intent, id, revision) =>
        authority.saveFeatureState(
          authority.inner.operations.db,
          intent,
          'assistant-note-revisions',
          { ...assistant!.revisions(intent), [id]: revision },
        ),
    }))
      services.set(name, capability);
  for (const [name, capability] of productCapabilities({
    ...(options.workspaceMemory
      ? {
          memorySearch: async (
            args: Record<string, unknown>,
            intent: ExecutionIntent,
            signal: AbortSignal,
          ) => {
            const scopes = await refreshWorkspaceRecords(intent, signal);
            const result = workspaceRecords.search(
              options.owner(intent.binding),
              String(args.query ?? ''),
              typeof args.workspace === 'string' ? args.workspace : undefined,
              typeof args.limit === 'number' ? args.limit : 8,
              scopes,
            );
            return { text: JSON.stringify(result), ...result };
          },
        }
      : {}),
    recall: async (args, intent, signal) => {
      const owner = options.owner(intent.binding),
        id = String(args.id ?? '');
      const result = recall(
        authority.memoryBranch(intent.binding.sessionId, owner, authority.executionBranch(intent)),
        id,
      );
      return {
        id,
        ...(result.status === 'not_found' &&
        options.workspaceMemory &&
        (!options.memory?.chat(intent.binding) || options.memory.remoteRecall?.(intent.binding))
          ? workspaceRecords.recall(owner, id, await refreshWorkspaceRecords(intent, signal))
          : result),
      };
    },
    askUser: async (args, intent, signal) => {
      const owner = options.owner(intent.binding);
      const result = await interactions.ask(
        { binding: intent.binding, branchId: authority.executionBranch(intent) },
        owner,
        args,
        signal,
      );
      return { text: JSON.stringify(result), ...result };
    },
  }))
    if (!services.has(name)) services.set(name, capability);
  const capabilities = new GatewayCapabilities({
    inner: authority.inner,
    descriptor: (intent) =>
      authority.executionDescriptor(
        intent.parentExecutionId
          ? authority.executionIntent(intent.binding, intent.parentExecutionId)
          : intent,
      ),
    authorize: options.authorize,
    capabilities: services,
    ...(options.hooks ? { hooks: options.hooks } : {}),
  });
  const central = new DirectCentral({
    authority,
    capabilities,
    onHumanWait: (intent, listener) => interactions.onHumanWait(intent.binding.sessionId, listener),
    authorize: (intent) =>
      authority.assertOwner(intent.binding.sessionId, options.owner(intent.binding)),
  });
  const ptc = new GatewayPtcService({
    environment: options.environment,
    journal: options.journal,
    inner: authority.inner,
    workerExecutable: options.ptcWorkerExecutable,
    online: (intent) => options.online(intent.binding),
    central: (intent, signal, gate) => capabilities.execute(intent, signal, gate),
    operation: (intent, event, seq) =>
      runtime.clients.operation(
        { binding: intent.binding, branchId: authority.executionBranch(intent) },
        intent.executionId,
        event,
        seq,
      ),
    onHumanWait: (intent, listener) => interactions.onHumanWait(intent.binding.sessionId, listener),
  });
  const mixed = new MixedCentral({
    authority,
    capabilities,
    authorize: (intent) =>
      authority.assertOwner(intent.binding.sessionId, options.owner(intent.binding)),
  });
  const runtime = new GatewayAgentRuntime({
    authority,
    environment: options.environment,
    inference: options.inference,
    online: options.online,
    models: options.models,
    authorizeModel: options.authorizeModel,
    workerExecutable: options.workerExecutable,
    systemPrompt: options.systemPrompt,
    tools: options.tools,
    central,
    ptc,
    goals,
    ...(assistant
      ? {
          assistantContext: (
            lease: import('./contracts.js').WriterLease,
            owner: string,
            descriptor: import('../environment/protocol.js').Descriptor,
          ) => assistant.context(lease, owner, descriptor),
        }
      : {}),
    ...(options.observationalMemory ? { observationalMemory: options.observationalMemory } : {}),
    ...(options.workspaceMemory
      ? {
          workspaceMemory: new GatewayWorkspaceMemory({
            authority,
            ...options.workspaceMemory,
            snapshot: async (binding) => {
              const snapshot = await options.workspaceMemory!.snapshot(binding);
              workspaceRecords.sync(binding, options.owner(binding), snapshot);
              return snapshot;
            },
            append: async (binding, input) => {
              const result = await options.workspaceMemory!.append(binding, input);
              workspaceRecords.sync(
                binding,
                options.owner(binding),
                await options.workspaceMemory!.snapshot(binding),
              );
              return result;
            },
            ...(options.workspaceMemory.retire
              ? {
                  retire: async (
                    binding: Binding,
                    input: Parameters<
                      import('../node/fresh-workspace-memory.js').FreshWorkspaceMemory['retire']
                    >[1],
                  ) => {
                    const result = await options.workspaceMemory!.retire!(binding, input);
                    workspaceRecords.sync(
                      binding,
                      options.owner(binding),
                      await options.workspaceMemory!.snapshot(binding),
                    );
                    return result;
                  },
                }
              : {}),
          }),
        }
      : {}),
    ...(options.event ? { event: options.event } : {}),
  });
  return {
    authority,
    runtime,
    capabilities,
    central,
    ptc,
    mixed,
    interactions,
    environmentInteractions,
    workspaceRecords,
    /** Wire the authenticated RemoteEnvironment event sink to this callback. */
    environmentEvent: (event: ExecutionEvent) => runtime.clients.environment(event),
    async close() {
      try {
        interactions.close();
        await environmentInteractions.close();
      } finally {
        try {
          await runtime.close();
        } finally {
          authority.close();
        }
      }
    },
  };
}
