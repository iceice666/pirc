import type { Database } from 'bun:sqlite';
import { GatewayOperations } from './gateway-operation.js';
import { BUDGETS } from '../agent/ptc/contracts.js';
import { canonicalJson, digest, parseJson } from './json.js';
import {
  bindingSchema,
  CONTROL_BYTES,
  REQUEST_BYTES,
  RESULT_BYTES,
  terminalSchema,
  validateIntent,
  type Binding,
  type ExecutionIntent,
  type Terminal,
} from './protocol.js';

export interface InnerOperation {
  intent: ExecutionIntent;
  state: 'accepted' | 'running' | 'terminal';
  result?: Terminal;
  delivered: boolean;
}
interface Row {
  intent: string;
  state: InnerOperation['state'];
  result: string | null;
  delivered: number;
}

/** Shared durable ledger, on the owning service's SQLite connection. It never dispatches.
 * Lifecycle entrypoints are supervisor-only; transport callers must authenticate the binding.
 * Central DB-covered effects can use transact() on this exact connection, not another database.
 */
export class InnerJournal {
  readonly operations: GatewayOperations;
  constructor(private readonly db: Database) {
    this.operations = new GatewayOperations(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ptc_parents(id TEXT PRIMARY KEY,binding TEXT NOT NULL,intent TEXT NOT NULL,manifest TEXT NOT NULL,sealed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS ptc_inner(id TEXT PRIMARY KEY,parent TEXT NOT NULL REFERENCES ptc_parents(id),inner_id TEXT NOT NULL,intent TEXT NOT NULL,state TEXT NOT NULL,result TEXT,delivered INTEGER NOT NULL DEFAULT 0,UNIQUE(parent,inner_id));
      CREATE TABLE IF NOT EXISTS ptc_inner_reconciliations(parent TEXT NOT NULL,inner_id TEXT NOT NULL,previous TEXT NOT NULL,PRIMARY KEY(parent,inner_id));
      CREATE TABLE IF NOT EXISTS ptc_inner_phases(parent TEXT NOT NULL,inner_id TEXT NOT NULL,phase TEXT NOT NULL,state TEXT NOT NULL,result TEXT,PRIMARY KEY(parent,inner_id,phase));
    `);
  }
  register(value: ExecutionIntent, manifest: string[]): void {
    const intent = validateIntent(value);
    if (intent.parentExecutionId || intent.capability !== 'ptc')
      throw new Error('Expected outer PTC intent');
    if (
      manifest.length > 256 ||
      new Set(manifest).size !== manifest.length ||
      manifest.some(
        (name) => !/^[a-z][a-z0-9_]*$/.test(name) || ['ptc', 'ptc_docs', 'code'].includes(name),
      )
    )
      throw new Error('Invalid PTC manifest');
    const encoded = canonicalJson(intent, REQUEST_BYTES),
      names = canonicalJson(manifest, CONTROL_BYTES);
    this.db
      .transaction(() => {
        const old = this.db
          .query('SELECT intent,manifest FROM ptc_parents WHERE id=?')
          .get(intent.executionId) as { intent: string; manifest: string } | null;
        if (old) {
          if (old.intent !== encoded || old.manifest !== names)
            throw new Error('PTC parent conflict');
          return;
        }
        this.db
          .query('INSERT INTO ptc_parents(id,binding,intent,manifest) VALUES (?,?,?,?)')
          .run(intent.executionId, canonicalJson(intent.binding, CONTROL_BYTES), encoded, names);
      })
      .immediate();
  }
  parentIntent(binding: Binding, id: string): ExecutionIntent {
    return this.parent(binding, id).intent;
  }
  private parent(binding: Binding, id: string) {
    const row = this.db
      .query('SELECT intent,manifest,sealed FROM ptc_parents WHERE id=? AND binding=?')
      .get(id, canonicalJson(bindingSchema.parse(binding), CONTROL_BYTES)) as {
      intent: string;
      manifest: string;
      sealed: number;
    } | null;
    if (!row) throw new Error('Unknown PTC parent');
    return {
      intent: validateIntent(parseJson(row.intent, REQUEST_BYTES)),
      manifest: parseJson(row.manifest, CONTROL_BYTES) as string[],
      sealed: !!row.sealed,
    };
  }
  private row(binding: Binding, parentId: string, innerId: string): Row {
    this.parent(binding, parentId);
    const row = this.db
      .query('SELECT intent,state,result,delivered FROM ptc_inner WHERE parent=? AND inner_id=?')
      .get(parentId, innerId) as Row | null;
    if (!row) throw new Error('Unknown inner operation');
    return row;
  }
  private decode(row: Row): InnerOperation {
    return {
      intent: validateIntent(parseJson(row.intent, REQUEST_BYTES)),
      state: row.state,
      ...(row.result ? { result: terminalSchema.parse(parseJson(row.result, RESULT_BYTES)) } : {}),
      delivered: !!row.delivered,
    };
  }
  status(binding: Binding, parentId: string, innerId: string): InnerOperation {
    return this.decode(this.row(binding, parentId, innerId));
  }
  /** Bounded summary only; retrieve large arguments/results one at a time through status(). */
  list(
    binding: Binding,
    parentId: string,
  ): Array<{
    innerId: string;
    executionId: string;
    state: InnerOperation['state'];
    delivered: boolean;
  }> {
    this.parent(binding, parentId);
    return (
      this.db
        .query('SELECT inner_id,id,state,delivered FROM ptc_inner WHERE parent=? ORDER BY rowid')
        .all(parentId) as Array<{
        inner_id: string;
        id: string;
        state: InnerOperation['state'];
        delivered: number;
      }>
    ).map((row) => ({
      innerId: row.inner_id,
      executionId: row.id,
      state: row.state,
      delivered: !!row.delivered,
    }));
  }
  /** Stable identity is checked before sealed state so lost replies remain queryable. */
  accept(value: ExecutionIntent): { fresh: boolean; operation: InnerOperation } {
    const intent = validateIntent(value);
    if (!intent.parentExecutionId || !intent.innerOperationId)
      throw new Error('Missing inner identity');
    const encoded = canonicalJson(intent, REQUEST_BYTES);
    return this.db
      .transaction(() => {
        const parent = this.parent(intent.binding, intent.parentExecutionId!);
        for (const key of [
          'runId',
          'turnId',
          'toolCallId',
          'descriptorRevision',
          'policyRevision',
        ] as const)
          if (intent[key] !== parent.intent[key]) throw new Error('Inner parent identity mismatch');
        if (
          !parent.manifest.includes(intent.capability) ||
          intent.budgetMs > parent.intent.budgetMs
        )
          throw new Error('Inner manifest/budget mismatch');
        const old = this.db
          .query(
            'SELECT intent,state,result,delivered FROM ptc_inner WHERE id=? OR (parent=? AND inner_id=?)',
          )
          .get(
            intent.executionId,
            intent.parentExecutionId!,
            intent.innerOperationId!,
          ) as Row | null;
        if (old) {
          if (old.intent !== encoded) throw new Error('Inner operation ID conflict');
          return { fresh: false, operation: this.decode(old) };
        }
        if (parent.sealed) throw new Error('PTC parent sealed; never replay');
        const count = (
          this.db
            .query('SELECT count(*) AS n FROM ptc_inner WHERE parent=?')
            .get(intent.parentExecutionId!) as { n: number }
        ).n;
        if (count >= BUDGETS.internalCalls) throw new Error('Inner operation quota exceeded');
        this.db
          .query(
            "INSERT INTO ptc_inner(id,parent,inner_id,intent,state) VALUES (?,?,?,?,'accepted')",
          )
          .run(intent.executionId, intent.parentExecutionId!, intent.innerOperationId!, encoded);
        return {
          fresh: true,
          operation: this.status(
            intent.binding,
            intent.parentExecutionId!,
            intent.innerOperationId!,
          ),
        };
      })
      .immediate();
  }
  /** Called immediately before authorization/hooks/effects; one claim, never a retry. */
  claim(binding: Binding, parentId: string, innerId: string): void {
    this.db
      .transaction(() => {
        if (this.parent(binding, parentId).sealed) throw new Error('PTC parent sealed');
        const row = this.row(binding, parentId, innerId);
        if (row.state !== 'accepted') throw new Error('Inner operation already claimed');
        this.db
          .query("UPDATE ptc_inner SET state='running' WHERE parent=? AND inner_id=?")
          .run(parentId, innerId);
      })
      .immediate();
  }
  finish(binding: Binding, parentId: string, innerId: string, value: Terminal): Terminal {
    canonicalJson(value, RESULT_BYTES);
    const terminal = terminalSchema.parse(value);
    const encoded = canonicalJson(terminal, RESULT_BYTES);
    for (const artifact of terminal.artifacts)
      if (
        artifact.nodeId !== binding.nodeId ||
        artifact.workspaceId !== binding.workspaceId ||
        artifact.sessionId !== binding.sessionId
      )
        throw new Error('Inner artifact ownership mismatch');
    return this.db
      .transaction(() => {
        const row = this.row(binding, parentId, innerId);
        if (row.result) {
          if (row.result !== encoded) throw new Error('Inner result conflict');
          return terminal;
        }
        if (row.state !== 'running' && terminal.effect !== 'not_started')
          throw new Error('Unclaimed inner operation cannot have effects');
        this.db
          .query("UPDATE ptc_inner SET state='terminal',result=? WHERE parent=? AND inner_id=?")
          .run(encoded, parentId, innerId);
        return terminal;
      })
      .immediate();
  }
  /** Trusted status reconciliation after independent verification; not a worker result retry.
   * Retains the original unknown evidence and cannot reopen admission or restart a script.
   */
  reconcile(binding: Binding, parentId: string, innerId: string, value: Terminal): Terminal {
    canonicalJson(value, RESULT_BYTES);
    const evidence = terminalSchema.parse(value);
    return this.db
      .transaction(() => {
        const operation = this.status(binding, parentId, innerId);
        if (
          operation.result?.state !== 'unknown' ||
          evidence.state === 'unknown' ||
          evidence.state === 'rejected' ||
          evidence.effect === 'unknown'
        )
          throw new Error('Only verified evidence may refine an unknown inner operation');
        this.db
          .query('INSERT INTO ptc_inner_reconciliations(parent,inner_id,previous) VALUES (?,?,?)')
          .run(parentId, innerId, canonicalJson(operation.result, RESULT_BYTES));
        this.db
          .query(
            "UPDATE ptc_inner SET state='running',result=NULL,delivered=0 WHERE parent=? AND inner_id=?",
          )
          .run(parentId, innerId);
        return this.finish(binding, parentId, innerId, evidence);
      })
      .immediate();
  }
  /** Authenticated node final-argument receipt, not permission to run hooks here. */
  bindFinalArguments(intent: ExecutionIntent, args: unknown): void {
    const encoded = canonicalJson(args, REQUEST_BYTES);
    this.db
      .transaction(() => {
        if (!intent.parentExecutionId || !intent.innerOperationId)
          throw new Error('Missing inner identity');
        const operation = this.status(
          intent.binding,
          intent.parentExecutionId,
          intent.innerOperationId,
        );
        if (
          operation.state !== 'accepted' ||
          canonicalJson(operation.intent, REQUEST_BYTES) !== canonicalJson(intent, REQUEST_BYTES)
        )
          throw new Error('Final arguments already bound');
        this.db
          .query("INSERT INTO ptc_inner_phases VALUES (?,?, 'preflight','completed',?)")
          .run(intent.parentExecutionId, intent.innerOperationId, encoded);
      })
      .immediate();
  }
  /** Node-owned hook/broker phase evidence. A started phase can never be started again. */
  beginPhase(intent: ExecutionIntent, phase: 'preflight' | 'central' | 'post'): void {
    this.db
      .transaction(() => {
        if (!intent.parentExecutionId || !intent.innerOperationId)
          throw new Error('Missing phase identity');
        const operation = this.status(
          intent.binding,
          intent.parentExecutionId,
          intent.innerOperationId,
        );
        if (
          operation.state !== 'running' ||
          canonicalJson(operation.intent, REQUEST_BYTES) !== canonicalJson(intent, REQUEST_BYTES)
        )
          throw new Error('Inactive phase owner');
        if (this.parent(intent.binding, intent.parentExecutionId).sealed)
          throw new Error('Parent sealed');
        if (
          this.db
            .query('SELECT phase FROM ptc_inner_phases WHERE parent=? AND inner_id=? AND phase=?')
            .get(intent.parentExecutionId, intent.innerOperationId, phase)
        )
          throw new Error('Phase already started; reconcile original ID');
        this.db
          .query("INSERT INTO ptc_inner_phases VALUES (?,?,?,'running',NULL)")
          .run(intent.parentExecutionId, intent.innerOperationId, phase);
      })
      .immediate();
  }
  finishPhase(
    intent: ExecutionIntent,
    phase: 'preflight' | 'central' | 'post',
    result: unknown,
  ): void {
    const encoded = canonicalJson(result, RESULT_BYTES);
    const row = this.phase(intent, phase);
    if (row.state === 'completed') {
      if (canonicalJson(row.result, RESULT_BYTES) !== encoded)
        throw new Error('Phase result conflict');
      return;
    }
    this.db
      .query(
        "UPDATE ptc_inner_phases SET state='completed',result=? WHERE parent=? AND inner_id=? AND phase=?",
      )
      .run(encoded, intent.parentExecutionId!, intent.innerOperationId!, phase);
  }
  phase(
    intent: ExecutionIntent,
    phase: 'preflight' | 'central' | 'post',
  ): { state: string; result: unknown } {
    if (!intent.parentExecutionId || !intent.innerOperationId)
      throw new Error('Missing phase identity');
    const operation = this.status(
      intent.binding,
      intent.parentExecutionId,
      intent.innerOperationId,
    );
    if (canonicalJson(operation.intent, REQUEST_BYTES) !== canonicalJson(intent, REQUEST_BYTES))
      throw new Error('Phase owner conflict');
    const row = this.db
      .query('SELECT state,result FROM ptc_inner_phases WHERE parent=? AND inner_id=? AND phase=?')
      .get(intent.parentExecutionId, intent.innerOperationId, phase) as {
      state: string;
      result: string | null;
    } | null;
    if (!row) throw new Error('Phase not started');
    return {
      state: row.state,
      result: row.result === null ? null : parseJson(row.result, RESULT_BYTES),
    };
  }
  /** DB-covered mutation/result commit atomically; never pass async or external effects here. */
  transact(
    binding: Binding,
    parentId: string,
    innerId: string,
    mutate: (db: Database) => Terminal,
  ): Terminal {
    return this.db
      .transaction(() => {
        const operation = this.status(binding, parentId, innerId);
        if (operation.result) return operation.result;
        this.claim(binding, parentId, innerId);
        return this.finish(binding, parentId, innerId, mutate(this.db));
      })
      .immediate();
  }
  delivered(binding: Binding, parentId: string, innerId: string, resultDigest: string): void {
    const row = this.row(binding, parentId, innerId);
    if (!row.result || digest(parseJson(row.result, RESULT_BYTES), RESULT_BYTES) !== resultDigest)
      throw new Error('Inner delivery digest mismatch');
    this.db
      .query('UPDATE ptc_inner SET delivered=1 WHERE parent=? AND inner_id=?')
      .run(parentId, innerId);
  }
  /** Only after the prior guest/executor is fenced. Does not restore a stack or dispatch effects. */
  seal(binding: Binding, parentId: string): void {
    this.db
      .transaction(() => {
        this.parent(binding, parentId);
        this.db.query('UPDATE ptc_parents SET sealed=1 WHERE id=?').run(parentId);
        for (const operation of this.list(binding, parentId)) {
          if (operation.state === 'terminal') continue;
          const started = operation.state === 'running';
          this.finish(binding, parentId, operation.innerId, {
            state: started ? 'unknown' : 'failed',
            effect: started ? 'unknown' : 'not_started',
            artifacts: [],
            truncated: false,
            error: {
              code: 'unknown',
              message: 'PTC guest stopped; reconcile this inner ID, never replay the script',
            },
          });
        }
      })
      .immediate();
  }
}
