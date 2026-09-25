/**
 * Structured observational-memory view for the web side panel. A pure
 * function of the session branch, so the gateway can build it from the
 * session file whether or not the agent is running.
 */
import { contextTokens } from '../../compaction.js';
import { contextEntriesOf, type SessionEntry } from '../../session-store.js';
import { poolMetrics } from './agents.js';
import { compactThreshold, poolTarget, type MemoryConfig } from './index.js';
import {
  OBS_RECORDED,
  REF_RECORDED,
  foldLedger,
  rawTokensSinceLastCompaction,
  tokensSinceCoverage,
  visibleProjection,
  type Relevance,
} from './ledger.js';

export interface MemoryPanel {
  enabled: boolean;
  passive: boolean;
  thresholds: {
    observation: { value: number; max: number };
    reflection: { value: number; max: number };
    compaction: { value: number; max: number };
    visiblePool: { value: number; max: number };
    activePool: { value: number; max: number };
  };
  counts: {
    observations: number;
    active: number;
    dropped: number;
    visibleObservations: number;
    reflections: number;
    visibleReflections: number;
    compactions: number;
  };
  observations: Array<{
    id: string;
    content: string;
    timestamp: string;
    relevance: Relevance;
    tokenCount: number;
    dropped: boolean;
    visible: boolean;
  }>;
  reflections: Array<{
    id: string;
    content: string;
    supportingObservationIds: string[];
    tokenCount: number;
    visible: boolean;
  }>;
  lastCompactionAt?: number;
}

const sum = (items: Array<{ tokenCount: number }>) =>
  items.reduce((total, item) => total + item.tokenCount, 0);

export function memoryPanel(
  branch: SessionEntry[],
  config: MemoryConfig,
  contextWindow: number | undefined,
): MemoryPanel {
  const folded = foldLedger(branch);
  const visible = visibleProjection(branch);
  const visibleObs = new Set(visible.observations.map((o) => o.id));
  const visibleRef = new Set(visible.reflections.map((r) => r.id));
  const current = contextTokens(contextEntriesOf(branch));
  const compactions = branch.filter((entry) => entry.type === 'compaction');
  const target = poolTarget(config);
  return {
    enabled: config.enabled,
    passive: config.passive,
    thresholds: {
      observation: {
        value: tokensSinceCoverage(branch, OBS_RECORDED, current),
        max: config.observeAfterTokens,
      },
      reflection: {
        value: tokensSinceCoverage(branch, REF_RECORDED, current),
        max: config.reflectAfterTokens,
      },
      compaction: {
        value: rawTokensSinceLastCompaction(branch),
        max: compactThreshold(config, contextWindow),
      },
      visiblePool: { value: sum(visible.observations), max: config.observationsPoolMaxTokens },
      activePool: { value: poolMetrics(folded.activeObservations, target).tokens, max: target },
    },
    counts: {
      observations: folded.observations.length,
      active: folded.activeObservations.length,
      dropped: folded.dropped.size,
      visibleObservations: visible.observations.length,
      reflections: folded.reflections.length,
      visibleReflections: visible.reflections.length,
      compactions: compactions.length,
    },
    observations: folded.observations.map((o) => ({
      id: o.id,
      content: o.content,
      timestamp: o.timestamp,
      relevance: o.relevance,
      tokenCount: o.tokenCount,
      dropped: folded.dropped.has(o.id),
      visible: visibleObs.has(o.id),
    })),
    reflections: folded.reflections.map((r) => ({
      id: r.id,
      content: r.content,
      supportingObservationIds: r.supportingObservationIds,
      tokenCount: r.tokenCount,
      visible: visibleRef.has(r.id),
    })),
    ...(compactions.length ? { lastCompactionAt: compactions.at(-1)!.timestamp } : {}),
  };
}
