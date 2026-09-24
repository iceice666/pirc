import { loadConfig } from './config.js';
import { startNodeAgent } from './agent-runtime.js';

const nodeId = process.env.PIRC_NODE_ID;
const token = process.env.PIRC_NODE_TOKEN;
const daemonUrl = process.env.PIRC_DAEMON_URL;
if (
  !nodeId ||
  !/^[a-zA-Z0-9_-]{1,100}$/.test(nodeId) ||
  !token ||
  token.length < 32 ||
  !daemonUrl ||
  !/^wss?:\/\//.test(daemonUrl)
)
  throw new Error('PIRC_NODE_ID, PIRC_NODE_TOKEN and ws(s) PIRC_DAEMON_URL are required');
if (!daemonUrl.startsWith('wss://') && process.env.PIRC_ALLOW_INSECURE_NODE_TRANSPORT !== 'true')
  throw new Error(
    'Node transport requires wss:// (or explicit development-only insecure override)',
  );
const config = loadConfig({
  ...process.env,
  PIRC_TRUSTED_PROXIES: '127.0.0.1,::1',
  PIRC_ALLOWED_USERS: process.env.PIRC_ALLOWED_USERS,
  PIRC_ALLOWED_ORIGINS: 'https://node.internal',
  PIRC_ALLOWED_HOSTS: 'node.internal',
  PIRC_NODE_ID: nodeId,
  PIRC_NODE_TOKEN: token,
});
const agent = await startNodeAgent(config, nodeId, token, daemonUrl);
process.once('SIGINT', () => void agent.close());
process.once('SIGTERM', () => void agent.close());
