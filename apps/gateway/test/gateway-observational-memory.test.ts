import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { GatewayObservationalMemory } from '../src/gateway-runtime/observational-memory.js';
import { OBS_RECORDED, foldLedger } from '../src/agent/features/memory/ledger.js';
test('gateway observer reuses ledger validation/source provenance and bounds away image bodies', async () => {
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
    const source = authority.append(lease, randomUUID(), {
      type: 'message',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'User preference with image' },
          { type: 'image', data: 'secret-image-body', mimeType: 'image/png' },
        ],
        timestamp: 1,
      },
    });
    const before = authority.memoryBranch(lease.binding.sessionId, 'alice', lease.branchId);
    expect(JSON.stringify(before)).not.toContain('secret-image-body');
    let models = 0;
    const memory = new GatewayObservationalMemory({
      authority,
      observeAfterTokens: 1,
      reflectAfterTokens: 100000,
      chunkTokens: 1000,
      poolTarget: 1000,
      worker: async (_system, prompt, tool) => {
        models++;
        expect(prompt).not.toContain('secret-image-body');
        tool.execute({
          observations: [
            {
              content: 'Prefers concise output',
              timestamp: '2026-10-09 11:00',
              relevance: 'high',
              sourceEntryIds: [source.id],
            },
            {
              content: 'forged',
              timestamp: '2026-10-09 11:00',
              relevance: 'high',
              sourceEntryIds: [randomUUID()],
            },
          ],
        });
      },
    });
    await memory.consolidate(lease, 'alice', new AbortController().signal);
    const branch = authority.memoryBranch(lease.binding.sessionId, 'alice', lease.branchId),
      folded = foldLedger(branch);
    expect(models).toBe(1);
    expect(folded.activeObservations).toHaveLength(1);
    expect(folded.activeObservations[0]!.sourceEntryIds).toEqual([source.id]);
    expect(
      branch.some((entry) => entry.type === 'custom' && entry.customType === OBS_RECORDED),
    ).toBe(true);
    await memory.consolidate(lease, 'alice', new AbortController().signal);
    expect(models).toBe(1);
  } finally {
    authority.close();
  }
});
