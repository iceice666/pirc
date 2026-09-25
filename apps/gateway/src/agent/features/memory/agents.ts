import {
  RELEVANCES,
  hashId,
  localStamp,
  observationLine,
  observationTokens,
  reflectionLine,
  truncateContent,
  type Observation,
  type Reflection,
  type Relevance,
} from './ledger.js';
import type { Chunk } from './serialize.js';
import type { WorkerTool } from './worker.js';

const lines = (items: string[]) => (items.length ? items.join('\n') : '(none yet)');

// ---------- observer ----------
export function observerPrompt(
  chunk: Chunk,
  reflections: Reflection[],
  observations: Observation[],
) {
  return `Current local time: ${localStamp()}

CURRENT REFLECTIONS:
${lines(reflections.map(reflectionLine))}

CURRENT OBSERVATIONS:
${lines(observations.map(observationLine))}

Compress the following new conversation chunk into observations by calling record_observations one or more times. Do not restate facts already present in current reflections or current observations. Prefer inline conversation timestamps when assigning times; fall back to the current local time above only if no message timestamp applies. Stop calling the tool and reply with a short plain-text confirmation once the chunk is fully covered.

NEW CONVERSATION CHUNK:
${chunk.text.trim()}`;
}

export function observerTool(allowedIds: string[], out: Observation[]): WorkerTool {
  const order = new Map(allowedIds.map((id, index) => [id, index]));
  return {
    name: 'record_observations',
    description:
      'Record a batch of new observations distilled from the conversation chunk. Call this multiple times as you work through the chunk. Stop calling when coverage is complete, then emit a short plain-text confirmation to end the run.',
    parameters: {
      type: 'object',
      properties: {
        observations: {
          type: 'array',
          description:
            'Batch of new observations. May be empty only if the tool is not called at all.',
          items: {
            type: 'object',
            properties: {
              timestamp: {
                type: 'string',
                pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$',
                description: "Observation time in local 'YYYY-MM-DD HH:MM' format.",
              },
              content: {
                type: 'string',
                minLength: 1,
                description:
                  'Single-line plain prose. No markdown, no tags, no embedded timestamp.',
              },
              relevance: { type: 'string', enum: RELEVANCES },
              sourceEntryIds: {
                type: 'array',
                minItems: 1,
                items: { type: 'string' },
                description:
                  "Exact source entry ids from the chunk that directly support this observation. Use only ids shown in '[Source entry id: ...]' labels; never invent ids.",
              },
            },
            required: ['timestamp', 'content', 'relevance', 'sourceEntryIds'],
          },
        },
      },
      required: ['observations'],
    },
    execute(args) {
      const items = Array.isArray(args.observations) ? args.observations : [];
      let added = 0;
      let duplicates = 0;
      let rejected = 0;
      for (const item of items) {
        const ids: string[] = Array.isArray(item?.sourceEntryIds) ? item.sourceEntryIds : [];
        const content = typeof item?.content === 'string' ? item.content.trim() : '';
        if (
          !content ||
          !ids.length ||
          ids.some((id) => !order.has(id)) ||
          !RELEVANCES.includes(item.relevance) ||
          !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(item.timestamp ?? '')
        ) {
          rejected++;
          continue;
        }
        const text = truncateContent(content.replace(/\s*[\r\n]+\s*/g, ' '));
        const id = hashId(text);
        if (out.some((o) => o.id === id)) {
          duplicates++;
          continue;
        }
        const observation: Observation = {
          id,
          content: text,
          timestamp: item.timestamp,
          relevance: item.relevance as Relevance,
          sourceEntryIds: [...new Set(ids)].sort((a, b) => order.get(a)! - order.get(b)!),
          tokenCount: 0,
        };
        observation.tokenCount = observationTokens(observation);
        out.push(observation);
        added++;
      }
      return `Recorded ${added} new observation(s)${duplicates ? ` (${duplicates} duplicate(s) skipped).` : '.'}${rejected ? ` ${rejected} observation(s) rejected for missing or invalid sourceEntryIds.` : ''} Total so far this run: ${out.length}. Continue if the chunk still has uncovered content; otherwise stop calling the tool and emit a short plain-text confirmation.`;
    },
  };
}

// ---------- coverage tiers ----------
type Tier = 'none' | 'partial' | 'strong';
export function coverageTiers(observations: Observation[], reflections: Reflection[]) {
  const counts = new Map<string, number>();
  for (const r of reflections)
    for (const id of r.supportingObservationIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const tiers = new Map<string, Tier>();
  for (const o of observations) {
    const n = counts.get(o.id) ?? 0;
    tiers.set(o.id, n === 0 ? 'none' : n === 1 ? 'partial' : 'strong');
  }
  return tiers;
}
const tieredLines = (observations: Observation[], reflections: Reflection[]) => {
  const tiers = coverageTiers(observations, reflections);
  return observations.map(
    (o) => `[${o.id}] ${o.timestamp} [${o.relevance}] [coverage: ${tiers.get(o.id)}] ${o.content}`,
  );
};

// ---------- reflector ----------
export function reflectorPrompt(reflections: Reflection[], active: Observation[]) {
  return `CURRENT REFLECTIONS:\n${lines(reflections.map(reflectionLine))}\n\nCURRENT OBSERVATIONS:\n${lines(tieredLines(active, reflections))}\n\nCrystallize any missing durable facts or patterns into new reflections. If nothing is stable enough, do not call the tool.`;
}

export function reflectorTool(
  existing: Reflection[],
  active: Observation[],
  out: Reflection[],
): WorkerTool {
  const order = new Map(active.map((o, index) => [o.id, index]));
  const known = new Set(existing.map((r) => r.id));
  return {
    name: 'record_reflections',
    description: 'Record new durable reflections with supporting observation ids.',
    parameters: {
      type: 'object',
      properties: {
        reflections: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', minLength: 1 },
              supportingObservationIds: { type: 'array', minItems: 1, items: { type: 'string' } },
            },
            required: ['content', 'supportingObservationIds'],
          },
        },
      },
      required: ['reflections'],
    },
    execute(args) {
      let added = 0;
      let duplicates = 0;
      let rejected = 0;
      for (const item of Array.isArray(args.reflections) ? args.reflections : []) {
        const content =
          typeof item?.content === 'string' ? truncateContent(item.content.trim()) : '';
        const ids: string[] = Array.isArray(item?.supportingObservationIds)
          ? item.supportingObservationIds
          : [];
        if (!content || /[\r\n]/.test(content) || !ids.length || ids.some((id) => !order.has(id))) {
          rejected++;
          continue;
        }
        const id = hashId(content);
        if (known.has(id)) {
          duplicates++;
          continue;
        }
        known.add(id);
        out.push({
          id,
          content,
          supportingObservationIds: [...new Set(ids)].sort((a, b) => order.get(a)! - order.get(b)!),
          tokenCount: Math.ceil(content.length / 4),
        });
        added++;
      }
      return `Recorded ${added} reflection(s); ${duplicates} duplicate(s); ${rejected} rejected. Total this run: ${out.length}.`;
    },
  };
}

// ---------- dropper ----------
export function poolMetrics(active: Observation[], target: number) {
  const tokens = active.reduce((sum, o) => sum + observationTokens(o), 0);
  const over = Math.max(0, tokens - target);
  const n = active.length;
  const maxDrops = over > 0 && n ? Math.min(n, Math.max(1, Math.ceil(over / (tokens / n)))) : 0;
  return { tokens, over, maxDrops, ready: tokens > target && maxDrops > 0 };
}

export function dropperPrompt(
  reflections: Reflection[],
  active: Observation[],
  target: number,
  metrics: ReturnType<typeof poolMetrics>,
) {
  const pct = Math.round((metrics.tokens / target) * 100);
  return `CURRENT REFLECTIONS:\n${lines(reflections.map(reflectionLine))}\n\nCURRENT OBSERVATIONS:\n${lines(tieredLines(active, reflections))}\n\nActive observation pool: ~${metrics.tokens.toLocaleString()} tokens; target: ~${target.toLocaleString()} tokens; fullness against target: ~${pct}%; over target by ~${metrics.over.toLocaleString()} tokens.\nMaximum drops allowed this run: ${metrics.maxDrops} observation(s). This maximum is sized to move the active pool toward the target if every proposed drop is clearly safe.\nThis maximum is a hard upper bound, not a target. Drop fewer or none if fewer observations are clearly safe.`;
}

export function dropperTool(active: Observation[], maxDrops: number, out: string[]): WorkerTool {
  const known = new Set(active.map((o) => o.id));
  return {
    name: 'drop_observations',
    description: 'Propose active observation ids that are safe to remove from compacted memory.',
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'array', minItems: 1, items: { type: 'string' } },
        reason: { type: 'string' },
      },
      required: ['ids'],
    },
    execute(args) {
      let queued = 0;
      for (const id of Array.isArray(args.ids) ? args.ids : []) {
        if (typeof id !== 'string' || !known.has(id) || out.includes(id)) continue;
        out.push(id);
        queued++;
      }
      return `Queued ${queued} drop candidate(s). Candidates this run: ${out.length}. Maximum drops allowed: ${maxDrops}.`;
    },
  };
}

/** Prefer well-covered, low-relevance, older observations; cap at `maxDrops`. */
export function selectDrops(
  proposed: string[],
  active: Observation[],
  reflections: Reflection[],
  maxDrops: number,
): string[] {
  const byId = new Map(active.map((o) => [o.id, o]));
  const tiers = coverageTiers(active, reflections);
  const rank = { strong: 0, partial: 1, none: 2 };
  const time = (o: Observation) => {
    const value = Date.parse(o.timestamp.replace(' ', 'T'));
    return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
  };
  return proposed
    .map((id, index) => ({ o: byId.get(id)!, index }))
    .filter((item) => item.o)
    .sort(
      (a, b) =>
        rank[tiers.get(a.o.id)!] - rank[tiers.get(b.o.id)!] ||
        RELEVANCES.indexOf(a.o.relevance) - RELEVANCES.indexOf(b.o.relevance) ||
        time(a.o) - time(b.o) ||
        a.index - b.index,
    )
    .slice(0, maxDrops)
    .map((item) => item.o.id);
}
