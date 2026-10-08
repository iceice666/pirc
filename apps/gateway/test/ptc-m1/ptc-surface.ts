/**
 * M4 oracle mapping for the PTC-only surface (docs/evaluations/ptc/ptc-m4-evaluation.md, decided 2026-10-06):
 * a script's nested operations are judged exactly like the direct calls the M1 oracles judged,
 * and the outer `ptc`/`ptc_docs` calls are neutral. Content stays in memory; only fixed counts
 * leave this module.
 */
import { parse, type Node } from 'acorn';

export const PTC_ORACLE_MAPPING = 'ptc-nested-operations-v1';
const SURFACE = new Set(['ptc', 'ptc_docs']);

/** An outer model-facing `ptc`/`ptc_docs` call event (never a nested operation). */
export function isSurfaceEvent(event: Record<string, any>): boolean {
  return (
    typeof event.type === 'string' &&
    event.type.startsWith('tool_execution_') &&
    SURFACE.has(event.toolName) &&
    !event.parentToolCallId
  );
}

type AnyNode = Node & Record<string, any>;
const isNode = (value: unknown): value is AnyNode =>
  !!value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string';
const NOT_LITERAL = Symbol('not literal');

/** The value of a node built only from literals; NOT_LITERAL otherwise. */
function literal(node: AnyNode): unknown {
  switch (node.type) {
    case 'Literal':
      return node.regex ? NOT_LITERAL : node.value;
    case 'TemplateLiteral':
      return node.expressions.length === 0 && node.quasis.length === 1
        ? (node.quasis[0].value.cooked ?? NOT_LITERAL)
        : NOT_LITERAL;
    case 'UnaryExpression':
      if (node.operator === '-' && node.argument.type === 'Literal') {
        const value = literal(node.argument);
        return typeof value === 'number' ? -value : NOT_LITERAL;
      }
      return NOT_LITERAL;
    case 'ArrayExpression': {
      const items: unknown[] = [];
      for (const item of node.elements) {
        if (!isNode(item)) return NOT_LITERAL;
        const value = literal(item);
        if (value === NOT_LITERAL) return NOT_LITERAL;
        items.push(value);
      }
      return items;
    }
    case 'ObjectExpression': {
      const record: Record<string, unknown> = Object.create(null);
      for (const property of node.properties) {
        if (property.type !== 'Property' || property.computed || property.kind !== 'init')
          return NOT_LITERAL;
        const key =
          property.key.type === 'Identifier'
            ? property.key.name
            : typeof property.key.value === 'string' || typeof property.key.value === 'number'
              ? String(property.key.value)
              : undefined;
        if (key === undefined) return NOT_LITERAL;
        const value = literal(property.value);
        if (value === NOT_LITERAL) return NOT_LITERAL;
        record[key] = value;
      }
      return record;
    }
    default:
      return NOT_LITERAL;
  }
}

export interface StaticOperation {
  name: string;
  /** Arguments when written entirely as literals; null when computed at run time. */
  args: Record<string, unknown> | null;
}

/**
 * Capability calls a script makes, with their arguments when they are literals:
 * `tools.<name>(…)` and `tools.call("<name>", …)`, like the production preflight. A script that
 * does not parse yields `null` (the agent itself refuses it before anything runs).
 */
export function scriptOperations(code: unknown): StaticOperation[] | null {
  if (typeof code !== 'string' || !code.trim()) return null;
  let program: AnyNode;
  try {
    const js = new Bun.Transpiler({ loader: 'ts', target: 'browser' }).transformSync(
      `async function __ptc_main() {\n${code}\n}`,
    );
    program = parse(js, { ecmaVersion: 'latest', sourceType: 'script' }) as AnyNode;
  } catch {
    return null;
  }
  const found: StaticOperation[] = [];
  const argsOf = (node: AnyNode | undefined): Record<string, unknown> | null => {
    if (!node) return Object.create(null);
    const value = literal(node);
    return value !== NOT_LITERAL && value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  };
  const member = (node: AnyNode | undefined): string | undefined =>
    node?.type === 'MemberExpression' &&
    !node.computed &&
    node.object.type === 'Identifier' &&
    node.object.name === 'tools' &&
    node.property.type === 'Identifier'
      ? (node.property.name as string)
      : undefined;
  const visit = (node: AnyNode): void => {
    const called = node.type === 'CallExpression' ? member(node.callee) : undefined;
    if (called === 'call') {
      const first = node.arguments[0];
      const name = isNode(first) ? literal(first) : NOT_LITERAL;
      if (typeof name === 'string') found.push({ name, args: argsOf(node.arguments[1]) });
    } else if (called !== undefined && called !== 'par')
      found.push({ name: called, args: argsOf(node.arguments[0]) });
    else {
      // A capability referenced but not called here (e.g. aliased): its arguments are unknown.
      const referenced = member(node);
      if (referenced !== undefined && referenced !== 'call' && referenced !== 'par')
        found.push({ name: referenced, args: null });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
      // The callee of a call recorded above is not a separate reference.
      if (called !== undefined && key === 'callee') continue;
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visit(item);
      } else if (isNode(value)) visit(value);
    }
  };
  visit(program);
  return found;
}

/** Operations a completed `ptc` result reports (capability and outcome only). */
export function reportedOperations(
  details: unknown,
): Array<{ capability: string; outcome: string }> | null {
  const operations = (details as { operations?: unknown } | null | undefined)?.operations;
  if (!Array.isArray(operations)) return null;
  return operations.flatMap((item) =>
    item && typeof item.capability === 'string' && typeof item.outcome === 'string'
      ? [{ capability: item.capability, outcome: item.outcome }]
      : [],
  );
}

/** Fixed capability buckets for diagnostics (names only; anything else is `other`). */
export const OPERATION_BUCKETS = [
  'read',
  'write',
  'edit',
  'ls',
  'grep',
  'find',
  'bash',
  'unsandboxed_bash',
  'background_task',
  'ask_user_question',
  'web_search',
  'web_fetch',
  'browser',
  'schedule',
  'team',
  'planning',
] as const;
type OperationBucket = (typeof OPERATION_BUCKETS)[number] | 'other';
function operationBucket(name: unknown): OperationBucket {
  if (typeof name !== 'string') return 'other';
  if ((OPERATION_BUCKETS as readonly string[]).includes(name)) return name as OperationBucket;
  if (name.startsWith('browser_')) return 'browser';
  if (/^(agent_|board_|task_)|^subagent$/.test(name)) return 'team';
  if (['todo', 'get_goal', 'create_goal', 'update_goal'].includes(name)) return 'planning';
  return 'other';
}

/** Fixed per-trial counts of the PTC surface; all zero for a direct-call binary. */
export class PtcStats {
  private calls = 0;
  private scriptErrors = 0;
  private docsCalls = 0;
  private docsBytes = 0;
  private operations = 0;
  private operationErrors = 0;
  /** Operations a script attempted that never started (refused mid-script, no nested event). */
  private notStarted = 0;
  private perCall = new Map<string, number>();
  /** Hybrid surface: top-level (direct) capability calls by bucket. */
  private direct = Object.fromEntries(
    [...OPERATION_BUCKETS, 'other'].map((name) => [name, 0]),
  ) as Record<OperationBucket, number>;
  private byCapability = Object.fromEntries(
    [...OPERATION_BUCKETS, 'other'].map((name) => [name, 0]),
  ) as Record<OperationBucket, number>;

  observe(event: Record<string, any>): void {
    if (
      event.type === 'tool_execution_start' &&
      isSurfaceEvent(event) &&
      event.toolName === 'ptc'
    ) {
      this.calls++;
      this.perCall.set(event.toolCallId, 0);
    }
    if (event.type === 'tool_execution_start' && !event.parentToolCallId && !isSurfaceEvent(event))
      this.direct[operationBucket(event.toolName)]++;
    if (event.type === 'tool_execution_start' && event.parentToolCallId) {
      this.operations++;
      this.byCapability[operationBucket(event.toolName)]++;
      this.perCall.set(event.parentToolCallId, (this.perCall.get(event.parentToolCallId) ?? 0) + 1);
    }
    if (event.type !== 'tool_execution_end') return;
    if (event.parentToolCallId) {
      if (event.isError) this.operationErrors++;
    } else if (event.toolName === 'ptc') {
      if (event.isError) this.scriptErrors++;
      const refused = event.result?.details?.summary?.notStarted;
      if (Number.isSafeInteger(refused) && refused > 0) this.notStarted += refused;
    } else if (event.toolName === 'ptc_docs') {
      this.docsCalls++;
      this.docsBytes += Buffer.byteLength(JSON.stringify(event.result ?? null));
    }
  }

  summary() {
    return {
      mapping: PTC_ORACLE_MAPPING,
      ptcCalls: this.calls,
      scriptErrors: this.scriptErrors,
      docsCalls: this.docsCalls,
      docsBytes: this.docsBytes,
      operations: this.operations,
      operationErrors: this.operationErrors,
      notStartedOperations: this.notStarted,
      /** Started operations by fixed capability bucket (diagnostic; names only). */
      operationsByCapability: { ...this.byCapability },
      /** Direct (non-script) capability calls by bucket: the hybrid surface's other route. */
      directCallsByCapability: { ...this.direct },
      maxOperationsPerCall: Math.max(0, ...this.perCall.values()),
      /** Operations started by each script, ascending (counts only, for the fan-out distribution). */
      operationsPerCall: [...this.perCall.values()].sort((a, b) => a - b),
    };
  }
}
