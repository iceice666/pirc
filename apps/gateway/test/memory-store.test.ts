import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'bun:test';
import { GatewayDatabase } from '../src/database.js';
import { MemoryStore, type MemoryChange } from '../src/daemon/memory.js';
import { ApiError } from '../src/errors.js';

const ME = 'me@example.com';
const OTHER = 'other@example.com';
const fromChat: MemoryChange = {
  actor: 'session:s1',
  origins: ['assistant'],
  sources: { sessionId: 's1' },
};

let store: MemoryStore;
let db: GatewayDatabase;
beforeEach(() => {
  db = new GatewayDatabase(
    path.join(mkdtempSync(path.join(tmpdir(), 'pirc-memory-')), 'db.sqlite'),
  );
  store = new MemoryStore(db.raw, { user: 60, note: 80 });
});

/** The ApiError code (or message) a call fails with. */
function failure(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) return error.code;
    throw error;
  }
  throw new Error('expected a failure');
}

const note = (content: string, user = ME) =>
  store.writeNote(user, { action: 'add', content }, fromChat).entry;
const propose = (content: string, quote = 'I said so', user = ME) =>
  store.propose(user, 's1', { action: 'add', content, quote }, { sessionId: 's1' });

describe('assistant notes', () => {
  it('adds, replaces with the seen revision and removes notes, logging every revision', () => {
    const added = note('m5pro  holds\n the pirc repo');
    expect(added).toMatchObject({
      kind: 'note',
      content: 'm5pro holds the pirc repo',
      revision: 1,
    });
    expect(added.id).toMatch(/^n[0-9a-f]{8}$/);
    // Adding the same fact again (ignoring case and spacing) changes nothing.
    expect(
      store.writeNote(ME, { action: 'add', content: 'M5PRO holds the pirc repo' }, fromChat),
    ).toMatchObject({ unchanged: true, entry: { id: added.id } });

    // A replace must name the revision it saw; anything else returns the current one.
    const stale = () =>
      store.writeNote(
        ME,
        { action: 'replace', id: added.id, content: 'x', baseRevision: 0 },
        fromChat,
      );
    expect(failure(stale)).toBe('conflict');
    try {
      stale();
    } catch (error) {
      expect((error as ApiError).details).toEqual({
        id: added.id,
        revision: 1,
        content: 'm5pro holds the pirc repo',
      });
    }
    const replaced = store.writeNote(
      ME,
      { action: 'replace', id: added.id, content: 'lumo holds the pirc repo', baseRevision: 1 },
      { ...fromChat, origins: ['assistant', 'tool:bash'] },
    ).entry;
    expect(replaced).toMatchObject({ revision: 2, origins: ['assistant', 'tool:bash'] });
    const removed = store.writeNote(
      ME,
      { action: 'remove', id: added.id, baseRevision: 2 },
      fromChat,
    ).entry;
    expect(removed).toMatchObject({ status: 'removed', revision: 3 });
    expect(store.history(ME, added.id).map((v) => [v.revision, v.op, v.content])).toEqual([
      [3, 'remove', null],
      [2, 'replace', 'lumo holds the pirc repo'],
      [1, 'add', 'm5pro holds the pirc repo'],
    ]);
    expect(store.context(ME).notes).toEqual([]);
  });

  it('keeps notes within the budget and one entry per fact', () => {
    note('a'.repeat(50));
    expect(failure(() => note('b'.repeat(31)))).toBe('memory_full');
    expect(failure(() => note('c'.repeat(1001)))).toBe('payload_too_large');
    expect(failure(() => note('   '))).toBe('invalid_input');
    expect(store.usage(ME).note).toEqual({ used: 50, max: 80 });
  });

  it('strips secrets before storing', () => {
    expect(note(`deploy token ghp_${'a'.repeat(36)}`).content).toBe('deploy token ghp_[REDACTED]');
  });

  it('never lets the assistant touch USER entries directly', () => {
    const { proposal } = propose('Prefers short answers.');
    const entry = store.approve(ME, proposal.id).entry;
    expect(
      failure(() =>
        store.writeNote(
          ME,
          { action: 'replace', id: entry.id, content: 'x', baseRevision: 1 },
          fromChat,
        ),
      ),
    ).toBe('forbidden');
  });

  it('keeps users apart', () => {
    const mine = note('mine');
    expect(failure(() => store.entry(OTHER, mine.id))).toBe('not_found');
    expect(store.context(OTHER).notes).toEqual([]);
  });
});

describe('USER proposals', () => {
  it('changes USER only when the user approves, with the quote as provenance', () => {
    const { proposal, duplicate } = propose('Prefers answers in Traditional Chinese.', '請用繁中');
    expect([proposal.status, duplicate, proposal.id.startsWith('p')]).toEqual([
      'pending',
      false,
      true,
    ]);
    expect(store.context(ME)).toMatchObject({ user: [], pendingProposals: 1 });
    // The same proposal again is the same pending proposal.
    expect(propose('Prefers answers in Traditional Chinese.', '請用繁中')).toMatchObject({
      duplicate: true,
      proposal: { id: proposal.id },
    });
    const { entry } = store.approve(ME, proposal.id);
    expect(entry).toMatchObject({
      kind: 'user',
      content: 'Prefers answers in Traditional Chinese.',
      origins: ['user'],
      sources: { sessionId: 's1', quote: '請用繁中', proposalId: proposal.id },
    });
    expect(store.history(ME, entry.id)[0]!.actor).toBe(`user:${ME}`);
    expect(store.proposal(ME, proposal.id)).toMatchObject({
      status: 'approved',
      targetId: entry.id,
    });
    expect(failure(() => store.approve(ME, proposal.id))).toBe('conflict');
    // Already in USER: nothing to propose.
    expect(failure(() => propose('prefers answers in traditional chinese.'))).toBe('conflict');
  });

  it('replaces and removes USER entries, checking the version the user saw', () => {
    const first = store.approve(ME, propose('Lives in Taipei.').proposal.id).entry;
    const move = store.propose(
      ME,
      's1',
      {
        action: 'replace',
        id: first.id,
        content: 'Lives in Tokyo.',
        baseRevision: 1,
        quote: 'moved to Tokyo',
      },
      {},
    ).proposal;
    expect(move).toMatchObject({ targetId: first.id, targetRevision: 1 });
    expect(failure(() => store.approve(ME, move.id, 7))).toBe('conflict');
    expect(store.approve(ME, move.id, 1).entry).toMatchObject({
      content: 'Lives in Tokyo.',
      revision: 2,
    });
    const drop = store.propose(
      ME,
      's1',
      { action: 'remove', id: first.id, quote: 'forget where I live' },
      {},
    ).proposal;
    expect(store.approve(ME, drop.id).entry).toMatchObject({ status: 'removed', revision: 3 });
    expect(store.context(ME).user).toEqual([]);
  });

  it('remembers rejections and caps what waits for the user', () => {
    const { proposal } = propose('Likes jazz.');
    expect(store.reject(ME, proposal.id).status).toBe('rejected');
    expect(failure(() => propose('Likes jazz.'))).toBe('rejected_before');
    for (let i = 0; i < 20; i++) propose(`Fact ${i}.`);
    expect(failure(() => propose('One too many.'))).toBe('too_many_requests');
  });

  it("checks the USER budget when proposing and approving, and needs the user's words", () => {
    const big = store.approve(ME, propose('x'.repeat(40)).proposal.id).entry;
    expect(failure(() => propose('y'.repeat(30)))).toBe('memory_full');
    const fits = propose('z'.repeat(15)).proposal;
    const grows = store.propose(
      ME,
      's1',
      // 10 more characters: fits now (50/60), not after `fits` is approved (55 + 10).
      { action: 'replace', id: big.id, content: 'w'.repeat(50), baseRevision: 1, quote: 'q' },
      {},
    ).proposal;
    store.approve(ME, fits.id);
    // Approving the other one now would overflow; it stays pending.
    expect(failure(() => store.approve(ME, grows.id))).toBe('memory_full');
    expect(store.proposal(ME, grows.id).status).toBe('pending');
    expect(failure(() => propose('No words.', '  '))).toBe('invalid_input');
  });
});

describe('forgetting and restoring', () => {
  it('erases every version and every proposal carrying it, and refuses the text again', () => {
    const { proposal } = propose('Has two cats.', 'I have two cats');
    const entry = store.approve(ME, proposal.id).entry;
    const again = store.propose(
      ME,
      's1',
      { action: 'replace', id: entry.id, content: 'Has three cats.', baseRevision: 1, quote: '3' },
      {},
    ).proposal;
    store.approve(ME, again.id);
    const pendingRemove = store.propose(
      ME,
      's1',
      { action: 'remove', id: entry.id, quote: 'no more cats' },
      {},
    ).proposal;

    store.forget(ME, entry.id);
    const forgotten = store.entry(ME, entry.id);
    expect(forgotten).toMatchObject({ status: 'forgotten', content: '', origins: [], sources: {} });
    expect(store.history(ME, entry.id).map((v) => [v.op, v.content])).toEqual([['forget', null]]);
    for (const id of [proposal.id, again.id, pendingRemove.id])
      expect(store.proposal(ME, id)).toMatchObject({ content: null, quote: '' });
    expect(store.proposal(ME, pendingRemove.id).status).toBe('rejected');
    // Neither version can come back, whatever the case or spacing.
    expect(failure(() => propose('has  TWO cats.'))).toBe('forgotten');
    expect(failure(() => note('Has three cats.'))).toBe('forgotten');
    expect(failure(() => store.restore(ME, entry.id, 1))).toBe('forgotten');
    // Another user's identical text is unaffected.
    expect(note('Has two cats.', OTHER).content).toBe('Has two cats.');
    // Idempotent.
    store.forget(ME, entry.id);
  });

  it('restores removed notes and earlier versions within the budget', () => {
    const entry = note('first version');
    store.writeNote(
      ME,
      { action: 'replace', id: entry.id, content: 'second version', baseRevision: 1 },
      fromChat,
    );
    store.writeNote(ME, { action: 'remove', id: entry.id, baseRevision: 2 }, fromChat);
    expect(store.restore(ME, entry.id)).toMatchObject({
      status: 'active',
      content: 'second version',
      revision: 4,
    });
    const back = store.restore(ME, entry.id, 1);
    expect(back).toMatchObject({ content: 'first version', revision: 5, origins: ['assistant'] });
    expect(store.history(ME, entry.id)[0]).toMatchObject({ op: 'restore', actor: `user:${ME}` });
    expect(failure(() => store.restore(ME, entry.id, 3))).toBe('not_found');
    note('f'.repeat(66));
    const removed = store.writeNote(
      ME,
      { action: 'remove', id: entry.id, baseRevision: 5 },
      fromChat,
    ).entry;
    note('g'.repeat(10));
    expect(failure(() => store.restore(ME, removed.id))).toBe('memory_full');
  });
});

describe('deleting the source chat', () => {
  it('forgets USER and all note revisions by their original creator, preserving other chats and owners', () => {
    const created = note('Originally here');
    store.writeNote(
      ME,
      { action: 'replace', id: created.id, baseRevision: 1, content: 'Edited elsewhere' },
      { ...fromChat, sources: { sessionId: 's2' } },
    );
    const elsewhere = store.writeNote(
      ME,
      { action: 'add', content: 'Originally elsewhere' },
      { ...fromChat, sources: { sessionId: 's2' } },
    ).entry;
    store.writeNote(
      ME,
      { action: 'replace', id: elsewhere.id, baseRevision: 1, content: 'Edited here' },
      fromChat,
    );
    // A deduplicated add must not steal another chat's creation provenance.
    store.writeNote(ME, { action: 'add', content: 'Edited here' }, fromChat);
    const user = store.approve(ME, propose('Prefers tea').proposal.id).entry;
    const pending = propose('Prefers coffee').proposal;
    const other = note('Other owner', OTHER);
    store.forgetSession(ME, 's1');
    expect(store.entry(ME, created.id)).toMatchObject({ status: 'forgotten', content: '' });
    expect(store.entry(ME, user.id)).toMatchObject({ status: 'forgotten', content: '' });
    expect(store.history(ME, created.id).every((v) => v.content === null)).toBe(true);
    expect(store.entry(ME, elsewhere.id)).toMatchObject({
      status: 'active',
      content: 'Edited here',
    });
    expect(store.entry(OTHER, other.id).status).toBe('active');
    expect(failure(() => store.proposal(ME, pending.id))).toBe('not_found');
    for (const content of ['Originally here', 'Edited elsewhere'])
      expect(failure(() => note(content))).toBe('forgotten');
    expect(failure(() => store.restore(ME, user.id))).toBe('forgotten');
    store.forgetSession(ME, 's1'); // Safe to retry after a lost acknowledgement.
  });

  it('backfills creation provenance from the add log, not the latest revision', () => {
    const first = note('Created in s1');
    store.writeNote(
      ME,
      { action: 'replace', id: first.id, baseRevision: 1, content: 'Updated in s2' },
      { ...fromChat, sources: { sessionId: 's2' } },
    );
    const filename = db.raw.filename;
    const version = (db.raw.query('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    db.raw.exec(
      `DROP INDEX memory_entries_creator; ALTER TABLE memory_entries DROP COLUMN created_by_session; DROP TABLE session_deletions; PRAGMA user_version=${version - 1}`,
    );
    db.close();
    db = new GatewayDatabase(filename);
    store = new MemoryStore(db.raw, { user: 60, note: 80 });
    store.forgetSession(ME, 's1');
    expect(store.entry(ME, first.id).status).toBe('forgotten');
  });
});
