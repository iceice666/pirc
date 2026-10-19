import { Database } from 'bun:sqlite';
import { afterEach, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { classify, outcome, parseArgs, run, type Report } from '../approval-stats.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const auto = 'Auto mode: allow a potentially dangerous action?';
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pirc-approval-stats-'));
  dirs.push(dir);
  const gatewayPath = path.join(dir, 'gateway.sqlite');
  const nodePath = path.join(dir, 'node.sqlite');
  const gateway = new Database(gatewayPath);
  gateway.run('CREATE TABLE sessions (id TEXT PRIMARY KEY, node_id TEXT, pi_session_id TEXT)');
  gateway.run(
    'CREATE TABLE delegations (id TEXT PRIMARY KEY, target_session_id TEXT, status TEXT)',
  );
  gateway.run(
    `INSERT INTO sessions VALUES ('g1','n1','s-del'),('g2','n1','s-own'),('g3','n2','s-own2')`,
  );
  gateway.run(`INSERT INTO delegations VALUES ('d1','g1','done'),('d2','g3','done')`);
  gateway.close();
  const node = new Database(nodePath);
  node.run(`CREATE TABLE interactions (id TEXT PRIMARY KEY, session_id TEXT, kind TEXT, status TEXT,
    request_json TEXT, answer_json TEXT, created_at INTEGER)`);
  const insert = node.prepare('INSERT INTO interactions VALUES (?,?,?,?,?,?,?)');
  const req = (title: string, message: string) => JSON.stringify({ title, message });
  const yes = JSON.stringify({ confirmed: true }),
    no = JSON.stringify({ confirmed: false });
  insert.run(
    'i1',
    's-del',
    'confirm',
    'answered',
    req(auto, 'Run rm (bash, in /w):\n\nrm -rf x\n\nReason: deletes files'),
    yes,
    1000,
  );
  insert.run(
    'i2',
    's-del',
    'confirm',
    'expired',
    req(
      'Allow network access?',
      'The agent asks to reach a.com, b.org from its sandbox.\n\nReason: x',
    ),
    null,
    2000,
  );
  insert.run(
    'i3',
    's-own',
    'confirm',
    'answered',
    req('Run a command outside the sandbox?', '$ nix build .#x\n\nin /w\n\nReason: nix'),
    no,
    3000,
  );
  insert.run(
    'i4',
    's-own',
    'confirm',
    'answered',
    req(
      auto,
      'L (bash, in /w):\n\nmake\n\nReason: make runs a recipe that matches the deny-list pattern /x/',
    ),
    JSON.stringify({ cancelled: true }),
    4000,
  );
  insert.run(
    'i5',
    's-own',
    'select',
    'answered',
    req('Pick', ''),
    JSON.stringify({ value: 'a' }),
    5000,
  );
  insert.run(
    'i6',
    's-own2',
    'confirm',
    'answered',
    req('Read-only mode: allow this action?', 'L (edit, in /w):\n\nt\n\nReason: writes'),
    yes,
    6000,
  );
  node.close();
  return { gatewayPath, nodePath };
}

it('classifies by title and parses hosts, heads and reasons', () => {
  const row = (title: string, message: string) => ({
    session_id: 's',
    kind: 'confirm',
    status: 'pending',
    request_json: JSON.stringify({ title, message }),
    answer_json: null,
  });
  expect(
    classify(
      row('Allow network access?', 'The agent asks to reach a.com from its sandbox.'),
      'ordinary',
    ),
  ).toMatchObject({ category: 'sandbox_allow_domains', hosts: ['a.com'], outcome: 'unanswered' });
  expect(
    classify(row('Run a command outside the sandbox?', 'x\n$ git push\n'), 'ordinary').head,
  ).toBe('git');
  expect(classify(row('Something', ''), 'ordinary').category).toBe('other_confirm');
  expect(outcome('answered', { confirmed: true })).toBe('approved');
  expect(outcome('answered', { cancelled: true })).toBe('declined');
  expect(outcome('stale', {})).toBe('unanswered');
});

it('splits delegated and ordinary sessions per node, read-only', () => {
  const { gatewayPath, nodePath } = fixture();
  const result = JSON.parse(
    run(['--gateway-db', gatewayPath, '--node-db', `n1=${nodePath}`, '--json']),
  ) as Report;
  expect(result.counts.delegated).toEqual({
    auto_mode: { approved: 1, declined: 0, unanswered: 0 },
    sandbox_allow_domains: { approved: 0, declined: 0, unanswered: 1 },
  });
  // s-own2 belongs to n2, whose delegation does not count for n1.
  expect(result.counts.ordinary).toEqual({
    auto_mode_deny_list: { approved: 0, declined: 1, unanswered: 0 },
    other_select: { approved: 1, declined: 0, unanswered: 0 },
    read_only: { approved: 1, declined: 0, unanswered: 0 },
    unsandboxed_bash: { approved: 0, declined: 1, unanswered: 0 },
  });
  expect(result.topHosts.delegated).toEqual([
    ['a.com', 1],
    ['b.org', 1],
  ]);
  expect(result.topCommandHeads.ordinary).toEqual([['nix', 1]]);
  expect(result.topReasons.delegated).toEqual([['deletes files', 1]]);
  expect(result.source).toBe('unrecorded');
  // Without a node id, the session id alone matches; --since filters by created_at (ms).
  const loose = JSON.parse(
    run([
      '--gateway-db',
      gatewayPath,
      '--node-db',
      nodePath,
      '--since',
      new Date(2500).toISOString(),
      '--json',
    ]),
  ) as Report;
  expect(loose.counts.delegated).toEqual({
    read_only: { approved: 1, declined: 0, unanswered: 0 },
  });
  expect(run(['--gateway-db', gatewayPath, '--node-db', nodePath])).toStartWith(
    'approval-stats (read-only',
  );
  expect(() =>
    run([
      '--gateway-db',
      path.join(path.dirname(nodePath), 'missing.sqlite'),
      '--node-db',
      nodePath,
    ]),
  ).toThrow();
});

it('rejects bad arguments', () => {
  expect(() => parseArgs(['--node-db', 'x'])).toThrow('Usage');
  expect(() => parseArgs(['--gateway-db', 'g', '--node-db', 'x', '--since', 'nope'])).toThrow(
    'Invalid --since',
  );
  expect(parseArgs(['--gateway-db', 'g', '--node-db', '/a=b/c.sqlite']).nodes).toEqual([
    { nodeId: null, path: '/a=b/c.sqlite' },
  ]);
});
