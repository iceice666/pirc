import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GatewayDatabase } from '../src/database.js';
import { collectRecap } from '../src/node/recap.js';

let root: string;
let db: GatewayDatabase;
let current: string;
let stamp: number;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'recap-test-')));
  db = new GatewayDatabase(':memory:');
  db.addWorkspace('w', 'node', 'project', root);
  current = db.createSession('w', path.join(root, 'current'), null, null, 'alice').id;
  stamp = Date.now() - 1000;
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
function session(
  entries: Record<string, unknown>[],
  owner: string | null = 'alice',
  workspace = 'w',
  cwd = root,
) {
  const dir = path.join(root, `s-${crypto.randomUUID()}`);
  mkdirSync(dir);
  const row = db.createSession(workspace, dir, null, null, owner);
  const all = [{ type: 'session', version: 1, cwd, sessionId: 'private-id' }, ...entries].map(
    (entry, i) => ({
      id: `e${i}`,
      parentId: i ? `e${i - 1}` : null,
      timestamp: stamp,
      ...entry,
    }),
  );
  writeFileSync(
    path.join(dir, 'session.jsonl'),
    all.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  return row;
}
const user = (text: string) => ({ type: 'message', message: { role: 'user', content: text } });

test('strict bound arguments and fail-closed owner and workspace kind', () => {
  for (const args of [
    { days: 0 },
    { days: 91 },
    { days: 1.5 },
    { days: '14' },
    { path: root },
    { sessionId: current },
    null,
  ])
    expect(() => collectRecap(db, current, args)).toThrow();
  db.raw.query('UPDATE sessions SET owner_user=NULL WHERE id=?').run(current);
  expect(() => collectRecap(db, current, {})).toThrow('known session owner');
  db.raw.query("UPDATE sessions SET owner_user='alice' WHERE id=?").run(current);
  db.raw.query("UPDATE workspaces SET kind='chat'").run();
  expect(() => collectRecap(db, current, {})).toThrow('directory workspace');
});

test('only owned exact workspace and exact cwd, current excluded', () => {
  const good = session([user('human requirement')]);
  session([user('foreign-owner')], 'bob');
  session([user('unknown-owner')], null);
  db.addWorkspace('other', 'node', 'other worktree', path.join(root, 'worktree'));
  session([user('other-worktree')], 'alice', 'other');
  session([user('wrong-header')], 'alice', 'w', path.join(root, 'nested'));
  const result = collectRecap(db, current, {});
  expect(result.sessions.map((s) => s.sessionId)).toEqual([good.id]);
  expect(result.scope.days).toBe(14);
  expect(result.skipped[0]?.reason).toBe('workspace_header_mismatch');
});

test('only text and safe tool metadata; known secrets redacted, timestamps bounded', () => {
  session([
    user('human sk-abcdefghijklmnopqrstuvwxyz'),
    { ...user('too old'), timestamp: stamp - 20 * 86_400_000 },
    { ...user('future'), timestamp: stamp + 86_400_000 },
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'answer' },
          { type: 'thinking', thinking: 'PRIVATE_THINKING' },
          { type: 'toolCall', name: 'bash', arguments: { command: 'PRIVATE_ARGS' } },
        ],
      },
    },
    {
      type: 'message',
      message: { role: 'toolResult', toolName: 'bash', content: 'PRIVATE_RESULT', isError: true },
    },
    {
      type: 'custom',
      customType: 'ptc.operation',
      data: {
        toolName: 'read',
        args: 'PRIVATE_PTC_ARGS',
        content: 'PRIVATE_PTC_RESULT',
        isError: true,
      },
    },
    { type: 'custom', customType: 'memory', data: 'PRIVATE_MEMORY' },
  ]);
  const result = collectRecap(db, current, {});
  const text = JSON.stringify(result);
  expect(text).not.toContain('PRIVATE_');
  expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
  expect(text).not.toContain('too old');
  expect(text).not.toContain('future');
  expect(result.sessions[0]?.evidence[0]?.role).toBe('user');
  expect(result.sessions[0]?.evidence.some((e) => e.toolName === 'read' && e.isError)).toBe(true);
  expect(result.sessions[0]?.evidence.every((e) => e.entryId && e.timestamp === stamp)).toBe(true);
});

test('excludes entire recap-marked sessions, even markers off active branch', () => {
  session([
    user('original'),
    { type: 'custom', customType: 'recap.run', data: {} },
    { ...user('after'), parentId: 'e1' },
  ]);
  session([
    user('original'),
    { type: 'message', message: { role: 'custom', customType: 'recap.report', content: 'report' } },
  ]);
  const result = collectRecap(db, current, {});
  expect(result.sessions).toEqual([]);
  expect(result.skipped.map((s) => s.reason)).toEqual([
    'recap_marked_session',
    'recap_marked_session',
  ]);
});

test('rejects cycles, malformed entries and detached branches; samples only active branch', () => {
  session([user('cycle'), { ...user('cycle'), parentId: 'e2' }]);
  session([{ ...user('broken'), parentId: 'missing' }]);
  session([{ ...user('invalid'), timestamp: 'bad' }]);
  const good = session([user('abandoned'), { ...user('active'), parentId: 'e0' }]);
  const result = collectRecap(db, current, {});
  expect(result.sessions.map((s) => s.sessionId)).toEqual([good.id]);
  expect(JSON.stringify(result)).not.toContain('abandoned');
  expect(result.skipped).toHaveLength(3);
});

test('rejects symlink files and symlink directories; skips huge files without reading', () => {
  const target = session([user('target')]);
  const linked = session([user('linked')]);
  rmSync(path.join(linked.privateSessionPath, 'session.jsonl'));
  symlinkSync(
    path.join(target.privateSessionPath, 'session.jsonl'),
    path.join(linked.privateSessionPath, 'session.jsonl'),
  );
  const linkedDir = path.join(root, 'linked-dir');
  symlinkSync(target.privateSessionPath, linkedDir);
  db.createSession('w', linkedDir, null, null, 'alice');
  const huge = session([]);
  writeFileSync(
    path.join(huge.privateSessionPath, 'session.jsonl'),
    'x'.repeat(4 * 1024 * 1024 + 1),
  );
  const result = collectRecap(db, current, {});
  expect(result.sessions.map((s) => s.sessionId)).toEqual([target.id]);
  expect(result.skipped.filter((s) => s.reason === 'unsafe_path')).toHaveLength(2);
  expect(result.skipped.some((s) => s.reason === 'file_byte_limit')).toBe(true);
  expect(result.scannedBytes).toBeLessThan(1000);
});

test('scheduled and delegated background sessions are not sampled', () => {
  const scheduled = session([user('scheduled')]);
  const delegated = session([user('delegated')]);
  db.raw
    .query(
      `INSERT INTO schedule_runs(id,schedule_id,owner_user,due_at,status,session_id,created_at)
    VALUES ('run','schedule','alice',?,'done',?,?)`,
    )
    .run(stamp, scheduled.id, stamp);
  db.raw
    .query(
      `INSERT INTO delegations(id,owner_user,assistant_session_id,workspace_id,title,task,status,target_session_id,expires_at,created_at,updated_at)
    VALUES ('delegation','alice',?,'w','title','task','done',?,?,?,?)`,
    )
    .run(current, delegated.id, stamp, stamp, stamp);
  expect(collectRecap(db, current, {}).sessions).toEqual([]);
});

test('node-local background markers exclude entire sessions without gateway origin rows', () => {
  for (const customType of ['scheduled-run', 'assistant-delegation']) {
    session([
      user('before background marker'),
      { type: 'message', message: { role: 'custom', customType, content: 'background task' } },
      { ...user('off-marker branch'), parentId: 'e1' },
    ]);
    session([user('before'), { type: 'custom', customType, data: {} }, user('after')]);
  }
  const result = collectRecap(db, current, {});
  expect(result.sessions).toEqual([]);
  expect(result.skipped.map((s) => s.reason)).toEqual(Array(4).fill('background_session'));
});

test('aggregate scan budget is bounded and omitted sessions are disclosed', () => {
  for (let i = 0; i < 10; i++) session([user('x'.repeat(3_900_000))]);
  const result = collectRecap(db, current, {});
  expect(result.scannedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  expect(result.skipped.some((s) => s.reason === 'scan_byte_limit')).toBe(true);
  expect(result.truncated).toBe(true);
});

test('caps session count and serialized output, prioritizes human evidence', () => {
  for (let i = 0; i < 22; i++)
    session([
      ...Array.from({ length: 15 }, () => ({
        type: 'message',
        message: { role: 'assistant', content: 'a'.repeat(3000) },
      })),
      user('human first'),
      user('b'.repeat(6000)),
    ]);
  const result = collectRecap(db, current, {});
  expect(result.sessions.length).toBeLessThanOrEqual(20);
  expect(result.truncated).toBe(true);
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(80_000);
  for (const s of result.sessions) {
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(5000);
    expect(s.evidence[0]?.role).toBe('user');
    expect(s.evidence.some((e) => e.text === 'human first')).toBe(true);
  }
});
