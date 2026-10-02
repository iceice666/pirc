/**
 * Static checks for `code` (PTC) scripts. The script runs in a Bun child
 * process with the agent's permissions; only its `tools.<name>()` calls go
 * back through the agent (and auto mode, one by one). Anything else it does —
 * spawning processes, touching the file system, the network — bypasses those
 * checks, so:
 *
 * - a script that uses process or file-writing APIs is `danger` (a human must
 *   approve it; headless agents are refused): it should call `tools.bash` /
 *   `tools.write` instead, which are checked;
 * - a script that reaches for any other runtime capability (or could reach it
 *   indirectly) is `unknown`, judged by the model with the script shown;
 * - a script that only computes and calls `tools.*` is `read`: it needs no
 *   lease, its tool calls are gated individually.
 *
 * The scan is textual and errs towards `unknown`. The worker also removes the
 * Function constructors (see `ptc/worker.ts`), so a capability cannot be
 * reached through a computed property name such as `x['constr' + 'uctor']`.
 */
import { denyMatch, type Classification } from './rules.js';

/** Process spawning and file-system writes: these bypass every agent-side check. */
const DIRECT_EFFECTS: Array<[RegExp, string]> = [
  [/\bBun\s*\.\s*\$|(?:^|[^\w.])\$\s*`/, 'runs shell commands with Bun.$'],
  // Not `.exec(`: RegExp#exec is everywhere; module imports are caught below.
  [
    /(?<![\w$.])(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/,
    'spawns processes',
  ],
  [
    /child_process|bun:ffi|\bdlopen\b|node:worker_threads|node:vm\b|node:cluster/,
    'loads process or native-code modules',
  ],
  [
    /\b(?:writeFile|appendFile|createWriteStream|unlink|symlink|copyFile|chmod|chown|lchown|lutimes)\w*\s*\(|\b(?:rm|rmdir|rename|cp|link|truncate|mkdir|mkdtemp|utimes|open|write)Sync\s*\(/,
    'changes files directly',
  ],
  [
    /\bBun\s*\.\s*(?:write|spawn|spawnSync)\b|\.writer\s*\(/,
    'writes files or spawns processes with Bun APIs',
  ],
];

/**
 * Runtime capabilities beyond `tools.*`, and ways to reach them indirectly
 * (globals, dynamic code, module loading, escapes in identifiers).
 */
const CAPABILITIES =
  /\b(?:Bun|process|require|import|eval|Function|constructor|globalThis|global|self|window|Reflect|fetch|WebSocket|XMLHttpRequest|EventSource|Worker|SharedWorker|Deno|__proto__|prototype|setPrototypeOf|getPrototypeOf|defineProperty|navigator|Atomics|WebAssembly)\b|\\u|\\x/;

export function classifyScript(code: string, deny: readonly RegExp[] = []): Classification {
  const listed = denyMatch(code, deny);
  if (listed)
    return {
      ...listed,
      reason: `the script contains text that ${listed.reason.replace(/^the command /, '')}`,
    };
  for (const [pattern, what] of DIRECT_EFFECTS)
    if (pattern.test(code))
      return {
        verdict: 'danger',
        reason: `the script ${what}, bypassing the agent's checks (use tools.bash / tools.write instead)`,
      };
  const capability = CAPABILITIES.exec(code);
  if (capability)
    return {
      verdict: 'unknown',
      reason: `the script uses ${capability[0]}, which runs outside the agent's tool checks`,
    };
  return {
    verdict: 'read',
    reason: 'the script only computes and calls tools, which are checked one by one',
  };
}
