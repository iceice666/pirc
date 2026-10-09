import { z } from 'zod';
import type { Binding } from '../environment/protocol.js';
import type { WorkspaceItem } from '../agent/features/memory/workspace.js';
import type { GatewaySessionAuthority } from './authority.js';
import { canonicalJson, parseJson } from '../environment/json.js';
import { recall } from '../agent/features/memory/recall.js';

/** Fresh-only assistant index, separate from the legacy ownerless node mirror.
 * A trusted node snapshot is synchronized atomically, including retirement/forgetting.
 */
export class GatewayWorkspaceRecords {
  private readonly db;
  constructor(private readonly authority: GatewaySessionAuthority) {
    this.db = authority.inner.operations.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS runtime_workspace_records (
      owner TEXT NOT NULL,node TEXT NOT NULL,repository TEXT NOT NULL,id TEXT NOT NULL,
      item TEXT NOT NULL,search TEXT NOT NULL,PRIMARY KEY(owner,node,repository,id));`);
  }
  sync(
    binding: Binding,
    owner: string,
    snapshot: { repositoryKey: string; items: WorkspaceItem[] },
  ): void {
    this.authority.assertOwner(binding.sessionId, owner);
    const identity = this.authority.identities(binding.sessionId, owner);
    const attested = this.authority.repositorySource(binding.sessionId, owner, identity.branchId);
    if (attested.nodeId !== binding.nodeId || attested.repositoryKey !== snapshot.repositoryKey)
      throw new Error('Fresh mirror repository mismatch');
    canonicalJson(snapshot, 1024 * 1024);
    if (snapshot.items.length > 256) throw new Error('Fresh mirror item quota exceeded');
    const items: WorkspaceItem[] = [];
    for (const item of snapshot.items) {
      if (item.source?.authority !== 'gateway') continue;
      if (
        item.source.nodeId !== binding.nodeId ||
        item.source.repositoryKey !== snapshot.repositoryKey
      )
        throw new Error('Fresh mirror source mismatch');
      try {
        this.authority.assertOwner(item.source.sessionId, owner);
      } catch {
        continue;
      }
      const source = this.authority.repositorySource(
        item.source.sessionId,
        owner,
        item.source.branchId,
      );
      if (source.repositoryKey !== snapshot.repositoryKey || source.nodeId !== binding.nodeId)
        throw new Error('Fresh mirror source attestation mismatch');
      z.object({
        id: z.string().regex(/^[a-f0-9]{12}$/),
        content: z.string().min(1).max(10000),
        sourceMemoryIds: z
          .array(z.string().regex(/^[a-f0-9]{12}$/))
          .min(1)
          .max(64),
      }).parse(item);
      items.push(item);
    }
    this.db
      .transaction(() => {
        this.db
          .query('DELETE FROM runtime_workspace_records WHERE owner=? AND node=? AND repository=?')
          .run(owner, binding.nodeId, snapshot.repositoryKey);
        for (const item of items)
          this.db
            .query('INSERT INTO runtime_workspace_records VALUES (?,?,?,?,?,?)')
            .run(
              owner,
              binding.nodeId,
              snapshot.repositoryKey,
              item.id,
              canonicalJson(item, 65536),
              item.content.normalize('NFKC').toLowerCase(),
            );
      })
      .immediate();
  }
  search(owner: string, query: string, workspace?: string, limit = 8, scopes?: readonly string[]) {
    if (typeof query !== 'string' || !query.trim() || query.length > 4000)
      throw new Error('Invalid memory search query');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
      throw new Error('Invalid memory search limit');
    const terms = [
      ...new Set(query.normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean)),
    ].slice(0, 8);
    if (scopes && (!scopes.length || (workspace && !scopes.includes(workspace))))
      return { hits: [], truncated: false };
    if (scopes && scopes.length > 64) throw new Error('Fresh workspace scope quota exceeded');
    const score = terms.map(() => '(instr(search,?) > 0)').join('+');
    const scopeSql = workspace
      ? " AND node||'/'||repository=?"
      : scopes
        ? ` AND node||'/'||repository IN (${scopes.map(() => '?').join(',')})`
        : '';
    const parameters = [...terms, owner, ...(workspace ? [workspace] : (scopes ?? [])), limit + 1];
    const rows = this.db
      .query(
        `SELECT item,(${score}) AS score FROM runtime_workspace_records
      WHERE owner=? AND score>0${scopeSql} ORDER BY score DESC,json_extract(item,'$.timestamp') DESC LIMIT ?`,
      )
      .all(...parameters) as { item: string; score: number }[];
    const hits = rows
      .map((row) => ({
        item: parseJson(row.item, 65536) as unknown as WorkspaceItem,
        score: row.score,
      }))
      .flatMap(({ item, score }) => {
        // Recheck authoritative ownership; a stored index never grants access by itself.
        this.authority.assertOwner(item.source!.sessionId, owner);
        return [{ score, item }];
      });
    return {
      hits: hits.slice(0, limit).map(({ item }) => ({
        id: item.id,
        kind: 'workspace',
        workspace: `${item.source!.nodeId}/${item.source!.repositoryKey}`,
        date: item.timestamp,
        status: 'active',
        relevance: item.relevance,
        content: item.content.slice(0, 600),
      })),
      truncated: hits.length > limit,
    };
  }
  recall(owner: string, id: string, scopes?: readonly string[]) {
    z.string()
      .regex(/^[a-f0-9]{12}$/)
      .parse(id);
    if (scopes && scopes.length > 64) throw new Error('Fresh workspace scope quota exceeded');
    const scopeSql = scopes?.length
      ? ` AND node||'/'||repository IN (${scopes.map(() => '?').join(',')})`
      : '';
    const rows =
      scopes && !scopes.length
        ? []
        : (this.db
            .query(
              `SELECT item FROM runtime_workspace_records WHERE owner=? AND id=?${scopeSql} LIMIT 2`,
            )
            .all(owner, id, ...(scopes ?? [])) as { item: string }[]);
    if (rows.length !== 1)
      return {
        id,
        status: 'source_unavailable',
        text: 'Fresh source unavailable or ambiguous; no legacy fallback.',
      };
    const item = parseJson(rows[0]!.item, 65536) as unknown as WorkspaceItem;
    this.authority.assertOwner(item.source!.sessionId, owner);
    const source = this.authority.repositorySource(
      item.source!.sessionId,
      owner,
      item.source!.branchId,
    );
    if (
      source.repositoryKey !== item.source!.repositoryKey ||
      source.nodeId !== item.source!.nodeId
    )
      throw new Error('Fresh recall source attestation mismatch');
    const branch = this.authority.memoryBranch(
      item.source!.sessionId,
      owner,
      item.source!.branchId,
    );
    const parts = item.sourceMemoryIds.map((source) => recall(branch, source));
    const text = parts.map((part) => part.text).join('\n\n');
    if (Buffer.byteLength(text) > 512 * 1024) throw new Error('Fresh recall output quota exceeded');
    return {
      id,
      text,
      status: parts.some((part) => part.status === 'ok' || part.status === 'partial')
        ? 'ok'
        : 'source_unavailable',
    };
  }
}
