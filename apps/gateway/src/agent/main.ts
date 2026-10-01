import { parseArgs } from 'node:util';
import { Agent } from './agent.js';
import type { AgentRole } from './roles.js';
import { capabilities, type Capabilities } from './capabilities.js';
import { loadAgentConfig } from './config.js';
import { modelsSchema, type ModelsConfig } from '../models.js';
import { builtinFeatures } from './features/index.js';
import { teamChildMode } from './features/team/channel.js';
import { TEAM_TOOL_NAMES } from './features/team/index.js';
import { RpcUi, serveRpc, stdinLines } from './rpc.js';
import { SessionStore } from './session-store.js';
import { builtinTools } from './tools/index.js';
import { nodeGateway } from './gateway.js';
import { nodeBrowser } from './browser-channel.js';
import { nodeSandboxChannel } from './sandbox-channel.js';
import { nodeWriteBroker, processWriteLease } from './write-lease.js';

/**
 * The first stdin line must be `{"type":"configure","models":{…}}`: the
 * public model catalog and local inference transport supplied by the node.
 * Provider credentials remain on the gateway.
 */
async function readConfigure(lines: AsyncIterator<string>): Promise<{
  models: ModelsConfig;
  capabilities: Capabilities;
  instructions?: string;
  role?: AgentRole;
}> {
  for (;;) {
    const next = await lines.next();
    if (next.done) throw new Error('stdin closed before the configure message');
    if (!next.value.trim()) continue;
    let message: unknown;
    try {
      message = JSON.parse(next.value);
    } catch {
      throw new Error('The first stdin line must be a JSON configure message');
    }
    const record = message as {
      type?: unknown;
      models?: unknown;
      capabilities?: unknown;
      instructions?: unknown;
      role?: { name?: unknown; instructions?: unknown; models?: unknown } | null;
    } | null;
    if (record?.type !== 'configure')
      throw new Error('The first stdin line must be {"type":"configure","models":…}');
    return {
      models: modelsSchema.parse(record.models ?? {}),
      capabilities: capabilities(record.capabilities),
      ...(typeof record.instructions === 'string' ? { instructions: record.instructions } : {}),
      ...(typeof record.role?.name === 'string'
        ? {
            role: {
              name: record.role.name,
              ...(typeof record.role.instructions === 'string'
                ? { instructions: record.role.instructions }
                : {}),
              ...(Array.isArray(record.role.models)
                ? {
                    models: record.role.models.filter(
                      (item): item is string => typeof item === 'string',
                    ),
                  }
                : {}),
            },
          }
        : {}),
    };
  }
}

/**
 * `pirc-node agent --session-dir DIR` — one session, JSONL RPC on stdin/stdout.
 * The legacy flags `--mode rpc` and `--continue` are accepted and ignored
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
  const lines = stdinLines();
  const configured = await readConfigure(lines);
  const config = loadAgentConfig(cwd, configured.models);
  const store = new SessionStore(sessionDir, cwd);
  const agent = new Agent({
    config,
    capabilities: configured.capabilities,
    ...(configured.instructions ? { projectInstructions: configured.instructions } : {}),
    ...(configured.role ? { role: configured.role } : {}),
    store,
    emit: write,
    ui,
    hasUI: !values.headless,
    tools: builtinTools(),
    features: builtinFeatures(),
    acquireWrite: processWriteLease(),
    ...(allowedTools ? { allowedTools } : {}),
  });
  await agent.refreshModels();
  if (typeof values.model === 'string' && values.model.includes('/')) {
    const [provider, ...id] = values.model.split('/');
    agent.setModel(provider!, id.join('/'));
  }
  if (typeof values.thinking === 'string') agent.setThinking(values.thinking);
  if (typeof values.name === 'string' && !agent.sessionName) agent.setName(values.name);
  await agent.init();
  const shutdown = async () => {
    ui.cancelAll();
    nodeWriteBroker().closeAll();
    nodeGateway().closeAll();
    nodeBrowser().closeAll();
    nodeSandboxChannel().closeAll();
    await agent.shutdown();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  await serveRpc(agent, ui, write, lines);
  await shutdown();
}
