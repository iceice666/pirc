import { commandFor } from './common.js';

/** Both node roles retain the same agent, team and PTC runtime. */
export async function runNodeEntry(role: 'chat' | 'node'): Promise<void> {
  const command = commandFor(`pirc-${role}`, ['agent', 'ptc-worker']);
  switch (command) {
    case 'agent':
      await (await import('../agent/main.js')).runAgent(process.argv.slice(2));
      break;
    case 'ptc-worker':
      await (await import('../agent/ptc/worker.js')).runPtcWorker(process.argv.slice(2));
      break;
    default:
      await (await import('../node/main.js')).runNode(role);
  }
}
