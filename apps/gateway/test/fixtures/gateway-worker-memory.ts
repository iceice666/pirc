// Shipped adversarial fixture: exceed a lower test limit AFTER the trusted
// supervisor has admitted the worker and begun a stalled capability callback.
import { sealGatewayWorker } from '../../src/gateway-runtime/worker-seal.js';
sealGatewayWorker();
process.stdout.write('{"seq":1,"action":"model"}\n');
process.stdin.resume();
const retained: Uint8Array[] = [];
setTimeout(() => {
  for (let i = 0; i < 24; i++) {
    const block = new Uint8Array(8 * 1024 * 1024);
    block.fill(0x42); // Touch physical pages; virtual reservation is insufficient.
    retained.push(block);
  }
}, 250);
setInterval(() => {
  void retained.length;
}, 1000);
