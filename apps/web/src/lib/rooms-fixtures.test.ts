/**
 * The shared room fixtures (`fixtures/timeline/rooms`) pin how the room
 * event stream changes what a client shows: the list with unread counts,
 * the open room's messages, who is typing, which faces think and what each
 * is doing, the open thread, and what each event asks the client to fetch
 * next. They run the pure reducer (`room-events.ts`) that `RoomsState`
 * uses; other clients (Android, plan 12) test against the same `expected`.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { reduceRoomEvent, type RoomEffect, type RoomsView } from './room-events';

const DIR = path.resolve(__dirname, '../../../../fixtures/timeline/rooms');
const UPDATE = process.env.UPDATE_TIMELINE_FIXTURES === '1';

/** Everything a client must agree on, minus timestamps and presentation. */
function project(view: RoomsView, typingAt: number) {
  return {
    rooms: view.rooms.map((room) => ({
      id: room.id,
      lastSeq: room.lastSeq,
      unread: room.unread,
      movedFromRoomId: room.movedFromRoomId,
    })),
    open: view.currentId,
    messages: view.messages.map((message) => ({
      seq: message.seq,
      speaker: message.speaker,
      user: message.user,
      kind: message.kind,
      text: message.body.text ?? null,
      pinned: message.pinnedAt != null,
    })),
    pinned: view.pinned.map((message) => message.id),
    typing: Object.entries(view.typing[view.currentId] ?? {})
      .filter(([user, until]) => user !== view.user && until > typingAt)
      .map(([user]) => user),
    thinking: view.thinking,
    faces: view.faces.map((face) => ({ id: face.id, name: face.name })),
    facePresence: Object.fromEntries(
      Object.entries(view.facePresence).map(([id, presence]) => [
        id,
        { state: presence.state, roomId: presence.roomId ?? null, line: presence.line ?? null },
      ]),
    ),
    thread: view.threadId ?? null,
    threadMessages: view.threadMessages.map((message) => ({
      seq: message.seq,
      speaker: message.speaker,
      kind: message.kind,
      text: message.body.text ?? message.body.summary ?? null,
    })),
    threadActivity: Object.fromEntries(
      Object.entries(view.threadActivity).map(([id, activity]) => [id, activity.text]),
    ),
    loopsRevision: view.loopsRevision,
    wakesRevision: view.wakesRevision,
  };
}

function loaded(fixture: any): RoomsView {
  return {
    user: fixture.user,
    currentId: fixture.open,
    rooms: fixture.rooms,
    detached: undefined,
    messages: fixture.messages,
    pinned: fixture.pinned ?? [],
    typing: {},
    thinking: {},
    faces: fixture.faces ?? [],
    facePresence: {},
    loopsRevision: 0,
    wakesRevision: 0,
    threadId: fixture.thread ?? undefined,
    threadMessages: fixture.threadMessages ?? [],
    threadActivity: {},
  };
}

const files = readdirSync(DIR).filter((name) => name.endsWith('.json'));

describe('room fixtures', () => {
  it('exist', () => expect(files.length).toBeGreaterThan(1));

  for (const name of files)
    it(name, () => {
      const file = path.join(DIR, name);
      const fixture = JSON.parse(readFileSync(file, 'utf8'));
      let view = loaded(fixture);
      const afterLoad = project(view, fixture.typingAt);
      const effects: RoomEffect[] = [];
      for (const event of fixture.events) {
        const reduced = reduceRoomEvent(view, event);
        view = { ...view, ...reduced.patch };
        effects.push(...reduced.effects);
      }
      const actual = { afterLoad, afterEvents: project(view, fixture.typingAt), effects };
      if (UPDATE) {
        writeFileSync(file, `${JSON.stringify({ ...fixture, expected: actual }, null, 2)}\n`);
        return;
      }
      expect(fixture.expected, 'run with UPDATE_TIMELINE_FIXTURES=1 to generate').not.toBeNull();
      expect(actual).toEqual(fixture.expected);
    });
});
