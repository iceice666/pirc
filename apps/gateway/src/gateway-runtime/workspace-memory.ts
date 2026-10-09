import { randomUUID } from 'node:crypto';
import { recall as recallBranch } from '../agent/features/memory/recall.js';
import type { GatewaySessionAuthority } from './authority.js';
import type { WriterLease } from './contracts.js';
import type { Descriptor, Binding } from '../environment/protocol.js';
import {
  WS_SNAPSHOT,
  WS_PROMOTED,
  renderWorkspaceMemory,
  promotionCandidates,
  type WorkspaceItem,
  type FreshWorkspaceAppendResult,
  type FreshWorkspaceSnapshot,
} from '../agent/features/memory/workspace.js';
import { untilCancelled } from './cancellation.js';
import { canonicalJson } from '../environment/json.js';
import { z } from 'zod';
import { redactSecrets } from '../agent/features/memory/redact.js';
import type { WorkspaceSelection, WorkspaceSelectionContext } from './workspace-selection.js';

const PREPARED = 'runtime.workspace.prepared';
const preparedSchema = z
  .object({
    branchId: z.string().uuid(),
    nodeId: z.string(),
    repositoryKey: z.string().regex(/^[a-f0-9]{16}$/),
    completionId: z.string().uuid(),
    consideredMemoryIds: z.array(z.string().regex(/^[a-f0-9]{12}$/)).max(16),
    retire: z
      .array(
        z
          .object({
            operationId: z.string().uuid(),
            items: z
              .array(
                z
                  .object({
                    id: z.string().regex(/^[a-f0-9]{12}$/),
                    source: z
                      .object({
                        authority: z.literal('gateway'),
                        nodeId: z.string(),
                        repositoryKey: z.string().regex(/^[a-f0-9]{16}$/),
                        sessionId: z.string().uuid(),
                        branchId: z.string().uuid(),
                      })
                      .strict(),
                  })
                  .strict(),
              )
              .min(1)
              .max(16),
          })
          .strict(),
      )
      .max(1)
      .default([]),
    proposals: z
      .array(
        z
          .object({
            markerId: z.string().uuid(),
            input: z
              .object({
                operationId: z.string().uuid(),
                content: z.string().min(1).max(10000),
                relevance: z.enum(['low', 'medium', 'high', 'critical']),
                branchId: z.string().uuid(),
                sourceMemoryIds: z
                  .array(z.string().regex(/^[a-f0-9]{12}$/))
                  .min(1)
                  .max(64),
                origins: z.array(z.string().max(200)).max(64),
              })
              .strict(),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();

/** Gateway coordination with node-owned repository ledger. Source IDs remain fresh
 * authority/session/branch references; legacy sessionDir never becomes recall authority.
 */
export class GatewayWorkspaceMemory {
  constructor(
    private readonly options: {
      authority: GatewaySessionAuthority;
      snapshot(binding: Binding): Promise<FreshWorkspaceSnapshot>;
      append(
        binding: Binding,
        input: {
          operationId: string;
          content: string;
          relevance: string;
          branchId: string;
          sourceMemoryIds: string[];
          origins: string[];
        },
      ): Promise<FreshWorkspaceAppendResult>;
      maxTokens: number;
      retire?(
        binding: Binding,
        input: Parameters<
          import('../node/fresh-workspace-memory.js').FreshWorkspaceMemory['retire']
        >[1],
      ): Promise<{ operationId: string; retired: string[] }>;
      select?(
        candidates: ReturnType<typeof promotionCandidates>,
        signal: AbortSignal,
        context?: WorkspaceSelectionContext,
      ): Promise<
        | WorkspaceSelection
        | Array<{
            content: string;
            relevance: string;
            sourceMemoryIds: string[];
            origins: string[];
          }>
      >;
    },
  ) {}
  async context(
    lease: WriterLease,
    owner: string,
    descriptor: Descriptor,
    signal: AbortSignal,
  ): Promise<string> {
    if (!descriptor.repositoryKey) throw new Error('Node repository attestation unavailable');
    const existing = this.options.authority
      .customEntries(lease.binding.sessionId, owner, lease.branchId, WS_SNAPSHOT, 1, true)
      .at(-1);
    if (existing?.type === 'custom') {
      const data = existing.data as {
        repositoryKey?: unknown;
        text?: unknown;
        items?: WorkspaceItem[];
      };
      if (data.repositoryKey !== descriptor.repositoryKey || typeof data.text !== 'string')
        throw new Error('Workspace snapshot revision mismatch');
      for (const item of data.items ?? []) {
        if (
          !item.source ||
          item.source.nodeId !== lease.binding.nodeId ||
          item.source.repositoryKey !== descriptor.repositoryKey
        )
          throw new Error('Invalid frozen workspace source');
        this.options.authority.assertOwner(item.source.sessionId, owner);
        const source = this.options.authority.repositorySource(
          item.source.sessionId,
          owner,
          item.source.branchId,
        );
        if (
          source.repositoryKey !== descriptor.repositoryKey ||
          source.nodeId !== lease.binding.nodeId
        )
          throw new Error('Frozen workspace source attestation mismatch');
      }
      return data.text;
    }
    const snapshot = await untilCancelled(this.options.snapshot(lease.binding), signal);
    if (snapshot.repositoryKey !== descriptor.repositoryKey)
      throw new Error('Workspace memory repository mismatch');
    canonicalJson(snapshot, 1024 * 1024);
    const items = snapshot.items
      .filter(
        (item) =>
          item.source?.authority === 'gateway' &&
          item.source.nodeId === lease.binding.nodeId &&
          item.source.repositoryKey === descriptor.repositoryKey,
      )
      .filter((item) => {
        try {
          this.options.authority.assertOwner(item.source!.sessionId, owner);
          const source = this.options.authority.repositorySource(
            item.source!.sessionId,
            owner,
            item.source!.branchId,
          );
          return (
            source.repositoryKey === descriptor.repositoryKey &&
            source.nodeId === lease.binding.nodeId
          );
        } catch {
          return false;
        }
      });
    const text = renderWorkspaceMemory(
      items,
      descriptor.cwdDisplay,
      undefined,
      this.options.maxTokens,
    );
    this.options.authority.append(lease, randomUUID(), {
      type: 'custom',
      customType: WS_SNAPSHOT,
      data: JSON.parse(JSON.stringify({ repositoryKey: snapshot.repositoryKey, text, items })),
    });
    return text;
  }
  recall(
    lease: WriterLease,
    owner: string,
    descriptor: Descriptor,
    item: WorkspaceItem,
  ): { text: string; status: string } {
    const source = item.source;
    if (!source || source.authority !== 'gateway')
      return {
        text: 'Legacy workspace source unavailable in fresh runtime; no JSONL fallback.',
        status: 'source_unavailable',
      };
    if (source.nodeId !== lease.binding.nodeId || source.repositoryKey !== descriptor.repositoryKey)
      throw new Error('Workspace recall repository mismatch');
    this.options.authority.assertOwner(source.sessionId, owner);
    const attested = this.options.authority.repositorySource(
      source.sessionId,
      owner,
      source.branchId,
    );
    if (attested.nodeId !== source.nodeId || attested.repositoryKey !== source.repositoryKey)
      throw new Error('Workspace source lacks authoritative repository attestation');
    const branch = this.options.authority.memoryBranch(source.sessionId, owner, source.branchId);
    const parts = item.sourceMemoryIds.map((id) => recallBranch(branch, id));
    const text = parts.map((part) => part.text).join('\n\n');
    if (Buffer.byteLength(text) > 512 * 1024)
      throw new Error('Workspace recall output quota exceeded');
    return {
      text,
      status: parts.some((part) => part.status === 'ok' || part.status === 'partial')
        ? 'ok'
        : 'source_unavailable',
    };
  }
  async promote(
    lease: WriterLease,
    owner: string,
    descriptor: Descriptor,
    signal: AbortSignal,
    select?: NonNullable<GatewayWorkspaceMemory['options']['select']>,
  ): Promise<void> {
    signal.throwIfAborted();
    this.checkSource(lease, owner, descriptor);
    if (await this.recover(lease, owner, descriptor, signal)) return;
    const considered = new Set(
      this.options.authority
        .customEntries(lease.binding.sessionId, owner, lease.branchId, WS_PROMOTED, 10000)
        .flatMap((entry) =>
          entry.type === 'custom' ? ((entry.data as any)?.consideredMemoryIds ?? []) : [],
        ),
    );
    const branch = this.options.authority.memoryBranch(
        lease.binding.sessionId,
        owner,
        lease.branchId,
      ),
      candidates = promotionCandidates(branch)
        .filter((candidate) => !considered.has(candidate.id))
        .slice(0, 16);
    if (!candidates.length) return;
    const selector = this.options.select ?? select;
    if (!selector) throw new Error('Workspace selection model unavailable');
    const snapshot = await untilCancelled(this.options.snapshot(lease.binding), signal);
    if (snapshot.repositoryKey !== descriptor.repositoryKey)
      throw Error('Workspace promotion repository mismatch');
    canonicalJson(snapshot, 1024 * 1024);
    if (snapshot.items.length > 256) throw Error('Workspace promotion item quota exceeded');
    const eligible = (item: WorkspaceItem) => {
      if (
        item.source?.authority !== 'gateway' ||
        item.source.nodeId !== lease.binding.nodeId ||
        item.source.repositoryKey !== descriptor.repositoryKey
      )
        return false;
      try {
        this.options.authority.assertOwner(item.source.sessionId, owner);
        const source = this.options.authority.repositorySource(
          item.source.sessionId,
          owner,
          item.source.branchId,
        );
        return (
          source.nodeId === lease.binding.nodeId &&
          source.repositoryKey === descriptor.repositoryKey
        );
      } catch {
        return false;
      }
    };
    const items = snapshot.items.filter(eligible),
      forgotten = (snapshot.forgotten ?? []).filter(eligible);
    const selected = await untilCancelled(
      selector(candidates, signal, {
        items,
        forgotten,
        allowRetire: !!this.options.retire,
        maxTokens: this.options.maxTokens,
      }),
      signal,
    );
    const proposals = Array.isArray(selected) ? selected : selected.add,
      allowed = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const retire = Array.isArray(selected) ? [] : [...new Set(selected.retire)];
    if (
      retire.length > 16 ||
      retire.some((id) => !items.some((item) => item.id === id)) ||
      (retire.length && !this.options.retire)
    )
      throw Error('Invalid workspace retirement source');
    if (proposals.length > 16) throw new Error('Workspace promotion quota exceeded');
    const prepared = preparedSchema.parse({
      branchId: lease.branchId,
      nodeId: lease.binding.nodeId,
      repositoryKey: descriptor.repositoryKey,
      completionId: randomUUID(),
      consideredMemoryIds: candidates.map((candidate) => candidate.id),
      retire: retire.length
        ? [
            {
              operationId: randomUUID(),
              items: retire.map((id) => ({
                id,
                source: items.find((item) => item.id === id)!.source!,
              })),
            },
          ]
        : [],
      proposals: proposals.map((proposal) => {
        if (
          !proposal.sourceMemoryIds.length ||
          proposal.sourceMemoryIds.some((id) => !allowed.has(id))
        )
          throw new Error('Invalid workspace promotion provenance');
        return {
          markerId: randomUUID(),
          input: {
            ...proposal,
            content: redactSecrets(proposal.content).replace(/\s+/g, ' ').trim(),
            operationId: randomUUID(),
            branchId: lease.branchId,
            origins: [
              ...new Set(
                proposal.sourceMemoryIds.flatMap((id) => allowed.get(id)?.origins ?? ['unknown']),
              ),
            ],
          },
        };
      }),
    });
    signal.throwIfAborted();
    this.checkSource(lease, owner, descriptor);
    this.options.authority.append(lease, randomUUID(), {
      type: 'custom',
      customType: PREPARED,
      data: JSON.parse(canonicalJson(prepared, 1024 * 1024)),
    });
    await this.recover(lease, owner, descriptor, signal);
  }
  private checkSource(lease: WriterLease, owner: string, descriptor: Descriptor): void {
    this.options.authority.assertWriter(lease);
    if (!descriptor.repositoryKey) throw new Error('Repository attestation unavailable');
    const source = this.options.authority.repositorySource(
      lease.binding.sessionId,
      owner,
      lease.branchId,
    );
    if (source.nodeId !== lease.binding.nodeId || source.repositoryKey !== descriptor.repositoryKey)
      throw new Error('Workspace promotion attestation mismatch');
  }
  private async recover(
    lease: WriterLease,
    owner: string,
    descriptor: Descriptor,
    signal: AbortSignal,
  ): Promise<boolean> {
    const done = new Set(
      this.options.authority
        .customEntries(lease.binding.sessionId, owner, lease.branchId, WS_PROMOTED, 10000)
        .flatMap((entry) =>
          entry.type === 'custom' && typeof (entry.data as any)?.operationId === 'string'
            ? [(entry.data as any).operationId]
            : [],
        ),
    );
    const prepared = this.options.authority
      .customEntries(lease.binding.sessionId, owner, lease.branchId, PREPARED, 10000)
      .map((entry) => preparedSchema.parse(entry.type === 'custom' ? entry.data : null))
      .filter((batch) => batch.branchId === lease.branchId);
    let recovered = false;
    for (const batch of prepared) {
      if (batch.nodeId !== lease.binding.nodeId || batch.repositoryKey !== descriptor.repositoryKey)
        throw new Error('Prepared workspace scope mismatch');
      if (done.has(batch.completionId)) continue;
      recovered = true;
      for (const proposal of batch.proposals) {
        if (done.has(proposal.input.operationId)) continue;
        recovered = true;
        signal.throwIfAborted();
        if (proposal.input.branchId !== lease.branchId)
          throw new Error('Prepared workspace branch mismatch');
        this.checkSource(lease, owner, descriptor);
        const saved = await untilCancelled(
          this.options.append(lease.binding, proposal.input),
          signal,
        );
        signal.throwIfAborted();
        this.checkSource(lease, owner, descriptor);
        if ('status' in saved) {
          if (
            saved.status !== 'suppressed' ||
            saved.operationId !== proposal.input.operationId ||
            !['forgotten', 'cleared', 'legacy'].includes(saved.reason)
          )
            throw new Error('Invalid workspace suppression receipt');
          this.options.authority.append(lease, proposal.markerId, {
            type: 'custom',
            customType: WS_PROMOTED,
            data: {
              operationId: proposal.input.operationId,
              memoryIds: [],
              consideredMemoryIds: proposal.input.sourceMemoryIds,
              status: saved.reason,
            },
          });
          done.add(proposal.input.operationId);
          continue;
        }
        if (
          saved.source?.authority !== 'gateway' ||
          saved.source.nodeId !== lease.binding.nodeId ||
          saved.source.repositoryKey !== descriptor.repositoryKey
        )
          throw new Error('Workspace append result scope mismatch');
        let sameOwner = true;
        try {
          this.options.authority.assertOwner(saved.source.sessionId, owner);
        } catch {
          sameOwner = false;
        }
        if (!sameOwner) {
          this.options.authority.append(lease, proposal.markerId, {
            type: 'custom',
            customType: WS_PROMOTED,
            data: {
              operationId: proposal.input.operationId,
              memoryIds: [],
              consideredMemoryIds: proposal.input.sourceMemoryIds,
              status: 'source_unavailable',
            },
          });
          done.add(proposal.input.operationId);
          continue;
        }
        const attested = this.options.authority.repositorySource(
          saved.source.sessionId,
          owner,
          saved.source.branchId,
        );
        if (
          attested.nodeId !== lease.binding.nodeId ||
          attested.repositoryKey !== descriptor.repositoryKey
        )
          throw new Error('Workspace append result attestation mismatch');
        const matches =
          saved.source.sessionId === lease.binding.sessionId &&
          saved.source.branchId === lease.branchId &&
          proposal.input.sourceMemoryIds.every((id) => saved.sourceMemoryIds.includes(id));
        this.options.authority.append(lease, proposal.markerId, {
          type: 'custom',
          customType: WS_PROMOTED,
          data: {
            operationId: proposal.input.operationId,
            memoryIds: matches ? proposal.input.sourceMemoryIds : [],
            consideredMemoryIds: proposal.input.sourceMemoryIds,
          },
        });
      }
      signal.throwIfAborted();
      this.checkSource(lease, owner, descriptor);
      // Keep old facts available until every replacement append has a durable receipt.
      for (const retirement of batch.retire) {
        if (done.has(retirement.operationId)) continue;
        if (!this.options.retire) throw Error('Workspace retirement service unavailable');
        signal.throwIfAborted();
        this.checkSource(lease, owner, descriptor);
        for (const item of retirement.items)
          this.options.authority.assertOwner(item.source.sessionId, owner);
        const result = await untilCancelled(this.options.retire(lease.binding, retirement), signal);
        signal.throwIfAborted();
        this.checkSource(lease, owner, descriptor);
        if (
          result.operationId !== retirement.operationId ||
          result.retired.some((id) => !retirement.items.some((item) => item.id === id))
        )
          throw Error('Workspace retirement receipt mismatch');
        this.options.authority.append(lease, retirement.operationId, {
          type: 'custom',
          customType: WS_PROMOTED,
          data: {
            operationId: retirement.operationId,
            memoryIds: [],
            consideredMemoryIds: [],
            retired: result.retired,
          },
        });
        done.add(retirement.operationId);
      }
      this.options.authority.append(lease, batch.completionId, {
        type: 'custom',
        customType: WS_PROMOTED,
        data: {
          operationId: batch.completionId,
          memoryIds: [],
          consideredMemoryIds: batch.consideredMemoryIds,
        },
      });
    }
    return recovered;
  }
}
