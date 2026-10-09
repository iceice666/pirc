import { randomUUID } from 'node:crypto';
import type { GatewaySessionAuthority } from './authority.js';
import type { WriterLease } from './contracts.js';
import {
  OBS_RECORDED,
  REF_RECORDED,
  OBS_DROPPED,
  latestCoverageIndex,
  latestCoverageId,
  fullProjection,
  foldLedger,
  tokensSinceCoverage,
  type Observation,
  type Reflection,
} from '../agent/features/memory/ledger.js';
import { serializeChunk } from '../agent/features/memory/serialize.js';
import {
  observerPrompt,
  observerTool,
  reflectorPrompt,
  reflectorTool,
  poolMetrics,
  dropperPrompt,
  dropperTool,
  selectDrops,
} from '../agent/features/memory/agents.js';
import {
  OBSERVER_SYSTEM,
  REFLECTOR_SYSTEM,
  DROPPER_SYSTEM,
} from '../agent/features/memory/prompts.js';
import type { WorkerTool } from '../agent/features/memory/worker.js';
import { contextTokens } from '../agent/compaction.js';

/** Gateway-owned OM ledger coordinator; all model calls use the runtime's existing
 * admitted provider service and authoritative model metadata. No node transcript reads.
 */
export class GatewayObservationalMemory {
  constructor(
    private readonly options: {
      authority: GatewaySessionAuthority;
      observeAfterTokens: number;
      reflectAfterTokens: number;
      chunkTokens: number;
      poolTarget: number;
      worker(system: string, prompt: string, tool: WorkerTool, signal: AbortSignal): Promise<void>;
    },
  ) {}
  async consolidate(lease: WriterLease, owner: string, signal: AbortSignal): Promise<void> {
    let branch = this.options.authority.memoryBranch(
      lease.binding.sessionId,
      owner,
      lease.branchId,
    );
    const current = () =>
      contextTokens(
        this.options.authority.modelContext(lease.binding.sessionId, owner, lease.branchId),
      );
    const record = (customType: string, data: unknown) =>
      this.options.authority.append(lease, randomUUID(), {
        type: 'custom',
        customType,
        data: JSON.parse(JSON.stringify(data)),
      });
    if (tokensSinceCoverage(branch, OBS_RECORDED, current()) >= this.options.observeAfterTokens) {
      const chunk = serializeChunk(
        branch.slice(latestCoverageIndex(branch, OBS_RECORDED) + 1),
        this.options.chunkTokens,
      );
      if (chunk.sourceEntryIds.length) {
        const prior = fullProjection(branch),
          observations: Observation[] = [];
        await this.options.worker(
          OBSERVER_SYSTEM,
          observerPrompt(chunk, prior.reflections, prior.observations),
          observerTool(chunk, observations),
          signal,
        );
        signal.throwIfAborted();
        if (observations.length)
          record(OBS_RECORDED, { observations, coversUpToId: chunk.sourceEntryIds.at(-1)! });
      }
    }
    branch = this.options.authority.memoryBranch(lease.binding.sessionId, owner, lease.branchId);
    const coverage = latestCoverageId(branch, OBS_RECORDED);
    if (
      !coverage ||
      tokensSinceCoverage(branch, REF_RECORDED, current()) < this.options.reflectAfterTokens
    )
      return;
    let folded = foldLedger(branch);
    if (!folded.activeObservations.length) return;
    const reflections: Reflection[] = [];
    await this.options.worker(
      REFLECTOR_SYSTEM,
      reflectorPrompt(folded.reflections, folded.activeObservations),
      reflectorTool(folded.reflections, folded.activeObservations, reflections),
      signal,
    );
    signal.throwIfAborted();
    if (!reflections.length) return;
    record(REF_RECORDED, { reflections, coversUpToId: coverage });
    branch = this.options.authority.memoryBranch(lease.binding.sessionId, owner, lease.branchId);
    folded = foldLedger(branch);
    const metrics = poolMetrics(folded.activeObservations, this.options.poolTarget);
    if (!metrics.ready) return;
    const proposed: string[] = [];
    await this.options.worker(
      DROPPER_SYSTEM,
      dropperPrompt(
        folded.reflections,
        folded.activeObservations,
        this.options.poolTarget,
        metrics,
      ),
      dropperTool(folded.activeObservations, metrics.maxDrops, proposed),
      signal,
    );
    signal.throwIfAborted();
    const drops = selectDrops(
      proposed,
      folded.activeObservations,
      folded.reflections,
      metrics.maxDrops,
    );
    if (drops.length) record(OBS_DROPPED, { observationIds: drops, coversUpToId: coverage });
  }
}
