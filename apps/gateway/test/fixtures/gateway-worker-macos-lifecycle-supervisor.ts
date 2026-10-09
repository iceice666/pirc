import { GatewayWorkerProcess } from '../../src/gateway-runtime/worker-process.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

// This process is the disposable fixture gateway, never a live service.
const worker = new GatewayWorkerProcess({ executable: process.argv[2]! });
await worker.drive(async () => {
  const internal = worker as unknown as {
    child: ChildProcessWithoutNullStreams;
    sandboxPid: number;
  };
  process.stdout.write(
    JSON.stringify({ wrapperPid: internal.child.pid, workerPid: internal.sandboxPid }) + '\n',
  );
  return new Promise(() => {});
}, AbortSignal.timeout(10_000));
