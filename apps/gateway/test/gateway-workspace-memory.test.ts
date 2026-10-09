import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { GatewayWorkspaceMemory } from '../src/gateway-runtime/workspace-memory.js';
import type { Descriptor } from '../src/environment/protocol.js';
import { descriptorDigest } from '../src/environment/protocol.js';
test('workspace context rejects handoff from another authority owner before freezing it', async () => {
  const authority = new GatewaySessionAuthority(':memory:');
  try {
    const make = (owner: string) =>
      authority.activate({
        ...authority.prepare({ owner, nodeId: 'n', workspaceId: 'n:w', legacySessionIds: [] }),
        fenced: true,
      });
    const alice = make('alice'),
      bob = make('bob');
    const descriptor: Descriptor = {
      binding: alice.binding,
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
    authority.commitTurn(
      alice,
      { runId: randomUUID(), turnId: randomUUID(), text: 'private', attachments: [] },
      descriptor,
      [],
    );
    const item = {
      id: 'b'.repeat(12),
      content: 'Alice private handoff',
      relevance: 'high' as const,
      timestamp: '2026-10-09',
      sessionId: alice.binding.sessionId,
      sessionDir: '',
      source: {
        authority: 'gateway' as const,
        nodeId: 'n',
        repositoryKey: 'a'.repeat(16),
        sessionId: alice.binding.sessionId,
        branchId: alice.branchId,
      },
      sourceMemoryIds: ['c'.repeat(12)],
      tokenCount: 6,
    };
    const service = new GatewayWorkspaceMemory({
      authority,
      snapshot: async () => ({ repositoryKey: 'a'.repeat(16), items: [item] }),
      append: async () => item,
      select: async () => [],
      maxTokens: 1000,
    });
    const text = await service.context(
      bob,
      'bob',
      { ...descriptor, binding: bob.binding },
      new AbortController().signal,
    );
    expect(text).not.toContain('Alice private');
  } finally {
    authority.close();
  }
});
