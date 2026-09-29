import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'bun:test';
import { hashId } from '../src/agent/features/memory/ledger.js';
import type { WorkspaceItem } from '../src/agent/features/memory/workspace.js';
import { GatewayDatabase } from '../src/database.js';
import { MemoryMirror } from '../src/node/memory-mirror.js';
import type { NodeToDaemon } from '../src/protocol.js';

const KEY = 'c'.repeat(16);
const mirrors: MemoryMirror[] = [];
afterEach(() => {
  for (const mirror of mirrors.splice(0)) mirror.disconnect();
});

function setup() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pirc-mirror-')));
  const dir = path.join(root, 'workspace-memory');
  mkdirSync(dir);
  const db = new GatewayDatabase(path.join(root, 'node.sqlite'));
  db.syncWorkspaces('node', [{ id: 'test', path: root, displayName: 'Test', defaults: {} }]);
  const sessionDir = path.join(root, 'sessions', 'pi_one');
  const session = db.createSession('test', sessionDir, null, null, 'me@example.com');
  const file = path.join(dir, `${KEY}.jsonl`);
  const frames: Array<Extract<NodeToDaemon, { type: 'memory_mirror' }>> = [];
  let accept = true;
  const mirror = new MemoryMirror(dir, db, 60_000);
  mirrors.push(mirror);
  const connect = (watermarks: Record<string, number> = {}) =>
    mirror.connect((frame) => {
      if (!accept) return false;
      frames.push(frame as Extract<NodeToDaemon, { type: 'memory_mirror' }>);
      return true;
    }, watermarks);
  return {
    file,
    frames,
    mirror,
    connect,
    sessionDir,
    sessionId: session.id,
    refuse: (value: boolean) => (accept = !value),
  };
}

const item = (content: string, sessionDir: string): WorkspaceItem => ({
  id: hashId(content),
  content,
  relevance: 'high',
  timestamp: '2026-09-27 10:00',
  sessionId: 'agent-internal-id',
  sessionDir,
  sourceMemoryIds: ['aaaaaaaaaaaa'],
  git: { head: 'abcdef123456', branch: 'main', dirty: false, worktree: '/secret/worktree' },
  tokenCount: 10,
});
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

it('sends complete ledger lines after the acknowledged offset, without paths', () => {
  const { file, frames, mirror, connect, sessionDir, sessionId } = setup();
  const first = line({ type: 'recorded', at: 1, items: [item('Staging first', sessionDir)] });
  const second = line({
    type: 'retired',
    at: 2,
    ids: [hashId('Staging first')],
    reason: 'superseded',
  });
  const partial = JSON.stringify({ type: 'recorded', at: 3, items: [item('Later', sessionDir)] });
  writeFileSync(file, first + second + partial);
  connect();
  expect(frames).toHaveLength(1);
  expect(frames[0]).toEqual({
    type: 'memory_mirror',
    ledgerKey: KEY,
    offset: 0,
    end: Buffer.byteLength(first + second),
    lines: [
      {
        type: 'recorded',
        items: [
          {
            id: hashId('Staging first'),
            content: 'Staging first',
            relevance: 'high',
            timestamp: '2026-09-27 10:00',
            // The node session, not the agent's own id nor its directory.
            sessionId,
            git: { head: 'abcdef123456', branch: 'main', dirty: false },
            sourceMemoryIds: ['aaaaaaaaaaaa'],
          },
        ],
      },
      { type: 'retired', ids: [hashId('Staging first')], reason: 'superseded' },
    ],
  });
  expect(JSON.stringify(frames)).not.toContain('/secret');
  expect(JSON.stringify(frames)).not.toContain(sessionDir);

  // One frame at a time: nothing more until it is acknowledged.
  mirror.scan();
  expect(frames).toHaveLength(1);
  // The half-written line waits until it is complete.
  mirror.receive({ ledgerKey: KEY, watermark: frames[0]!.end });
  expect(frames).toHaveLength(1);
  appendFileSync(file, '\n');
  mirror.scan();
  expect(frames[1]).toMatchObject({
    offset: frames[0]!.end,
    end: Buffer.byteLength(first + second + partial) + 1,
    lines: [{ type: 'recorded', items: [{ content: 'Later' }] }],
  });
});

it('resumes where the gateway is, starts over when the ledger shrank, and retries', () => {
  const { file, frames, mirror, connect, sessionDir, refuse } = setup();
  const content = line({ type: 'recorded', at: 1, items: [item('Kept', sessionDir)] });
  writeFileSync(file, content);
  connect({ [KEY]: Buffer.byteLength(content) });
  expect(frames).toEqual([]);

  writeFileSync(file, line({ type: 'cleared', at: 2 }));
  mirror.scan();
  expect(frames[0]).toMatchObject({ offset: 0, reset: true, lines: [{ type: 'cleared' }] });

  // A frame that could not be sent is tried again on the next scan.
  mirror.receive({ ledgerKey: KEY, watermark: frames[0]!.end });
  appendFileSync(file, line({ type: 'cleared', at: 3 }));
  refuse(true);
  mirror.scan();
  refuse(false);
  mirror.scan();
  expect(frames).toHaveLength(2);
  expect(frames[1]).toMatchObject({ offset: frames[0]!.end, lines: [{ type: 'cleared' }] });
});
