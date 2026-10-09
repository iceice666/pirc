import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { GatewayWorkspaceMemory } from '../src/gateway-runtime/workspace-memory.js';
import { FreshWorkspaceMemory } from '../src/node/fresh-workspace-memory.js';
import {
  WorkspaceLedger,
  resolveWorkspace,
  WS_PROMOTED,
} from '../src/agent/features/memory/workspace.js';
import { GatewayObservationalMemory } from '../src/gateway-runtime/observational-memory.js';
import { descriptorDigest, type Descriptor } from '../src/environment/protocol.js';
import { OBS_RECORDED, hashId } from '../src/agent/features/memory/ledger.js';

test('successful empty workspace selection advances past the first sixteen candidates', async () => {
  const authority = new GatewaySessionAuthority(':memory:');
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
      repositoryKey: 'a'.repeat(16),
      capabilityCatalog: [],
      instructions: '',
      skills: [],
      role: 'general',
      platform: 'linux',
      cwdDisplay: '/node',
      sandboxStatus: { active: true },
      limits: { maxActive: 1, maxBudgetMs: 1000 },
    };
    descriptor.revision = descriptorDigest(descriptor);
    const turn = authority.commitTurn(
      lease,
      { runId: randomUUID(), turnId: randomUUID(), text: 'many decisions', attachments: [] },
      descriptor,
      [],
    );
    authority.append(lease, randomUUID(), {
      type: 'custom',
      customType: OBS_RECORDED,
      data: {
        coversUpToId: turn.entry.id,
        observations: Array.from({ length: 17 }, (_, i) => ({
          id: hashId(`decision-${i}`),
          content: `decision-${i}`,
          timestamp: '2026-10-09 12:00',
          relevance: 'high',
          sourceEntryIds: [turn.entry.id],
          tokenCount: 10,
        })),
      },
    });
    const selected: string[][] = [];
    const service = new GatewayWorkspaceMemory({
      authority,
      maxTokens: 1000,
      snapshot: async () => ({ repositoryKey: descriptor.repositoryKey!, items: [] }),
      append: async () => {
        throw new Error('No effect expected');
      },
      select: async (candidates) => {
        selected.push(candidates.map((c) => c.id));
        return [];
      },
    });
    const signal = new AbortController().signal;
    await service.promote(lease, 'alice', descriptor, signal);
    await service.promote(lease, 'alice', descriptor, signal);
    await service.promote(lease, 'alice', descriptor, signal);
    expect(selected.map((batch) => batch.length)).toEqual([16, 1]);
    expect(selected[1]).toEqual([hashId('decision-16')]);
  } finally {
    authority.close();
  }
});

for (const forgotten of [false, true])
  test(`prepared workspace batch recovers lost append replies${forgotten ? ' after forget' : ''} with original receipts and no reselection`, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-workspace-recovery-'));
    let authority = new GatewaySessionAuthority(path.join(root, 'authority.sqlite'));
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
          text: 'Keep project decisions',
          attachments: [],
        },
        descriptor,
        [],
      );
      await new GatewayObservationalMemory({
        authority,
        observeAfterTokens: 1,
        reflectAfterTokens: 100000,
        chunkTokens: 1000,
        poolTarget: 1000,
        worker: async (_s, _p, tool) => {
          tool.execute({
            observations: [
              {
                content: 'Keep project decisions',
                timestamp: '2026-10-09 12:00',
                relevance: 'high',
                sourceEntryIds: [turn.entry.id],
              },
            ],
          });
        },
      }).consolidate(lease, 'alice', new AbortController().signal);
      const ledger = new WorkspaceLedger(
        path.join(root, '.memory'),
        descriptor.repositoryKey!,
        root,
      );
      const node = () =>
        new FreshWorkspaceMemory({
          binding: lease.binding,
          descriptor,
          cwd: root,
          authorize: () => {},
          ledger,
        });
      let selections = 0,
        requests = 0,
        lose = true;
      const make = () =>
        new GatewayWorkspaceMemory({
          authority,
          maxTokens: 1000,
          snapshot: async () => node().snapshot(lease.binding),
          select: async (candidates) => {
            selections++;
            return [
              {
                content: 'Persisted decision',
                relevance: 'high',
                sourceMemoryIds: [candidates[0]!.id],
                origins: ['forged-origin'],
              },
            ];
          },
          append: async (binding, input) => {
            requests++;
            const saved = await node().append(binding, input);
            if (lose) {
              lose = false;
              throw new Error('lost reply');
            }
            return saved;
          },
        });
      const signal = new AbortController().signal;
      await expect(make().promote(lease, 'alice', descriptor, signal)).rejects.toThrow(
        'lost reply',
      );
      expect(ledger.fold().active).toHaveLength(1);
      if (forgotten)
        ledger.append({
          type: 'retired',
          at: Date.now(),
          ids: [ledger.fold().active[0]!.id],
          reason: 'forgotten',
        });
      authority.close();
      authority = new GatewaySessionAuthority(path.join(root, 'authority.sqlite'));
      await make().promote(lease, 'alice', descriptor, signal);
      expect(selections).toBe(1);
      expect(requests).toBe(2);
      expect(
        ledger.lines().filter((line) => line.type === 'recorded' && line.freshReceipts?.length),
      ).toHaveLength(1);
      if (!forgotten) expect(ledger.fold().active[0]!.origins).not.toContain('forged-origin');
      else expect(ledger.fold().active).toHaveLength(0);
      const markers = authority.customEntries(
        lease.binding.sessionId,
        'alice',
        lease.branchId,
        WS_PROMOTED,
      );
      expect(markers).toHaveLength(2);
      await make().promote(lease, 'alice', descriptor, signal);
      expect(requests).toBe(2);
      expect(selections).toBe(1);
      const context = await make().context(lease, 'alice', descriptor, signal);
      if (forgotten) expect(context).not.toContain('Persisted decision');
      else expect(context).toContain('Persisted decision');
    } finally {
      authority.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
