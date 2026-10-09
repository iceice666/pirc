import { JsonlParser } from '../node/rpc-framing.js';
import { sealGatewayWorker } from './worker-seal.js';

export type WorkerAction = 'model' | 'tools' | 'done';
export const WORKER_FRAME_BYTES = 4096;

/** Shipped loop only. No history, credentials, paths, tools or ambient execution. */
export async function runGatewayWorker(): Promise<void> {
  sealGatewayWorker();
  let next: WorkerAction = 'model';
  let seq = 0;
  let awaiting = false;
  const send = () => {
    awaiting = true;
    process.stdout.write(JSON.stringify({ seq: ++seq, action: next }) + '\n');
  };
  const parser = new JsonlParser(WORKER_FRAME_BYTES, (value) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid worker reply');
    const reply = value as Record<string, unknown>;
    if (
      !awaiting ||
      reply.seq !== seq ||
      Object.keys(reply).sort().join(',') !== 'next,seq' ||
      !['model', 'tools', 'done'].includes(String(reply.next))
    )
      throw new Error('Worker reply mismatch');
    awaiting = false;
    if (next === 'done') {
      process.stdin.pause();
      process.exit(0);
    }
    next = reply.next as WorkerAction;
    send();
  });
  process.stdin.on('data', (chunk: Buffer) => {
    try {
      parser.push(chunk);
    } catch {
      process.exit(2);
    }
  });
  process.stdin.on('end', () => process.exit(2));
  send();
}
