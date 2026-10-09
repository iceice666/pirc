import type { PtcGuestProcess } from '../agent/ptc/runtime.js';
import type { GuestMessage, HostMessage } from '../agent/ptc/protocol.js';
import { canonicalJson } from '../environment/json.js';
import { GatewayWorkerProcess } from './worker-process.js';

/** Service-owned constrained guest factory. No unsandboxed fallback on any platform. */
export function gatewayPtcGuest(executable: string) {
  return async (
    onMessage: (message: GuestMessage) => void,
    signal: AbortSignal,
  ): Promise<PtcGuestProcess> => {
    const worker = new GatewayWorkerProcess({ executable, protocol: 'ptc' });
    const channel = await worker.guestChannel(signal).catch(async (error) => {
      await worker.close();
      throw error;
    });
    let ended = false,
      pendingBytes = 0,
      pendingCount = 0;
    let sends = Promise.resolve();
    let settle!: () => void;
    const exited = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const kill = () => {
      if (ended) return;
      ended = true;
      void worker.close().finally(settle);
    };
    void (async () => {
      try {
        while (!ended) {
          const raw = await channel.receive();
          if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            throw new Error('Invalid PTC frame');
          const frame = raw as Record<string, unknown>;
          if (
            Object.keys(frame).sort().join(',') !== 'loaded,message' ||
            typeof frame.loaded !== 'boolean' ||
            !frame.message ||
            typeof frame.message !== 'object'
          )
            throw new Error('Invalid PTC envelope');
          const message = frame.message as GuestMessage;
          if (message.type === 'done') {
            if (!message.outcome || typeof message.outcome !== 'object')
              throw new Error('Invalid PTC outcome');
            if (frame.loaded) delete message.outcome.loaded;
            else message.outcome.loaded = false;
          }
          onMessage(message);
        }
      } catch {
        kill();
      }
    })();
    return {
      exited,
      kill,
      send(message: HostMessage) {
        if (ended) throw new Error('PTC guest closed');
        const bytes = Buffer.byteLength(canonicalJson(message, 32 * 1024 * 1024));
        if (++pendingCount > 256 || (pendingBytes += bytes) > 256 * 1024 * 1024) {
          kill();
          throw new Error('PTC write queue quota exceeded');
        }
        sends = sends
          .then(() => channel.send(message))
          .finally(() => {
            pendingCount--;
            pendingBytes -= bytes;
          });
        void sends.catch(kill);
        return sends;
      },
    };
  };
}
