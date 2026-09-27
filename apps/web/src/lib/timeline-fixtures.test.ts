// @vitest-environment jsdom
/**
 * The shared timeline fixtures (`fixtures/timeline`) pin how a gateway
 * snapshot and its events become client state. Other clients (Android) test
 * against the same `expected` projections; this suite keeps them honest.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeEvent, snapshotFromRaw } from './api';
import { fromSnapshot, reduceEvent } from './state';
import type { ClientSessionState, ConversationMessage, ToolCall } from './types';

const DIR = path.resolve(__dirname, '../../../../fixtures/timeline');
const UPDATE = process.env.UPDATE_TIMELINE_FIXTURES === '1';

const defined = (entries: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined && value !== false),
  );

const tool = (item: ToolCall) =>
  defined({
    id: item.id,
    name: item.name,
    status: item.status,
    input: item.input,
    output: item.output,
    diff: item.diff,
    images: item.images?.length,
  });

const message = (item: ConversationMessage) =>
  defined({
    id: item.id,
    role: item.role,
    content: item.content,
    isPartial: item.isPartial,
    thinking: item.thinking,
    thinkingRedacted: item.thinkingRedacted,
    stopReason: item.stopReason,
    errorMessage: item.errorMessage,
    model: item.model,
    systemKind: item.systemKind,
    level: item.level,
    label: item.label,
    meta: item.meta,
    images: item.images?.length,
    tools: item.tools?.length ? item.tools.map(tool) : undefined,
  });

/** Everything a client must agree on, minus timestamps and presentation. */
export function project(state: ClientSessionState) {
  return {
    cursor: state.cursor,
    runnerEpoch: state.runnerEpoch,
    needsSnapshot: state.needsSnapshot,
    sessionName: state.session.name,
    pinned: !!state.session.pinned,
    runStatus: state.run?.status ?? null,
    runnerStatus: state.runnerStatus,
    selectedModelId: state.selectedModelId ?? null,
    thinkingLevel: state.thinkingLevel ?? null,
    queue: state.queue.map((item) => `${item.kind}:${item.content}`),
    widgets: state.widgets ?? {},
    statuses: state.statuses ?? {},
    interactions: state.interactions.map((item) =>
      defined({
        id: item.id,
        kind: item.kind,
        title: item.title,
        description: item.description,
        status: item.status,
        multiple: item.kind === 'select' ? item.multiple : undefined,
        options:
          item.kind === 'select'
            ? item.options.map((option) =>
                defined({ value: option.value, description: option.description }),
              )
            : undefined,
      }),
    ),
    messages: state.messages.map(message),
  };
}

const files = readdirSync(DIR).filter((name) => name.endsWith('.json'));

describe('timeline fixtures', () => {
  it('exist', () => expect(files.length).toBeGreaterThan(0));

  for (const name of files)
    it(name, () => {
      const file = path.join(DIR, name);
      const fixture = JSON.parse(readFileSync(file, 'utf8'));
      let state = fromSnapshot(snapshotFromRaw(fixture.snapshot, null));
      const afterSnapshot = project(state);
      for (const raw of fixture.events) state = reduceEvent(state, normalizeEvent(raw));
      const actual = { afterSnapshot, afterEvents: project(state) };
      if (UPDATE) {
        writeFileSync(file, `${JSON.stringify({ ...fixture, expected: actual }, null, 2)}\n`);
        return;
      }
      expect(fixture.expected, 'run with UPDATE_TIMELINE_FIXTURES=1 to generate').not.toBeNull();
      expect(actual).toEqual(fixture.expected);
    });
});
