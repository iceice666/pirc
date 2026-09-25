/**
 * Observational memory: background observer → reflector → dropper agents
 * build an append-only memory ledger; compaction renders it as the summary
 * (no LLM call); `recall` maps memory ids back to raw source entries.
 */
import { z } from 'zod';
import type { Agent } from '../../agent.js';
import { contextTokens } from '../../compaction.js';
import { thinkingLevels } from '../../config.js';
import type { Feature } from '../../feature.js';
import type { SessionEntry } from '../../session-store.js';
import type { Tool } from '../../tools/types.js';
import {
  dropperPrompt,
  dropperTool,
  observerPrompt,
  observerTool,
  poolMetrics,
  reflectorPrompt,
  reflectorTool,
  selectDrops,
} from './agents.js';
import {
  ID_PATTERN,
  OBS_DROPPED,
  OBS_RECORDED,
  REF_RECORDED,
  buildCompactionProjection,
  foldLedger,
  fullProjection,
  isObservation,
  isReflection,
  latestCoverageId,
  latestCoverageIndex,
  observationLine,
  rawTokensSinceLastCompaction,
  reflectionLine,
  renderSummary,
  tokensSinceCoverage,
  visibleProjection,
  type Observation,
  type Reflection,
} from './ledger.js';
import { DROPPER_SYSTEM, OBSERVER_SYSTEM, REFLECTOR_SYSTEM } from './prompts.js';
import { renderMessage, serializeChunk } from './serialize.js';
import { RateLimitTracker, pickModel, runWorker, type WorkerModel } from './worker.js';

const modelChoice = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  // Pi's `max` maps to our highest level.
  thinking: z
    .enum([...thinkingLevels, 'max'])
    .transform((level) => (level === 'max' ? 'xhigh' : level))
    .optional(),
});
const positive = z.number().int().positive();
export const memorySchema = z.object({
  enabled: z.boolean().default(true),
  passive: z.boolean().default(false),
  observeAfterTokens: positive.default(10_000),
  reflectAfterTokens: positive.default(20_000),
  observerChunkMaxTokens: positive.optional(),
  compactAfterTokens: positive.default(81_000),
  compactAfterTokensMode: z.enum(['calibrated', 'ratio']).default('calibrated'),
  compactAfterTokensRatio: z.number().gt(0).lt(1).default(0.68),
  observationsPoolMaxTokens: positive.default(20_000),
  observationsPoolTargetTokens: positive.optional(),
  agentMaxTurns: positive.default(16),
  agentMaxTokens: positive.default(32_000),
  model: modelChoice.optional(),
  fallbackModels: z.array(modelChoice).default([]),
  rateLimitCooldownMs: positive.default(900_000),
  showWorkerNotifications: z.boolean().default(true),
});
export type MemoryConfig = z.infer<typeof memorySchema>;

export function memoryConfig(agent: Agent): MemoryConfig {
  return memoryConfigFrom(agent.config.features);
}

export function memoryConfigFrom(features: Record<string, unknown>): MemoryConfig {
  const parsed = memorySchema.safeParse(features.observationalMemory ?? {});
  const config = parsed.success ? parsed.data : memorySchema.parse({});
  if (process.env.PIRC_MEMORY_PASSIVE)
    config.passive = /^(1|true|yes|on)$/i.test(process.env.PIRC_MEMORY_PASSIVE.trim());
  return config;
}

export const poolTarget = (config: MemoryConfig) =>
  config.observationsPoolTargetTokens &&
  config.observationsPoolTargetTokens < config.observationsPoolMaxTokens
    ? config.observationsPoolTargetTokens
    : Math.floor(config.observationsPoolMaxTokens / 2);

export function compactThreshold(config: MemoryConfig, contextWindow: number | undefined): number {
  if (config.compactAfterTokensMode === 'ratio' && contextWindow && contextWindow > 0)
    return Math.max(1, Math.floor(contextWindow * config.compactAfterTokensRatio));
  return config.compactAfterTokens;
}

const RECALL_GUIDELINES = [
  'Use recall before making an important decision that depends on a compacted observation or reflection whose details are unclear.',
  'Use recall when you need exact wording, rationale, file paths, commands, errors, commits, user constraints, or provenance behind a remembered claim.',
  'Use recall when a broad reflection is relevant but you need its supporting observations or raw sources to continue safely.',
  'Use recall when the user asks why you believe something, what supports a memory, or what was decided earlier.',
  'Do not use recall as semantic search or transcript browsing; you must already have a specific 12-character memory id.',
  'Do not recall every id preemptively. Recall only when exact source context will materially improve the next action.',
];

export function recall(branch: SessionEntry[], id: string): { text: string; status: string } {
  if (!ID_PATTERN.test(id))
    return {
      text: `Memory id must be 12 lowercase hex characters. Received: ${id}`,
      status: 'invalid_id',
    };
  const observations: Observation[] = [];
  const reflections: Reflection[] = [];
  const dropped = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== 'custom') continue;
    const data = entry.data as any;
    if (entry.customType === OBS_RECORDED && Array.isArray(data?.observations))
      observations.push(...data.observations.filter(isObservation));
    if (entry.customType === REF_RECORDED && Array.isArray(data?.reflections))
      reflections.push(...data.reflections.filter(isReflection));
    if (entry.customType === OBS_DROPPED && Array.isArray(data?.observationIds))
      for (const dropId of data.observationIds) dropped.add(dropId);
  }
  const firstObs = (oid: string) => observations.find((o) => o.id === oid);
  const matchedObs = observations.filter((o) => o.id === id);
  const matchedRef = reflections.filter((r) => r.id === id);
  if (!matchedObs.length && !matchedRef.length)
    return {
      text: `No observation or reflection with id ${id} was found on the current branch.`,
      status: 'not_found',
    };
  const missingObs: string[] = [];
  const obsSet: Observation[] = [...matchedObs];
  for (const r of matchedRef)
    for (const oid of r.supportingObservationIds) {
      const found = firstObs(oid);
      if (!found) missingObs.push(oid);
      else if (!obsSet.some((o) => o.id === found.id)) obsSet.push(found);
    }
  const byId = new Map(branch.map((entry) => [entry.id, entry]));
  const missing: string[] = [];
  const nonSource: string[] = [];
  const sources: string[] = [];
  const seen = new Set<string>();
  for (const o of obsSet)
    for (const sid of o.sourceEntryIds) {
      if (seen.has(sid)) continue;
      seen.add(sid);
      const entry = byId.get(sid);
      if (!entry) missing.push(sid);
      else if (entry.type !== 'message') nonSource.push(sid);
      else sources.push(renderMessage(entry.message, 'recall'));
    }
  const parts: string[] = [];
  if (matchedObs.length + matchedRef.length > 1)
    parts.push(`Note: id ${id} matched ${matchedObs.length + matchedRef.length} records.`);
  if (matchedRef.length) parts.push(`Reflections:\n${matchedRef.map(reflectionLine).join('\n')}`);
  if (obsSet.length)
    parts.push(
      `Observations:\n${obsSet
        .map((o) =>
          dropped.has(o.id)
            ? `[${o.id}] [dropped] ${o.timestamp} [${o.relevance}] ${o.content}`
            : observationLine(o),
        )
        .join('\n')}`,
    );
  if (!matchedRef.length)
    for (const o of matchedObs)
      if (dropped.has(o.id))
        parts.push(`Observation ${o.id} is dropped from active memory but remains recallable.`);
  if (missingObs.length)
    parts.push(`Unavailable supporting observations: ${missingObs.join(', ')}`);
  if (missing.length || nonSource.length)
    parts.push(
      `Unavailable source entries: missing: ${missing.join(', ') || 'none'}; non-source: ${nonSource.join(', ') || 'none'}`,
    );
  if (sources.length) parts.push(`Sources:\n${sources.join('\n\n')}`);
  else parts.push('No source entries are available for this memory.');
  const status = sources.length
    ? missing.length || nonSource.length || missingObs.length
      ? 'partial'
      : 'ok'
    : missing.length || nonSource.length
      ? 'source_unavailable'
      : 'no_source';
  return { text: parts.join('\n\n'), status };
}

export function memoryFeature(): Feature {
  let tracker: RateLimitTracker | undefined;
  let consolidating: Promise<void> | null = null;
  let phase = '';
  let autoCompacting = false;
  let compactHookBusy = false;
  let emptyBackoff: { coverageId: string | undefined; tokensAtEmpty: number } | undefined;
  const lastError: Record<string, string> = {};
  let lifetime = new AbortController();
  let fallbackNoticeFor: string | undefined;

  const notify = (agent: Agent, config: MemoryConfig, text: string) => {
    agent.panelChanged('memory');
    if (config.showWorkerNotifications) agent.ui.notify(`Observational memory: ${text}`, 'info');
  };
  const setPhase = (agent: Agent, next: string) => {
    phase = next;
    agent.panelChanged('memory');
  };
  const currentTokens = (agent: Agent) => contextTokens(agent.store.contextEntries());

  const choose = (agent: Agent, config: MemoryConfig, stage: string): WorkerModel | undefined => {
    tracker ??= new RateLimitTracker(() => memoryConfig(agent).rateLimitCooldownMs);
    try {
      const model = pickModel(agent, config.model, config.fallbackModels, tracker);
      const preferred = config.model ? `${config.model.provider}/${config.model.id}` : undefined;
      if (preferred && model.key !== preferred && fallbackNoticeFor !== model.key) {
        fallbackNoticeFor = model.key;
        agent.ui.notify(
          `Observational memory: preferred model rate limited, using fallback ${model.key}`,
          'warning',
        );
      }
      return model;
    } catch (error) {
      agent.ui.notify(
        `Observational memory: ${stage} skipped — ${(error as Error).message}`,
        'warning',
      );
      return undefined;
    }
  };

  const chunkBudget = (config: MemoryConfig, model: WorkerModel) =>
    config.observerChunkMaxTokens
      ? Math.max(256, config.observerChunkMaxTokens)
      : Math.max(256, Math.floor(model.resolved.model.contextWindow * 0.2));

  async function consolidate(agent: Agent, signal: AbortSignal): Promise<void> {
    const config = memoryConfig(agent);
    const worker = (model: WorkerModel, systemPrompt: string, prompt: string, tool: any) =>
      runWorker(agent, {
        model,
        tracker: tracker!,
        systemPrompt,
        prompt,
        tool,
        maxTurns: config.agentMaxTurns,
        maxTokens: config.agentMaxTokens,
        signal,
      });

    // Observer
    setPhase(agent, 'observer');
    let branch = agent.store.branch();
    const obsTokens = tokensSinceCoverage(branch, OBS_RECORDED, currentTokens(agent));
    const obsCoverage = latestCoverageId(branch, OBS_RECORDED);
    if (
      emptyBackoff &&
      (emptyBackoff.coverageId !== obsCoverage ||
        obsTokens >= emptyBackoff.tokensAtEmpty + config.observeAfterTokens)
    )
      emptyBackoff = undefined;
    if (obsTokens >= config.observeAfterTokens && !emptyBackoff) {
      const model = choose(agent, config, 'observer');
      if (!model) return;
      const backlog = branch.slice(latestCoverageIndex(branch, OBS_RECORDED) + 1);
      const chunk = serializeChunk(backlog, chunkBudget(config, model));
      if (chunk.sourceEntryIds.length) {
        const prior = fullProjection(branch);
        const out: Observation[] = [];
        const result = await worker(
          model,
          OBSERVER_SYSTEM,
          observerPrompt(chunk, prior.reflections, prior.observations),
          observerTool(chunk.sourceEntryIds, out),
        );
        if (!out.length && result.error) {
          lastError.observer = result.error;
          agent.panelChanged('memory');
          return;
        }
        if (!out.length) {
          emptyBackoff = { coverageId: obsCoverage, tokensAtEmpty: obsTokens };
          notify(agent, config, 'no new observations in this chunk');
        } else {
          agent.store.append({
            type: 'custom',
            customType: OBS_RECORDED,
            data: { observations: out, coversUpToId: chunk.sourceEntryIds.at(-1)! },
          });
          notify(agent, config, `recorded ${out.length} observation(s)`);
        }
      }
    }
    if (signal.aborted) return;

    // Reflector
    setPhase(agent, 'reflector');
    branch = agent.store.branch();
    const refTokens = tokensSinceCoverage(branch, REF_RECORDED, currentTokens(agent));
    const obsCov = latestCoverageId(branch, OBS_RECORDED);
    if (refTokens < config.reflectAfterTokens || !obsCov) return;
    const refModel = choose(agent, config, 'reflector');
    if (!refModel) return;
    let folded = foldLedger(branch);
    if (!folded.activeObservations.length) return;
    const sameRun: Reflection[] = [];
    const refResult = await worker(
      refModel,
      REFLECTOR_SYSTEM,
      reflectorPrompt(folded.reflections, folded.activeObservations),
      reflectorTool(folded.reflections, folded.activeObservations, sameRun),
    );
    if (refResult.error && !sameRun.length) lastError.reflector = refResult.error;
    if (!sameRun.length) return;
    agent.store.append({
      type: 'custom',
      customType: REF_RECORDED,
      data: { reflections: sameRun, coversUpToId: obsCov },
    });
    notify(agent, config, `recorded ${sameRun.length} reflection(s)`);
    if (signal.aborted) return;

    // Dropper (only after a same-run reflection)
    setPhase(agent, 'dropper');
    branch = agent.store.branch();
    folded = foldLedger(branch);
    const target = poolTarget(config);
    const metrics = poolMetrics(folded.activeObservations, target);
    if (!metrics.ready) return;
    const dropModel = choose(agent, config, 'dropper');
    if (!dropModel) return;
    const reflections = [...folded.reflections];
    for (const r of sameRun) if (!reflections.some((item) => item.id === r.id)) reflections.push(r);
    const proposed: string[] = [];
    const dropResult = await worker(
      dropModel,
      DROPPER_SYSTEM,
      dropperPrompt(reflections, folded.activeObservations, target, metrics),
      dropperTool(folded.activeObservations, metrics.maxDrops, proposed),
    );
    if (dropResult.error && !proposed.length) lastError.dropper = dropResult.error;
    const drops = selectDrops(proposed, folded.activeObservations, reflections, metrics.maxDrops);
    if (!drops.length) return;
    const obsIndex = latestCoverageIndex(branch, OBS_RECORDED);
    const refIndex = latestCoverageIndex(branch, REF_RECORDED);
    const coversUpToId = branch[Math.min(obsIndex, refIndex)]?.id ?? obsCov;
    agent.store.append({
      type: 'custom',
      customType: OBS_DROPPED,
      data: { observationIds: drops, coversUpToId },
    });
    notify(agent, config, `dropped ${drops.length} observation(s)`);
  }

  const maybeConsolidate = (agent: Agent) => {
    const config = memoryConfig(agent);
    if (!config.enabled || config.passive || consolidating) return;
    const branch = agent.store.branch();
    const current = currentTokens(agent);
    const due =
      tokensSinceCoverage(branch, OBS_RECORDED, current) >= config.observeAfterTokens ||
      tokensSinceCoverage(branch, REF_RECORDED, current) >= config.reflectAfterTokens;
    if (!due) return;
    const signal = lifetime.signal;
    consolidating = consolidate(agent, signal)
      .catch((error) => {
        lastError[phase || 'consolidation'] = (error as Error).message;
        agent.panelChanged('memory');
        agent.ui.notify(
          `Observational memory ${phase} failed: ${(error as Error).message}`,
          'warning',
        );
      })
      .finally(() => {
        consolidating = null;
        setPhase(agent, '');
      });
  };

  const recallTool = (agent: Agent): Tool => ({
    name: 'recall',
    ptc: true,
    description: `Recover exact evidence and source context behind a compacted observational-memory observation or reflection id on the current branch. Use when compressed memory is important and original source context is needed before acting.\n\n${RECALL_GUIDELINES.map((line) => `- ${line}`).join('\n')}`,
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          pattern: '^[a-f0-9]{12}$',
          description:
            '12-character lowercase hex observation or reflection id shown in compacted memory, /om:view, or a previous recall result. Must be a specific id; this tool does not search by topic.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      if (ctx.signal.aborted) throw new Error('Aborted');
      const result = recall(agent.store.branch(), String(args.id ?? ''));
      return {
        content: [{ type: 'text', text: result.text }],
        details: { status: result.status, id: args.id },
        isError: result.status === 'invalid_id' || result.status === 'not_found',
      };
    },
  });

  return {
    name: 'observational-memory',
    tools: (agent) => (memoryConfig(agent).enabled ? [recallTool(agent)] : []),
    async beforeAgentStart(agent) {
      maybeConsolidate(agent);
    },
    turnEnd(agent) {
      maybeConsolidate(agent);
      // Threshold progress moves every turn.
      agent.panelChanged('memory');
    },
    async agentSettled(agent) {
      const config = memoryConfig(agent);
      if (!config.enabled || config.passive || autoCompacting || agent.isCompacting) return;
      let window: number | undefined;
      try {
        window = agent.resolveModel().model.contextWindow;
      } catch {
        window = undefined;
      }
      const threshold = compactThreshold(config, window);
      const progress = rawTokensSinceLastCompaction(agent.store.branch());
      if (progress < threshold) return;
      notify(
        agent,
        config,
        `compaction threshold reached (~${progress.toLocaleString()} estimated source tokens); triggering compaction`,
      );
      autoCompacting = true;
      setTimeout(() => {
        if (agent.isRunning || agent.isCompacting) {
          autoCompacting = false;
          notify(agent, config, 'automatic compaction deferred');
          return;
        }
        if (rawTokensSinceLastCompaction(agent.store.branch()) < threshold) {
          autoCompacting = false;
          notify(agent, config, 'automatic compaction skipped — another compaction already ran');
          return;
        }
        agent
          .compact()
          .catch((error) => {
            if ((error as Error).message !== 'Compaction cancelled')
              agent.ui.notify(
                `Observational memory: automatic compaction failed — ${(error as Error).message}`,
                'warning',
              );
          })
          .finally(() => {
            autoCompacting = false;
            agent.panelChanged('memory');
          });
      }, 0);
    },
    async beforeCompact(agent, context) {
      const config = memoryConfig(agent);
      if (!config.enabled) return undefined;
      if (compactHookBusy) {
        agent.ui.notify(
          'Observational memory: another compaction is already in progress; cancelling duplicate',
          'warning',
        );
        return { cancel: true };
      }
      compactHookBusy = true;
      try {
        const branch = agent.store.branch();
        const details = buildCompactionProjection(
          branch,
          context.firstKeptEntryId,
          config.observationsPoolMaxTokens,
        );
        const summary = renderSummary(details.reflections, details.observations);
        if (!summary) return undefined;
        return {
          summary,
          firstKeptEntryId: context.firstKeptEntryId,
          tokensBefore: context.tokensBefore,
          details,
        };
      } finally {
        compactHookBusy = false;
      }
    },
    async shutdown() {
      lifetime.abort();
      await consolidating;
      lifetime = new AbortController();
    },
    afterCompact(agent) {
      agent.panelChanged('memory');
    },
    /** Live-only state; the ledger itself is built by the gateway (memory/panel.ts). */
    panel() {
      return {
        memoryRuntime: {
          phase: consolidating ? phase || 'starting' : null,
          autoCompacting,
          rateLimited: (tracker?.entries() ?? []).map(([model, until]) => ({ model, until })),
          lastErrors: { ...lastError },
        },
      };
    },
    commands: {
      'om:status': {
        description: 'Observational memory status',
        async run(agent) {
          const config = memoryConfig(agent);
          const branch = agent.store.branch();
          const folded = foldLedger(branch);
          const visible = visibleProjection(branch);
          const current = currentTokens(agent);
          let window: number | undefined;
          try {
            window = agent.resolveModel().model.contextWindow;
          } catch {
            window = undefined;
          }
          const bar = (value: number, max: number) =>
            `${value.toLocaleString()}/${max.toLocaleString()} (${Math.min(100, Math.round((value / max) * 100))}%)`;
          const pool = (items: Observation[]) => items.reduce((sum, o) => sum + o.tokenCount, 0);
          const lines = [
            ...(config.passive
              ? ['Mode: passive (automatic consolidation and compaction off)']
              : []),
            `Memory: ${folded.observations.length} observations recorded, ${folded.dropped.size} dropped, ${folded.activeObservations.length} active, ${visible.observations.length} visible; ${folded.reflections.length} reflections (${visible.reflections.length} visible)`,
            `Next observation: ${bar(tokensSinceCoverage(branch, OBS_RECORDED, current), config.observeAfterTokens)}`,
            `Next reflection: ${bar(tokensSinceCoverage(branch, REF_RECORDED, current), config.reflectAfterTokens)}`,
            `Next compaction: ${bar(rawTokensSinceLastCompaction(branch), compactThreshold(config, window))}`,
            `Visible pool: ${bar(pool(visible.observations), config.observationsPoolMaxTokens)}`,
            `Active pool: ${bar(pool(folded.activeObservations), poolTarget(config))}`,
          ];
          if (consolidating) lines.push(`In flight: consolidation (${phase})`);
          if (autoCompacting) lines.push('In flight: automatic compaction');
          for (const [key, until] of tracker?.entries() ?? [])
            lines.push(
              `Rate limited: ${key} (${Math.ceil((until - Date.now()) / 60_000)} min left)`,
            );
          for (const [stage, message] of Object.entries(lastError))
            lines.push(`Last ${stage} error: ${message}`);
          agent.ui.notify(lines.join('\n'), 'info');
        },
      },
      'om:view': {
        description: 'Show memory (/om:view [full])',
        async run(agent, args) {
          const mode = args.trim() || 'visible';
          if (mode !== 'visible' && mode !== 'full')
            return agent.ui.notify('Usage: /om:view [full]', 'warning');
          const branch = agent.store.branch();
          const projection = mode === 'full' ? fullProjection(branch) : visibleProjection(branch);
          agent.ui.notify(
            [
              '── Reflections ──',
              ...projection.reflections.map(reflectionLine),
              '── Observations ──',
              ...projection.observations.map(observationLine),
            ].join('\n'),
            'info',
          );
        },
      },
    },
  };
}
