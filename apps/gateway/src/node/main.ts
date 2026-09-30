import { loadNodeConfig } from '../config.js';
import { startNode } from './runtime.js';

export async function runNode(role: 'chat' | 'node'): Promise<void> {
  const node = await startNode(loadNodeConfig(process.env, role));
  process.once('SIGINT', () => void node.close());
  process.once('SIGTERM', () => void node.close());
}
