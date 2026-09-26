import { parseArgs } from 'node:util';
import { Agent } from './agent.js';
import { loadAgentConfig } from './config.js';
import { builtinFeatures } from './features/index.js';
import { teamChildMode } from './features/team/channel.js';
import { TEAM_TOOL_NAMES } from './features/team/index.js';
import { RpcUi, serveRpc } from './rpc.js';
import { SessionStore } from './session-store.js';
import { builtinTools } from './tools/index.js';

/**
 * `pirc agent --session-dir DIR` — one session, JSONL RPC on stdin/stdout.
 * Pi-compatible flags `--mode rpc` and `--continue` are accepted and ignored
 * (sessions always resume from their directory).
 */
export async function runAgent(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'session-dir': { type: 'string' },
      mode: { type: 'string' },
      continue: { type: 'boolean' },
      model: { type: 'string' },
      thinking: { type: 'string' },
      name: { type: 'string' },
      headless: { type: 'boolean' },
      tools: { type: 'string' },
    },
    strict: false,
  });
  // Tool allowlist (team kinds); team members always keep their coordination tools.
  const allowedTools =
    typeof values.tools === 'string'
      ? [
          ...values.tools.split(',').filter(Boolean),
          ...(teamChildMode() === 'team' ? TEAM_TOOL_NAMES : []),
        ]
      : undefined;
  const sessionDir = values['session-dir'] ?? process.env.PI_CODING_AGENT_SESSION_DIR;
  if (typeof sessionDir !== 'string' || !sessionDir) throw new Error('--session-dir is required');
  const cwd = process.cwd();
  const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const ui = new RpcUi(write);
  const config = loadAgentConfig(cwd);
  const store = new SessionStore(sessionDir, cwd);
  const agent = new Agent({
    config,
    store,
    emit: write,
    ui,
    hasUI: !values.headless,
    tools: builtinTools(),
    features: builtinFeatures(),
    ...(allowedTools ? { allowedTools } : {}),
  });
  if (typeof values.model === 'string' && values.model.includes('/')) {
    const [provider, ...id] = values.model.split('/');
    agent.setModel(provider!, id.join('/'));
  }
  if (typeof values.thinking === 'string') agent.setThinking(values.thinking);
  if (typeof values.name === 'string' && !agent.sessionName) agent.setName(values.name);
  await agent.init();
  const shutdown = async () => {
    ui.cancelAll();
    await agent.shutdown();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  await serveRpc(agent, ui, write);
  await shutdown();
}
