/**
 * Pre-evaluation check (docs/evaluations/ptc/ptc-only.md §3): strip TypeScript, parse the
 * script and derive the capabilities it may call. Capability names must be
 * literals — `tools.read(…)` or `tools.call("read", …)`. Computed names,
 * aliases of `tools`/`tools.call` and redeclaring `tools` are rejected before
 * anything runs. The runtime separately refuses dispatch outside this
 * manifest, so the check is a fail-closed display aid, not authorization.
 */
import { parse, type Node } from 'acorn';
import { BUDGETS, PtcError } from './contracts.js';

const MAIN = '__ptc_main';

export interface PreflightResult {
  /** JavaScript defining `async function __ptc_main()`. */
  js: string;
  /** Capability names in first-use order. */
  manifest: string[];
}

type AnyNode = Node & Record<string, unknown>;

const isNode = (value: unknown): value is AnyNode =>
  !!value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string';

function literalString(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (
    node.type === 'TemplateLiteral' &&
    (node.expressions as unknown[]).length === 0 &&
    (node.quasis as AnyNode[]).length === 1
  ) {
    const cooked = ((node.quasis as AnyNode[])[0]!.value as { cooked?: unknown }).cooked;
    return typeof cooked === 'string' ? cooked : undefined;
  }
  return undefined;
}

function lineOf(js: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < js.length; i++) if (js.charCodeAt(i) === 10) line++;
  // The wrapper adds one line before the script body.
  return Math.max(1, line - 1);
}

export function preflight(source: string): PreflightResult {
  if (typeof source !== 'string' || !source.trim())
    throw new PtcError('InvalidArguments', 'code must be a non-empty string');
  if (Buffer.byteLength(source) > BUDGETS.sourceBytes)
    throw new PtcError(
      'QuotaExceeded',
      `code exceeds ${BUDGETS.sourceBytes} bytes; split the work across ptc calls`,
    );
  let js: string;
  try {
    js = new Bun.Transpiler({ loader: 'ts', target: 'browser' }).transformSync(
      `async function ${MAIN}() {\n${source}\n}`,
    );
  } catch (error) {
    throw new PtcError('InvalidArguments', `Syntax error: ${(error as Error).message}`);
  }
  let program: AnyNode;
  try {
    program = parse(js, { ecmaVersion: 'latest', sourceType: 'script' }) as unknown as AnyNode;
  } catch (error) {
    throw new PtcError('InvalidArguments', `Syntax error: ${(error as Error).message}`);
  }
  const body = program.body as AnyNode[];
  const main = body[0];
  if (
    body.length !== 1 ||
    main?.type !== 'FunctionDeclaration' ||
    (main.id as AnyNode | null)?.name !== MAIN ||
    main.async !== true
  )
    throw new PtcError(
      'InvalidArguments',
      'code must be the body of one async function; unbalanced braces end it early',
    );

  const manifest: string[] = [];
  const problems: string[] = [];
  const add = (name: string) => {
    if (!manifest.includes(name)) manifest.push(name);
  };
  const reject = (node: AnyNode, why: string) => {
    if (problems.length < 8) problems.push(`line ${lineOf(js, node.start)}: ${why}`);
  };

  /** Whether an identifier in this position is a name, not a variable reference. */
  const notReference = (parent: AnyNode | undefined, key: string): boolean => {
    if (!parent) return false;
    switch (parent.type) {
      case 'MemberExpression':
        return key === 'property' && parent.computed !== true;
      case 'Property':
        return key === 'key' && parent.computed !== true && parent.shorthand !== true;
      case 'MethodDefinition':
      case 'PropertyDefinition':
        return key === 'key' && parent.computed !== true;
      case 'LabeledStatement':
      case 'BreakStatement':
      case 'ContinueStatement':
        return key === 'label';
      case 'MetaProperty':
        return true;
      default:
        return false;
    }
  };

  const visit = (node: AnyNode, parents: Array<{ node: AnyNode; key: string }>): void => {
    if (node.type === 'Identifier' && node.name === 'tools') {
      const up = parents.at(-1);
      if (notReference(up?.node, up?.key ?? '')) return;
      const member = up?.node;
      if (member?.type !== 'MemberExpression' || up!.key !== 'object') {
        reject(node, '`tools` must be used directly as tools.<name>(…) or tools.call("<name>", …)');
        return;
      }
      if (member.computed === true) {
        const literal = literalString(member.property);
        reject(
          node,
          literal !== undefined
            ? `write tools.${literal}(…) instead of tools[…]`
            : 'computed capability names (tools[…]) are not allowed; use a literal name',
        );
        return;
      }
      const property = (member.property as AnyNode).name as string;
      if (property === 'par') return;
      if (property === 'call') {
        // The member may sit inside an optional chain: tools.call?.("read").
        const callUp = parents.at(-2);
        const call = callUp?.node;
        if (call?.type !== 'CallExpression' || callUp!.key !== 'callee') {
          reject(node, 'tools.call must be called directly, not stored or passed around');
          return;
        }
        const name = literalString((call.arguments as AnyNode[])[0]);
        if (name === undefined) {
          reject(node, 'tools.call needs a string literal capability name as its first argument');
          return;
        }
        add(name);
        return;
      }
      add(property);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
      const next = [...parents, { node, key }];
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visit(item, next);
      } else if (isNode(value)) visit(value, next);
    }
  };
  visit(program, []);
  if (problems.length)
    throw new PtcError(
      'InvalidArguments',
      `Capability names must be literals:\n${problems.join('\n')}`,
    );
  return { js, manifest };
}
