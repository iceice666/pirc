// @vitest-environment jsdom
/**
 * The shared room fixtures (`fixtures/timeline/rooms`) pin how a room's
 * messages and the room event stream become what a client shows: the list
 * with unread counts, the open room's messages, who is typing. Other
 * clients (Android, plan 12) test against the same `expected`.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomsState } from './rooms.svelte';

const DIR = path.resolve(__dirname, '../../../../fixtures/timeline/rooms');
const UPDATE = process.env.UPDATE_TIMELINE_FIXTURES === '1';

/** Everything a client must agree on, minus timestamps and presentation. */
function project(state: RoomsState, typingAt: number) {
  return {
    rooms: state.rooms.map((room) => ({
      id: room.id,
      lastSeq: room.lastSeq,
      unread: room.unread,
      movedFromRoomId: room.movedFromRoomId,
    })),
    open: state.currentId,
    messages: state.messages.map((message) => ({
      seq: message.seq,
      speaker: message.speaker,
      user: message.user,
      kind: message.kind,
      text: message.body.text ?? null,
      pinned: message.pinnedAt != null,
    })),
    pinned: state.pinned.map((message) => message.id),
    typing: state.typingIn(state.currentId, typingAt),
  };
}

beforeEach(() => {
  // Reads the fixture's events cause are not part of it.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 500 })),
  );
});
afterEach(() => vi.unstubAllGlobals());

const files = readdirSync(DIR).filter((name) => name.endsWith('.json'));

describe('room fixtures', () => {
  it('exist', () => expect(files.length).toBeGreaterThan(0));

  for (const name of files)
    it(name, () => {
      const file = path.join(DIR, name);
      const fixture = JSON.parse(readFileSync(file, 'utf8'));
      const state = new RoomsState();
      state.user = fixture.user;
      state.rooms = fixture.rooms;
      state.currentId = fixture.open;
      state.messages = fixture.messages;
      const afterLoad = project(state, fixture.typingAt);
      for (const event of fixture.events) state.apply(event);
      const actual = { afterLoad, afterEvents: project(state, fixture.typingAt) };
      if (UPDATE) {
        writeFileSync(file, `${JSON.stringify({ ...fixture, expected: actual }, null, 2)}\n`);
        return;
      }
      expect(fixture.expected, 'run with UPDATE_TIMELINE_FIXTURES=1 to generate').not.toBeNull();
      expect(actual).toEqual(fixture.expected);
    });
});
