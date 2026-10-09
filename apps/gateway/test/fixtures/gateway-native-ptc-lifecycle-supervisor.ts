import { GatewayWorkerProcess } from '../../src/gateway-runtime/worker-process.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { preflight } from '../../src/agent/ptc/preflight.js';
// Disposable fixture gateway; never a live service. The admitted native guest
// enters a CPU-bound loop and cannot observe stdin EOF after supervisor death.
const worker = new GatewayWorkerProcess({ executable: process.argv[2]!, protocol: 'ptc' });
try {
  const channel = await worker.guestChannel(AbortSignal.timeout(15000));
  await channel.send({
    type: 'start',
    code: preflight('console.log("busy-parent-death");while(true){}').js,
    manifest: [],
  });
  const frame = (await channel.receive()) as { message?: { type?: string; text?: string } };
  if (frame.message?.type !== 'log' || frame.message.text !== 'busy-parent-death')
    throw new Error('Native guest did not enter hostile loop');
  const internal = worker as unknown as {
    child: ChildProcessWithoutNullStreams;
    sandboxPid: number;
  };
  process.stdout.write(
    JSON.stringify({ wrapperPid: internal.child.pid, workerPid: internal.sandboxPid }) + '\n',
  );
  await channel.receive();
} finally {
  await worker.close();
}
