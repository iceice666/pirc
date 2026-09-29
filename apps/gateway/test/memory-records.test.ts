import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'bun:test';
import { hashId } from '../src/agent/features/memory/ledger.js';
import { GatewayDatabase } from '../src/database.js';
import { MemoryRecords } from '../src/daemon/memory-records.js';
import type { MirroredItem } from '../src/protocol.js';

const ME = 'me@example.com';
const OTHER = 'other@example.com';
const KEY = 'a'.repeat(16);
const OTHER_KEY = 'b'.repeat(16);

let db: GatewayDatabase;
let records: MemoryRecords;
beforeEach(() => {
  db = new GatewayDatabase(
    path.join(mkdtempSync(path.join(tmpdir(), 'pirc-records-')), 'db.sqlite'),
  );
  db.syncRemoteWorkspaces('n1', [
    { id: 'repo', displayName: 'pirc' },
    { id: 'wt', displayName: 'pirc-worktree' },
  ]);
  // Node sessions s1/s2 belong to me (a repository and its worktree), s3 to someone else.
  db.createSession('n1:repo', 'node://n1/s1', 'n1', 's1', ME);
  db.createSession('n1:wt', 'node://n1/s2', 'n1', 's2', ME);
  db.createSession('n1:repo', 'node://n1/s3', 'n1', 's3', OTHER);
  records = new MemoryRecords(db);
});

const item = (content: string, extra: Partial<MirroredItem> = {}): MirroredItem => ({
  id: hashId(content),
  content,
  relevance: 'high',
  timestamp: '2026-09-27 10:00',
  sessionId: 's1',
  sourceMemoryIds: ['aaaaaaaaaaaa'],
  ...extra,
});
/** Feed `lines` as the ledger's next chunk (offsets advance by 100 per chunk). */
const feeder = (key = KEY) => {
  let offset = 0;
  return (lines: unknown[]) =>
    (offset = records.ingest('n1', { ledgerKey: key, offset, end: offset + 100, lines }));
};
const all = () =>
  (db.raw.prepare('SELECT id, status, content, owner_user FROM memory_records').all() as any[]).map(
    (row) => `${row.content || row.id}:${row.status}:${row.owner_user ?? '-'}`,
  );

describe('mirrored workspace memory', () => {
  it('applies ledger lines like the fold, only in order', () => {
    const a = item('A note');
    const b = item('B note', { sessionId: 's3' });
    const { sessionId: _noSession, ...c } = item('C note');
    const d = item('D note', { sessionId: 'unknown' });
    expect(
      records.ingest('n1', {
        ledgerKey: KEY,
        offset: 0,
        end: 100,
        lines: [{ type: 'recorded', items: [a, b, c, d] }],
      }),
    ).toBe(100);
    // Owners come from the sessions that wrote the notes; unknown sessions have none.
    expect(all()).toEqual([
      `A note:active:${ME}`,
      `B note:active:${OTHER}`,
      'C note:active:-',
      'D note:active:-',
    ]);
    // A chunk that does not continue the stored part is ignored: the answer says where to resume.
    expect(
      records.ingest('n1', { ledgerKey: KEY, offset: 150, end: 200, lines: [{ type: 'cleared' }] }),
    ).toBe(100);
    expect(
      records.ingest('n1', { ledgerKey: KEY, offset: 50, end: 200, lines: [{ type: 'cleared' }] }),
    ).toBe(100);
    expect(all()).toHaveLength(4);

    records.ingest('n1', {
      ledgerKey: KEY,
      offset: 100,
      end: 180,
      lines: [
        { type: 'retired', ids: [a.id], reason: 'superseded' },
        { type: 'retired', ids: [b.id, hashId('never seen')], reason: 'forgotten' },
        // A forgotten note never comes back, and the first record of an id wins.
        { type: 'recorded', items: [b, { ...a, content: 'A changed' }] },
        { type: 'bogus' },
        { type: 'recorded', items: [{ id: 'not hex' }, item('E note')] },
      ],
    });
    expect(all()).toEqual([
      `A note:superseded:${ME}`,
      `${b.id}:forgotten:${OTHER}`,
      'C note:active:-',
      'D note:active:-',
      `${hashId('never seen')}:forgotten:-`,
      `E note:active:${ME}`,
    ]);

    // Clearing keeps only what was forgotten.
    records.ingest('n1', {
      ledgerKey: KEY,
      offset: 180,
      end: 250,
      lines: [{ type: 'cleared' }, { type: 'recorded', items: [item('F note')] }],
    });
    expect(all()).toEqual([
      `${b.id}:forgotten:${OTHER}`,
      `${hashId('never seen')}:forgotten:-`,
      `F note:active:${ME}`,
    ]);
    expect(records.watermarks('n1')).toEqual({ [KEY]: 250 });

    // A ledger that shrank starts over.
    expect(
      records.ingest('n1', {
        ledgerKey: KEY,
        offset: 0,
        end: 40,
        reset: true,
        lines: [{ type: 'recorded', items: [item('G note')] }],
      }),
    ).toBe(40);
    expect(all()).toEqual([`G note:active:${ME}`]);
  });

  it("finds a user's notes and delegations by any word, in any script", () => {
    const feed = feeder();
    const deploy = item('部署 uses nginx on lumo', {
      git: { head: 'abcdef123456', branch: 'main', dirty: true },
    });
    const config = item('The nginx config lives in nix/module.nix', { sessionId: 's2' });
    const theirs = item('lumo 部署 notes', { sessionId: 's3' });
    const percent = item('100% of the tests pass');
    feed([
      {
        type: 'recorded',
        items: [deploy, config, theirs, percent, item('unrelated'), item('1000 items')],
      },
    ]);
    feeder(OTHER_KEY)([
      {
        type: 'recorded',
        items: [item('nginx elsewhere, a later note', { timestamp: '2026-09-28 09:00' })],
      },
    ]);
    db.raw
      .prepare(
        "INSERT INTO delegations (id,owner_user,assistant_session_id,workspace_id,title,task,status,result,expires_at,created_at,updated_at) VALUES ('d12345678',?,'chat','n1:repo','Fix nginx','Reload it.','completed','nginx reloaded',0,0,?)",
      )
      .run(ME, Date.now());

    const hits = records.search(ME, '部署 NGINX');
    // Most words first: the two-character Chinese word counts like any other.
    expect(hits[0]).toMatchObject({
      id: deploy.id,
      kind: 'workspace',
      workspace: 'pirc on n1',
      date: '2026-09-27 10:00',
      status: 'active',
      git: 'main@abcdef1*',
    });
    expect(hits.map((hit) => hit.id)).not.toContain(theirs.id);
    expect(hits.map((hit) => hit.id)).toEqual(
      expect.arrayContaining([config.id, 'd12345678', hashId('nginx elsewhere, a later note')]),
    );
    expect(hits.find((hit) => hit.kind === 'delegation')).toMatchObject({
      workspace: 'pirc on n1',
      status: 'completed',
      content: 'Fix nginx: nginx reloaded',
    });
    expect(records.search(ME, '部署').map((hit) => hit.id)).toEqual([deploy.id]);
    expect(records.search(OTHER, '部署').map((hit) => hit.id)).toEqual([theirs.id]);
    // Wildcards are words, not patterns.
    expect(records.search(ME, '100%').map((hit) => hit.id)).toEqual([percent.id]);

    // Superseded notes come after current ones with as many matching words.
    feed([{ type: 'retired', ids: [config.id], reason: 'superseded' }]);
    const nginx = records.search(ME, 'nginx');
    expect(nginx.at(-1)).toMatchObject({ id: config.id, status: 'superseded' });
    // A workspace narrows to the ledgers its sessions wrote (a worktree shares its repository's).
    expect(
      records
        .search(ME, 'nginx', { workspace: 'n1:wt' })
        .map((hit) => hit.id)
        .sort(),
    ).toEqual([deploy.id, config.id].sort());
    expect(() => records.search(ME, '   ')).toThrow('query is required');
    expect(records.search(ME, 'nginx', { limit: 1 })).toHaveLength(1);
  });

  it('finds notes to recall for their owner only, never forgotten ones', () => {
    const feed = feeder();
    const note = item('Staging first');
    feed([{ type: 'recorded', items: [note] }]);
    expect(records.find(ME, note.id)).toEqual([
      {
        nodeId: 'n1',
        ledgerKey: KEY,
        workspace: 'pirc on n1',
        date: '2026-09-27 10:00',
        status: 'active',
        content: 'Staging first',
      },
    ]);
    expect(records.find(OTHER, note.id)).toEqual([]);
    feed([{ type: 'retired', ids: [note.id], reason: 'forgotten' }]);
    expect(records.find(ME, note.id)).toEqual([]);
    expect(records.search(ME, 'staging')).toEqual([]);
  });
});
