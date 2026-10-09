import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { GatewayWorkspaceMemory } from '../src/gateway-runtime/workspace-memory.js';
import { selectWorkspaceMemory } from '../src/gateway-runtime/workspace-selection.js';
import { FreshWorkspaceMemory } from '../src/node/fresh-workspace-memory.js';
import { WorkspaceLedger, resolveWorkspace } from '../src/agent/features/memory/workspace.js';
import { OBS_RECORDED, hashId } from '../src/agent/features/memory/ledger.js';
import { descriptorDigest, type Descriptor } from '../src/environment/protocol.js';

test('workspace replacements commit before retirement, with original receipt recovery after lost replies', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-m4-retire-')),
    file = path.join(root, 'authority.sqlite');
  let authority = new GatewaySessionAuthority(file);
  try {
    const lease = authority.activate({
      ...authority.prepare({
        owner: 'alice',
        nodeId: 'n',
        workspaceId: 'n:w',
        legacySessionIds: [],
      }),
      fenced: true,
    });
    const descriptor: Descriptor = {
      binding: lease.binding,
      version: 1,
      revision: '',
      policyRevision: 'a'.repeat(64),
      repositoryKey: resolveWorkspace(root).key,
      capabilityCatalog: [],
      instructions: '',
      skills: [],
      role: 'general',
      platform: 'linux',
      cwdDisplay: root,
      sandboxStatus: { active: true },
      limits: { maxActive: 1, maxBudgetMs: 1000 },
    };
    descriptor.revision = descriptorDigest(descriptor);
    const turn = authority.commitTurn(
      lease,
      {
        runId: randomUUID(),
        turnId: randomUUID(),
        text: 'Project is now completed',
        attachments: [],
      },
      descriptor,
      [],
    );
    const sourceId = hashId('Project completed');
    authority.append(lease, randomUUID(), {
      type: 'custom',
      customType: OBS_RECORDED,
      data: {
        coversUpToId: turn.entry.id,
        observations: [
          {
            id: sourceId,
            content: 'Project completed',
            timestamp: '2026-10-09 12:00',
            relevance: 'high',
            sourceEntryIds: [turn.entry.id],
            tokenCount: 8,
          },
        ],
      },
    });
    const ledger = new WorkspaceLedger(path.join(root, '.memory'), descriptor.repositoryKey!, root);
    const node = new FreshWorkspaceMemory({
      binding: lease.binding,
      descriptor,
      cwd: root,
      authorize: () => {},
      ledger,
    });
    const old = await node.append(lease.binding, {
      operationId: randomUUID(),
      branchId: lease.branchId,
      content: 'Project is in progress',
      relevance: 'high',
      sourceMemoryIds: [sourceId],
      origins: ['user'],
    });
    if ('status' in old) throw Error('Unexpected suppression');
    let selects = 0,
      appends = 0,
      retires = 0,
      loseAppend = true,
      loseRetire = true;
    const service = () =>
      new GatewayWorkspaceMemory({
        authority,
        maxTokens: 1000,
        snapshot: async (binding) => node.snapshot(binding),
        select: async (candidates, signal, context) => {
          selects++;
          return selectWorkspaceMemory(
            candidates,
            async (_system, prompt, tool) => {
              expect(JSON.parse(prompt).current[0].id).toBe(old.id);
              expect(() => tool.execute({ retire: ['f'.repeat(12)] })).toThrow('source');
              tool.execute({
                add: [
                  { content: 'Project completed', relevance: 'high', sourceMemoryIds: [sourceId] },
                ],
                retire: [old.id],
              });
            },
            signal,
            context,
          );
        },
        append: async (binding, input) => {
          appends++;
          const result = await node.append(binding, input);
          if (loseAppend) {
            loseAppend = false;
            throw Error('Lost append reply');
          }
          return result;
        },
        retire: async (binding, input) => {
          retires++;
          const result = await node.retire(binding, input);
          if (loseRetire) {
            loseRetire = false;
            throw Error('Lost retirement reply');
          }
          return result;
        },
      });
    const signal = new AbortController().signal;
    await expect(service().promote(lease, 'alice', descriptor, signal)).rejects.toThrow(
      'Lost append',
    );
    expect(ledger.fold().active).toHaveLength(2);
    expect(retires).toBe(0);
    authority.close();
    authority = new GatewaySessionAuthority(file);
    await expect(service().promote(lease, 'alice', descriptor, signal)).rejects.toThrow(
      'Lost retirement',
    );
    expect(ledger.fold().active.map((item) => item.content)).toEqual(['Project completed']);
    authority.close();
    authority = new GatewaySessionAuthority(file);
    await service().promote(lease, 'alice', descriptor, signal);
    expect(selects).toBe(1);
    expect(appends).toBe(2);
    expect(retires).toBe(2);
    expect(
      ledger.lines().filter((line) => line.type === 'retired' && line.freshReceipt),
    ).toHaveLength(1);
    await service().promote(lease, 'alice', descriptor, signal);
    expect(retires).toBe(2);
    const foreign = { ...lease.binding, sessionId: randomUUID() };
    const other = new FreshWorkspaceMemory({
      binding: foreign,
      descriptor: { ...descriptor, binding: foreign },
      cwd: root,
      authorize: () => {},
      ledger,
    });
    const fresh = ledger.fold().active[0]!;
    await expect(
      other.retire(foreign, {
        operationId: randomUUID(),
        items: [{ id: fresh.id, source: fresh.source! }],
      }),
    ).rejects.toThrow('authorization');
    expect(ledger.fold().active).toHaveLength(1);
    ledger.append({ type: 'retired', at: Date.now(), reason: 'forgotten', ids: [fresh.id] });
    expect(node.snapshot(lease.binding).forgotten[0]?.content).toBe('Project completed');
  } finally {
    authority.close();
    rmSync(root, { recursive: true, force: true });
  }
});
