import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WorkspaceLedger,
  resolveWorkspace,
  recallWorkspaceItem,
} from '../src/agent/features/memory/workspace.js';
import { FreshWorkspaceMemory } from '../src/node/fresh-workspace-memory.js';
import type { Descriptor } from '../src/environment/protocol.js';
test('fresh workspace ledger records gateway source identities and never opens legacy JSONL on recall', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-fresh-memory-'));
  try {
    const binding = {
        nodeId: 'n',
        workspaceId: 'n:w',
        sessionId: randomUUID(),
        writerEpoch: randomUUID(),
        executorEpoch: randomUUID(),
      },
      key = resolveWorkspace(root).key,
      ledger = new WorkspaceLedger(path.join(root, '.memory'), key, root);
    const service = new FreshWorkspaceMemory({
      binding,
      descriptor: { repositoryKey: key } as Descriptor,
      cwd: root,
      authorize: () => {},
      ledger,
    });
    const input = {
      operationId: randomUUID(),
      content: 'Keep project constraint',
      relevance: 'high',
      branchId: randomUUID(),
      sourceMemoryIds: ['a'.repeat(12)],
      origins: ['user'],
    };
    const result = await service.append(binding, input);
    if ('status' in result) throw new Error('Unexpected suppression');
    const item = result;
    expect(await service.append(binding, input)).toEqual(item);
    expect(
      ledger.lines().filter((line) => line.type === 'recorded' && line.freshReceipts?.length),
    ).toHaveLength(1);
    await expect(service.append(binding, { ...input, content: 'changed intent' })).rejects.toThrow(
      'identity conflict',
    );
    expect(service.snapshot(binding).items).toHaveLength(1);
    const legacy = {
      ...item,
      id: 'b'.repeat(12),
      content: 'legacy original',
      sessionDir: '/legacy',
    };
    delete legacy.source;
    ledger.append({
      type: 'recorded',
      at: Date.now(),
      items: [
        {
          ...legacy,
          id: (await import('../src/agent/features/memory/ledger.js')).hashId(legacy.content),
        },
      ],
    });
    expect(
      await service.append(binding, {
        ...input,
        operationId: randomUUID(),
        content: legacy.content,
      }),
    ).toMatchObject({ status: 'suppressed', reason: 'legacy' });
    expect(item.source?.authority).toBe('gateway');
    expect(item.sessionDir).toBe('');
    let read = false;
    expect(
      recallWorkspaceItem(item, () => {
        read = true;
        return { text: 'bad', status: 'ok' };
      }).status,
    ).toBe('source_unavailable');
    expect(read).toBe(false);
    ledger.append({ type: 'cleared', at: Date.now() });
    const replacement = await service.append(binding, {
      ...input,
      operationId: randomUUID(),
      branchId: randomUUID(),
    });
    expect('status' in replacement).toBe(false);
    expect(await service.append(binding, input)).toMatchObject({
      status: 'suppressed',
      reason: 'cleared',
    });
    ledger.append({ type: 'retired', at: Date.now(), ids: [item.id], reason: 'forgotten' });
    expect(await service.append(binding, input)).toEqual({
      status: 'suppressed',
      operationId: input.operationId,
      reason: 'forgotten',
    });
    expect(
      await service.append(binding, {
        operationId: randomUUID(),
        content: 'Keep project constraint',
        relevance: 'high',
        branchId: randomUUID(),
        sourceMemoryIds: ['a'.repeat(12)],
        origins: ['user'],
      }),
    ).toMatchObject({ status: 'suppressed', reason: 'forgotten' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
