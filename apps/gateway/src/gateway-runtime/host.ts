import type { Database } from 'bun:sqlite';
import { GatewaySessionAuthority } from './authority.js';
import { GatewayAgentRuntime, type RuntimeModel, type RuntimeEvent } from './runtime.js';
import { GatewayCapabilities, type CentralCapability } from './capabilities.js';
import { DirectCentral } from './direct-central.js';
import { GatewayPtcService } from './ptc-service.js';
import { MixedCentral } from './mixed-central.js';
import { GatewayWorkspaceMemory } from './workspace-memory.js';
import type { WorkspaceItem, Candidate } from '../agent/features/memory/workspace.js';
import { GatewayInteractions } from './interactions.js';
import { productCapabilities } from './product-services.js';
import { GatewayGoals } from './goals.js';
import { branchFeatures } from './branch-features.js';
import { memoryCapabilities } from './memory-services.js';
import { ExecutionJournal } from '../environment/journal.js';
import type { Environment, Binding, ExecutionIntent } from '../environment/protocol.js';
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
  memory?: { budgets: MemoryBudgets; chat(intent: ExecutionIntent): boolean };
  humanRun?(intent: ExecutionIntent): boolean;
  workspaceMemory?: {
    snapshot(binding: Binding): Promise<{ repositoryKey: string; items: WorkspaceItem[] }>;
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
    select(
      candidates: Candidate[],
      signal: AbortSignal,
    ): Promise<
      Array<{ content: string; relevance: string; sourceMemoryIds: string[]; origins: string[] }>
    >;
    maxTokens: number;
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
      chat: options.memory.chat,
    }))
      services.set(name, capability);
  for (const [name, capability] of productCapabilities({
    askUser: async (args, intent, signal) => {
      const owner = options.owner(intent.binding),
        identity = authority.identities(intent.binding.sessionId, owner);
      const result = await interactions.ask(
        { binding: intent.binding, branchId: identity.branchId },
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
    ...(options.observationalMemory ? { observationalMemory: options.observationalMemory } : {}),
    ...(options.workspaceMemory
      ? { workspaceMemory: new GatewayWorkspaceMemory({ authority, ...options.workspaceMemory }) }
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
    async close() {
      try {
        interactions.close();
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
