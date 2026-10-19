/**
 * Read-only baseline of approval requests (interactions) in delegated vs
 * ordinary sessions. Both databases are opened with `{ readonly: true }`;
 * nothing is ever written.
 *
 * Usage: bun scripts/approval-stats.ts --gateway-db <path> --node-db [nodeId=]<path>...
 *        [--since <ISO date>] [--top <n>] [--json]
 *
 * Both default to `<state dir>/gateway.sqlite` (or `PIRC_DATABASE_PATH`). A node
 * session is delegated iff the gateway session with its node_id and
 * pi_session_id = the node session id is some delegation's target. Without
 * `nodeId=`, a node DB matches on the session id alone.
 */
import { Database } from 'bun:sqlite';

export type Scope = 'delegated' | 'ordinary';
export type Outcome = 'approved' | 'declined' | 'unanswered';
export type Category =
  | 'auto_mode'
  | 'auto_mode_deny_list'
  | 'read_only'
  | 'sandbox_allow_domains'
  | 'unsandboxed_bash'
  | `other_${string}`;
export type Item = {
  scope: Scope;
  category: Category;
  outcome: Outcome;
  hosts: string[];
  head?: string;
  reason?: string;
};
type Interaction = {
  session_id: string;
  kind: string;
  status: string;
  request_json: string;
  answer_json: string | null;
};
export type Report = {
  readOnly: true;
  since: string | null;
  /** Whether a prompt came from auto mode's rules or model verdict is not recorded. */
  source: 'unrecorded';
  counts: Record<Scope, Record<string, Record<Outcome, number>>>;
  topHosts: Record<Scope, Array<[string, number]>>;
  topCommandHeads: Record<Scope, Array<[string, number]>>;
  topReasons: Record<Scope, Array<[string, number]>>;
};

const titles: Record<string, Category> = {
  'Auto mode: allow a potentially dangerous action?': 'auto_mode',
  'Read-only mode: allow this action?': 'read_only',
  'Allow network access?': 'sandbox_allow_domains',
  'Run a command outside the sandbox?': 'unsandboxed_bash',
};

function parse(text: string | null): Record<string, unknown> {
  try {
    const value = text ? JSON.parse(text) : null;
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/** `answered` + `{confirmed: true}` (or a value, for other kinds) is approved; `{confirmed: false}` or `{cancelled: true}` is declined. */
export function outcome(status: string, answer: Record<string, unknown>): Outcome {
  if (status !== 'answered') return 'unanswered';
  if (answer.cancelled === true || answer.confirmed === false) return 'declined';
  return answer.confirmed === true || typeof answer.value === 'string' ? 'approved' : 'declined';
}

export function classify(row: Interaction, scope: Scope): Item {
  const request = parse(row.request_json);
  const title = typeof request.title === 'string' ? request.title : '';
  const message = typeof request.message === 'string' ? request.message : '';
  let category: Category = (row.kind === 'confirm' && titles[title]) || `other_${row.kind}`;
  const item: Item = {
    scope,
    category,
    outcome: outcome(row.status, parse(row.answer_json)),
    hosts: [],
  };
  if (category === 'auto_mode' || category === 'read_only') {
    const reason = /\n\nReason: ([\s\S]*)$/.exec(message)?.[1]?.trim();
    if (reason) item.reason = reason;
    if (category === 'auto_mode' && reason?.includes('matches the deny-list pattern'))
      item.category = 'auto_mode_deny_list';
  } else if (category === 'sandbox_allow_domains') {
    const hosts = /The agent asks to reach (.*) from its sandbox\./.exec(message)?.[1];
    item.hosts = hosts ? hosts.split(', ').filter(Boolean) : [];
  } else if (category === 'unsandboxed_bash') {
    const line = message.split('\n').find((l) => l.startsWith('$ '));
    item.head = line?.slice(2).trim().split(/\s+/)[0] || '(none)';
  }
  return item;
}

/** `(node_id, pi_session_id)` of every delegation target, as `nodeId\0sessionId`. */
export function delegatedTargets(gateway: Database): Set<string> {
  const rows = gateway
    .query(
      `SELECT s.node_id, s.pi_session_id FROM delegations d JOIN sessions s ON s.id = d.target_session_id
       WHERE s.pi_session_id IS NOT NULL`,
    )
    .all() as Array<{ node_id: string | null; pi_session_id: string }>;
  const set = new Set<string>();
  for (const row of rows) {
    set.add(`${row.node_id ?? ''}\0${row.pi_session_id}`);
    set.add(`*\0${row.pi_session_id}`);
  }
  return set;
}

export function collect(
  node: Database,
  nodeId: string | null,
  targets: Set<string>,
  sinceMs: number | null,
): Item[] {
  const rows = node
    .query(
      `SELECT session_id, kind, status, request_json, answer_json FROM interactions
       WHERE created_at >= ?1 ORDER BY created_at`,
    )
    .all(sinceMs ?? 0) as Interaction[];
  return rows.map((row) =>
    classify(row, targets.has(`${nodeId ?? '*'}\0${row.session_id}`) ? 'delegated' : 'ordinary'),
  );
}

function top(values: string[], n: number): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}

export function report(items: Item[], since: string | null, n = 10): Report {
  const scopes: Scope[] = ['delegated', 'ordinary'];
  const by = <T>(f: (scope: Scope) => T) =>
    Object.fromEntries(scopes.map((s) => [s, f(s)])) as Record<Scope, T>;
  const of = (scope: Scope) => items.filter((item) => item.scope === scope);
  return {
    readOnly: true,
    since,
    source: 'unrecorded',
    counts: by((scope) => {
      const counts: Record<string, Record<Outcome, number>> = {};
      for (const item of of(scope))
        (counts[item.category] ??= { approved: 0, declined: 0, unanswered: 0 })[item.outcome]++;
      return counts;
    }),
    topHosts: by((scope) =>
      top(
        of(scope).flatMap((item) => item.hosts),
        n,
      ),
    ),
    topCommandHeads: by((scope) =>
      top(
        of(scope).flatMap((item) => item.head ?? []),
        n,
      ),
    ),
    topReasons: by((scope) =>
      top(
        of(scope).flatMap((item) => item.reason ?? []),
        n,
      ),
    ),
  };
}

export function format(result: Report): string {
  const lines = [
    `approval-stats (read-only; databases opened readonly)${result.since ? `, since ${result.since}` : ''}`,
    'auto mode source (rules vs model verdict): unrecorded',
  ];
  for (const scope of ['delegated', 'ordinary'] as const) {
    lines.push('', `[${scope}]`, '  category                 approved declined unanswered');
    for (const [category, c] of Object.entries(result.counts[scope]).sort())
      lines.push(
        `  ${category.padEnd(24)} ${String(c.approved).padStart(8)} ${String(c.declined).padStart(8)} ${String(c.unanswered).padStart(10)}`,
      );
    for (const [label, entries] of [
      ['top hosts', result.topHosts[scope]],
      ['top command heads', result.topCommandHeads[scope]],
      ['top reasons', result.topReasons[scope]],
    ] as const) {
      if (!entries.length) continue;
      lines.push(`  ${label}:`);
      for (const [value, count] of entries)
        lines.push(`    ${String(count).padStart(5)}  ${value.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  }
  return lines.join('\n');
}

export function parseArgs(argv: string[]) {
  const nodes: Array<{ nodeId: string | null; path: string }> = [];
  let gateway: string | undefined,
    since: string | null = null,
    json = false,
    n = 10;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--json') json = true;
    else if (arg === '--gateway-db') gateway = value();
    else if (arg === '--since') since = value();
    else if (arg === '--top') n = Number(value());
    else if (arg === '--node-db') {
      const spec = value();
      const match = /^([^=/\\]+)=(.+)$/.exec(spec);
      nodes.push(match ? { nodeId: match[1]!, path: match[2]! } : { nodeId: null, path: spec });
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!gateway || !nodes.length)
    throw new Error(
      'Usage: bun scripts/approval-stats.ts --gateway-db <path> --node-db [nodeId=]<path>... [--since <ISO date>] [--top <n>] [--json]',
    );
  if (since !== null && Number.isNaN(Date.parse(since)))
    throw new Error(`Invalid --since: ${since}`);
  if (!Number.isInteger(n) || n < 1) throw new Error('--top must be a positive integer');
  return { nodes, gateway, since, json, n };
}

export function run(argv: string[]): string {
  const args = parseArgs(argv);
  const open = (file: string) => new Database(file, { readonly: true });
  const gateway = open(args.gateway);
  const items: Item[] = [];
  try {
    const targets = delegatedTargets(gateway);
    const sinceMs = args.since === null ? null : Date.parse(args.since);
    for (const { nodeId, path } of args.nodes) {
      const node = open(path);
      try {
        items.push(...collect(node, nodeId, targets, sinceMs));
      } finally {
        node.close();
      }
    }
  } finally {
    gateway.close();
  }
  const result = report(items, args.since, args.n);
  return args.json ? JSON.stringify(result, null, 2) : format(result);
}

if (import.meta.main) {
  try {
    console.log(run(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
