import { createHash } from 'node:crypto';
import type { Binding, Descriptor } from '../environment/protocol.js';
import { CONTROL_BYTES } from '../environment/protocol.js';
import { canonicalJson } from '../environment/json.js';
import {
  WorkspaceLedger,
  resolveWorkspace,
  type WorkspaceItem,
  type FreshWorkspaceAppendResult,
} from '../agent/features/memory/workspace.js';
import { hashId, RELEVANCES } from '../agent/features/memory/ledger.js';
import { z } from 'zod';
import { contentHash } from '../daemon/memory.js';
import { redactSecrets } from '../agent/features/memory/redact.js';

/** Trusted node-owned materialization, separate from sandbox model execution.
 * The service accepts only gateway-validated distilled facts; no path is an argument.
 * Legacy records remain untouched and cannot become fresh source evidence.
 */
export class FreshWorkspaceMemory {
  constructor(
    private readonly options: {
      binding: Binding;
      descriptor: Descriptor;
      cwd: string;
      authorize(binding: Binding): void;
      ledger: WorkspaceLedger;
    },
  ) {}
  private check(binding: Binding) {
    this.options.authorize(binding);
    if (
      canonicalJson(binding, CONTROL_BYTES) !==
        canonicalJson(this.options.binding, CONTROL_BYTES) ||
      this.options.descriptor.repositoryKey !== resolveWorkspace(this.options.cwd).key ||
      this.options.ledger.key !== this.options.descriptor.repositoryKey
    )
      throw new Error('Workspace memory binding mismatch');
  }
  snapshot(binding: Binding) {
    this.check(binding);
    const fresh = this.options.ledger
      .fold()
      .active.filter(
        (item) =>
          item.source?.authority === 'gateway' &&
          item.source.nodeId === binding.nodeId &&
          item.source.repositoryKey === this.options.ledger.key,
      );
    if (fresh.length > 256) throw new Error('Workspace snapshot item quota exceeded');
    canonicalJson(fresh, 1024 * 1024);
    return { repositoryKey: this.options.ledger.key, items: fresh };
  }
  async append(
    binding: Binding,
    input: {
      operationId: string;
      content: string;
      relevance: string;
      branchId: string;
      sourceMemoryIds: string[];
      origins: string[];
    },
  ): Promise<FreshWorkspaceAppendResult> {
    this.check(binding);
    input = z
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
      .strict()
      .parse(input);
    if (
      !RELEVANCES.includes(input.relevance as any) ||
      !input.sourceMemoryIds.length ||
      input.sourceMemoryIds.length > 64 ||
      input.sourceMemoryIds.some((id) => !/^[a-f0-9]{12}$/.test(id)) ||
      !/^[a-f0-9-]{36}$/.test(input.branchId)
    )
      throw new Error('Invalid fresh memory evidence');
    const content = redactSecrets(input.content).replace(/\s+/g, ' ').trim();
    if (!content || content.length > 10000) throw new Error('Invalid workspace memory content');
    const item: WorkspaceItem = {
      id: hashId(content),
      content,
      relevance: input.relevance as WorkspaceItem['relevance'],
      timestamp: new Date().toISOString(),
      sessionId: binding.sessionId,
      sessionDir: '',
      source: {
        authority: 'gateway',
        nodeId: binding.nodeId,
        repositoryKey: this.options.ledger.key,
        sessionId: binding.sessionId,
        branchId: input.branchId,
      },
      sourceMemoryIds: [...new Set(input.sourceMemoryIds)],
      origins: [...new Set(input.origins)].slice(0, 64),
      tokenCount: 0,
    };
    item.tokenCount = Math.ceil(content.length / 4);
    const digest = createHash('sha256')
      .update(canonicalJson({ binding, input }, CONTROL_BYTES))
      .digest('hex');
    const itemDigest = (value: WorkspaceItem) =>
      createHash('sha256').update(canonicalJson(value, CONTROL_BYTES)).digest('hex');
    const saved = await this.options.ledger.withLock(async () => {
      const lines = this.options.ledger.lines();
      const folded = this.options.ledger.fold();
      const receipts = lines.flatMap((line, index) =>
        line.type === 'recorded'
          ? (line.freshReceipts ?? []).map((receipt) => ({ receipt, index }))
          : [],
      );
      const found = receipts.find((value) => value.receipt.operationId === input.operationId);
      const receipt = found?.receipt;
      if (receipt) {
        if (receipt.digest !== digest) throw new Error('Workspace operation identity conflict');
        if (receipt.suppressed)
          return {
            status: 'suppressed' as const,
            operationId: input.operationId,
            reason: receipt.suppressed,
          };
        const previous = folded.items.get(receipt.itemId);
        if (
          !previous ||
          folded.forgotten.has(receipt.itemId) ||
          lines.slice(found!.index + 1).some((line) => line.type === 'cleared')
        )
          return {
            status: 'suppressed' as const,
            operationId: input.operationId,
            reason: folded.forgotten.has(receipt.itemId)
              ? ('forgotten' as const)
              : ('cleared' as const),
          };
        if (itemDigest(previous) !== receipt.resultDigest)
          throw new Error('Workspace receipt result conflict');
        return previous;
      }
      const record = (result: WorkspaceItem, items: WorkspaceItem[]) => {
        this.options.ledger.appendDurable({
          type: 'recorded',
          at: Date.now(),
          items,
          freshReceipts: [
            {
              operationId: input.operationId,
              digest,
              itemId: result.id,
              resultDigest: itemDigest(result),
            },
          ],
        });
        return result;
      };
      const suppress = (reason: 'forgotten' | 'legacy') => {
        this.options.ledger.appendDurable({
          type: 'recorded',
          at: Date.now(),
          items: [],
          freshReceipts: [
            {
              operationId: input.operationId,
              digest,
              itemId: item.id,
              resultDigest: itemDigest(item),
              suppressed: reason,
            },
          ],
        });
        return { status: 'suppressed' as const, operationId: input.operationId, reason };
      };
      if (
        folded.forgotten.has(item.id) ||
        [...folded.forgotten.values()].some(
          (value) => value !== undefined && contentHash(value) === contentHash(content),
        )
      )
        return suppress('forgotten');
      const existing = folded.items.get(item.id);
      if (existing) {
        if (existing.source?.authority !== 'gateway') return suppress('legacy');
        if (
          canonicalJson(existing, CONTROL_BYTES) !== canonicalJson(item, CONTROL_BYTES) &&
          existing.content !== item.content
        )
          throw new Error('Memory ID conflict');
        return record(existing, []);
      }
      return record(item, [item]);
    });
    if (!saved) throw new Error('Workspace memory is locked');
    return saved;
  }
}
