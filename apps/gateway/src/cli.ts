#!/usr/bin/env bun
/** Single-binary entry point: `pirc gateway | node | version`. */
const usage = `Usage: pirc <command>

Commands:
  gateway   Run the central daemon: browser API and routing, never runs agents
  node      Run agents for this device; connects out to PIRC_DAEMON_URL
  agent     (internal) Run one agent session over JSONL RPC on stdin/stdout
  version   Print the version
`;

const version = '0.1.0';

export {};

const [command, ...rest] = process.argv.slice(2);
process.argv.splice(2, 1 + rest.length, ...rest);

switch (command) {
  case 'gateway':
    await (await import('./daemon/main.js')).runGateway();
    break;
  case 'agent':
    await (await import('./agent/main.js')).runAgent(process.argv.slice(2));
    break;
  case 'ptc-worker':
    await (await import('./agent/ptc/worker.js')).runPtcWorker(process.argv.slice(2));
    break;
  case 'node':
    await (await import('./node/main.js')).runNode();
    break;
  case 'version':
  case '--version':
    console.log(version);
    break;
  case undefined:
  case 'help':
  case '--help':
  case '-h':
    process.stdout.write(usage);
    break;
  default:
    process.stderr.write(`Unknown command: ${command}\n\n${usage}`);
    process.exit(2);
}
