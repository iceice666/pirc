import { MemoryStore, type MemoryBudgets } from '../daemon/memory.js';
import {
  ASSISTANT_SNAPSHOT,
  renderMemory,
  renderWorkspaces,
  presentSection,
} from '../agent/features/assistant/index.js';
import {
  PROJECT_INSTRUCTIONS_SNAPSHOT,
  renderInstructions,
} from '../agent/features/project-instructions.js';
import { capabilities } from '../agent/capabilities.js';
import type { Binding, Descriptor, ExecutionIntent } from '../environment/protocol.js';
import type { GatewaySessionAuthority } from './authority.js';
import type { WriterLease } from './contracts.js';
import { canonicalJson } from '../environment/json.js';
import { randomUUID } from 'node:crypto';

/** Reuses chat rendering and frozen branch snapshots; current proposal decisions stay live. */
export class GatewayAssistantContext {
  constructor(
    private readonly options: {
      authority: GatewaySessionAuthority;
      budgets: MemoryBudgets;
      chat(binding: Binding): boolean;
      remoteRecall?(binding: Binding): boolean;
      workspaces?(binding: Binding): Parameters<typeof renderWorkspaces>[0];
    },
  ) {}
  context(lease: WriterLease, owner: string, descriptor: Descriptor): string {
    const authority = this.options.authority;
    authority.assertOwner(lease.binding.sessionId, owner);
    authority.assertWriter(lease);
    if (!this.options.chat(lease.binding)) return '';
    const memory = new MemoryStore(authority.inner.operations.db, this.options.budgets).context(
      owner,
      lease.binding.sessionId,
    );
    let snapshot = authority
      .customEntries(lease.binding.sessionId, owner, lease.branchId, ASSISTANT_SNAPSHOT, 1, true)
      .at(-1);
    if (!snapshot) {
      const text = [
        renderMemory(memory),
        renderWorkspaces(this.options.workspaces?.(lease.binding)),
      ]
        .filter(Boolean)
        .join('\n\n');
      snapshot = authority.append(lease, randomUUID(), {
        type: 'custom',
        customType: ASSISTANT_SNAPSHOT,
        data: JSON.parse(
          canonicalJson(
            {
              text,
              entries: [...memory.user, ...memory.notes].map((item) => ({
                id: item.id,
                revision: item.revision,
              })),
            },
            1024 * 1024,
          ),
        ),
      });
    }
    let instructions = authority
      .customEntries(
        lease.binding.sessionId,
        owner,
        lease.branchId,
        PROJECT_INSTRUCTIONS_SNAPSHOT,
        1,
        true,
      )
      .at(-1);
    if (!instructions)
      instructions = authority.append(lease, randomUUID(), {
        type: 'custom',
        customType: PROJECT_INSTRUCTIONS_SNAPSHOT,
        data: { text: descriptor.projectInstructions ?? '' },
      });
    const names = new Set(descriptor.capabilityCatalog.map((cap) => cap.name));
    const shown = presentSection(
      snapshot.type === 'custom' ? String((snapshot.data as any)?.text ?? '') : '',
      capabilities({
        delegation: names.has('delegate'),
        memory_search: names.has('memory_search'),
        remote_recall: names.has('recall') && !!this.options.remoteRecall?.(lease.binding),
      }),
    );
    return [
      renderInstructions(
        instructions.type === 'custom' ? String((instructions.data as any)?.text ?? '') : '',
      ),
      shown,
      ...(memory.proposalDecisions.length
        ? [
            `## Memory proposal decisions (current)\n${JSON.stringify(memory.proposalDecisions)}\nThese decisions are already applied; do not repeat rejected proposals.`,
          ]
        : []),
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  revisions(intent: ExecutionIntent): Record<string, number> {
    const authority = this.options.authority,
      owner = authority.sessionOwner(intent.binding.sessionId);
    const snapshot = authority
      .customEntries(
        intent.binding.sessionId,
        owner,
        authority.executionBranch(intent),
        ASSISTANT_SNAPSHOT,
        1,
        true,
      )
      .at(-1);
    const entries = snapshot?.type === 'custom' ? ((snapshot.data as any)?.entries ?? []) : [];
    return {
      ...Object.fromEntries(entries.map((item: any) => [item.id, item.revision])),
      ...((authority.featureState(intent, 'assistant-note-revisions') as Record<string, number>) ??
        {}),
    };
  }
}
