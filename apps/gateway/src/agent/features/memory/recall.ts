import type { SessionEntry } from '../../session-store.js';
import {
  ID_PATTERN,
  OBS_RECORDED,
  REF_RECORDED,
  OBS_DROPPED,
  isObservation,
  isReflection,
  observationLine,
  reflectionLine,
  type Observation,
  type Reflection,
} from './ledger.js';
import { renderMessage } from './serialize.js';

/** Pure branch evidence projection shared by legacy and gateway runtimes. */
export function recall(branch: SessionEntry[], id: string): { text: string; status: string } {
  if (!ID_PATTERN.test(id))
    return {
      text: `Memory id must be 12 lowercase hex characters. Received: ${id}`,
      status: 'invalid_id',
    };
  const observations: Observation[] = [],
    reflections: Reflection[] = [],
    dropped = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== 'custom') continue;
    const data = entry.data as any;
    if (entry.customType === OBS_RECORDED && Array.isArray(data?.observations))
      observations.push(...data.observations.filter(isObservation));
    if (entry.customType === REF_RECORDED && Array.isArray(data?.reflections))
      reflections.push(...data.reflections.filter(isReflection));
    if (entry.customType === OBS_DROPPED && Array.isArray(data?.observationIds))
      for (const id of data.observationIds) dropped.add(id);
  }
  const matchedObs = observations.filter((o) => o.id === id),
    matchedRef = reflections.filter((r) => r.id === id);
  if (!matchedObs.length && !matchedRef.length)
    return {
      text: `No observation or reflection with id ${id} was found on the current branch.`,
      status: 'not_found',
    };
  const missingObs: string[] = [],
    obsSet = [...matchedObs];
  for (const reflection of matchedRef)
    for (const id of reflection.supportingObservationIds) {
      const found = observations.find((o) => o.id === id);
      if (!found) missingObs.push(id);
      else if (!obsSet.some((o) => o.id === id)) obsSet.push(found);
    }
  const byId = new Map(branch.map((entry) => [entry.id, entry])),
    missing: string[] = [],
    nonSource: string[] = [],
    sources: string[] = [],
    seen = new Set<string>();
  for (const observation of obsSet)
    for (const sourceId of observation.sourceEntryIds) {
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);
      const entry = byId.get(sourceId);
      if (!entry) missing.push(sourceId);
      else if (entry.type !== 'message') nonSource.push(sourceId);
      else sources.push(renderMessage(entry.message, 'recall'));
    }
  const parts: string[] = [];
  if (matchedObs.length + matchedRef.length > 1)
    parts.push(`Note: id ${id} matched ${matchedObs.length + matchedRef.length} records.`);
  if (matchedRef.length) parts.push(`Reflections:\n${matchedRef.map(reflectionLine).join('\n')}`);
  if (obsSet.length)
    parts.push(
      `Observations:\n${obsSet.map((o) => (dropped.has(o.id) ? `[${o.id}] [dropped] ${o.timestamp} [${o.relevance}] ${o.content}` : observationLine(o))).join('\n')}`,
    );
  if (!matchedRef.length)
    for (const observation of matchedObs)
      if (dropped.has(observation.id))
        parts.push(
          `Observation ${observation.id} is dropped from active memory but remains recallable.`,
        );
  if (missingObs.length)
    parts.push(`Unavailable supporting observations: ${missingObs.join(', ')}`);
  if (missing.length || nonSource.length)
    parts.push(
      `Unavailable source entries: missing: ${missing.join(', ') || 'none'}; non-source: ${nonSource.join(', ') || 'none'}`,
    );
  if (sources.length) parts.push(`Sources:\n${sources.join('\n\n')}`);
  else parts.push('No source entries are available for this memory.');
  return {
    text: parts.join('\n\n'),
    status: sources.length
      ? missing.length || nonSource.length || missingObs.length
        ? 'partial'
        : 'ok'
      : missing.length || nonSource.length
        ? 'source_unavailable'
        : 'no_source',
  };
}
