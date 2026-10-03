import { describe, expect, it, spyOn } from 'bun:test';
import { BrowserError, NodeBrowser } from '../src/agent/browser-channel.js';
import { ParentChannel } from '../src/agent/features/team/channel.js';
import { GatewayError, NodeGateway } from '../src/agent/gateway.js';
import { PendingRequests } from '../src/agent/pending-requests.js';
import { NodeSandboxChannel, SandboxRequestError } from '../src/agent/sandbox-channel.js';
import { NodeWriteBroker } from '../src/agent/write-lease.js';

describe('pending request lifecycle', () => {
  it('registers before send, uses unique IDs, and ignores retained settlers after completion', async () => {
    const requests = new PendingRequests<number>();
    const ids: string[] = [];
    const promises = [1, 2].map((value) =>
      requests.request({
        abortError: () => new Error('Aborted'),
        send: (id) => {
          ids.push(id);
          const pending = requests.get(id)!;
          pending.resolve(value);
          pending.reject(new Error('late failure'));
          pending.resolve(99);
          expect(requests.get(id)).toBeUndefined();
        },
      }),
    );
    expect(await Promise.all(promises)).toEqual([1, 2]);
    expect(new Set(ids).size).toBe(2);
  });

  it('cleans up a synchronous send failure, including its timer and abort listener', async () => {
    const requests = new PendingRequests();
    const controller = new AbortController();
    const remove = spyOn(controller.signal, 'removeEventListener');
    let id = '';
    let cancellations = 0;
    let timeouts = 0;
    const failure = new Error('write failed');
    const result = requests.request({
      signal: controller.signal,
      abortError: () => new Error('Aborted'),
      cancel: () => cancellations++,
      timeout: { ms: 5, error: () => (timeouts++, new Error('timeout')) },
      send: (requestId) => {
        id = requestId;
        throw failure;
      },
    });
    expect(await result.catch((error) => error)).toBe(failure);
    expect(requests.get(id)).toBeUndefined();
    expect(remove).toHaveBeenCalledTimes(1);
    controller.abort();
    await Bun.sleep(15);
    expect(cancellations).toBe(0);
    expect(timeouts).toBe(0);
    remove.mockRestore();
  });

  it('times out once, removes its listener, and ignores late replies and aborts', async () => {
    const requests = new PendingRequests();
    const controller = new AbortController();
    const remove = spyOn(controller.signal, 'removeEventListener');
    let id = '';
    let cancellations = 0;
    const failure = new Error('lost reply');
    const promise = requests.request({
      signal: controller.signal,
      abortError: () => new Error('Aborted'),
      cancel: () => cancellations++,
      timeout: { ms: 5, error: () => failure },
      send: (value) => {
        id = value;
      },
    });
    const pending = requests.get(id)!;
    expect(await promise.catch((error) => error)).toBe(failure);
    expect(requests.get(id)).toBeUndefined();
    expect(remove).toHaveBeenCalledTimes(1);
    pending.resolve('late');
    controller.abort();
    expect(cancellations).toBe(0);
    remove.mockRestore();
  });
});

type Frame = Record<string, any>;
type Client = {
  request: (signal?: AbortSignal) => Promise<unknown>;
  receive: (frame: Frame) => void;
  closeAll: () => void;
};
const cases = [
  {
    name: 'gateway',
    request: { type: 'gateway_request', op: 'op', args: { x: 1 } },
    cancel: undefined,
    errorClass: GatewayError,
    close: 'The gateway channel closed',
    success: { ok: true, result: { value: 1 } },
    result: { value: 1 },
    failure: {
      ok: false,
      error: { code: 'denied', message: 'refused', status: 409, details: { version: 2 } },
    },
    create(write: (frame: unknown) => void): Client {
      const client = new NodeGateway(write);
      return {
        request: (signal) => client.request('op', { x: 1 }, signal),
        receive: (frame) => client.respond(frame),
        closeAll: () => client.closeAll(),
      };
    },
  },
  {
    name: 'browser',
    request: { type: 'browser_request', op: 'op', args: { x: 1 } },
    cancel: 'browser_cancel',
    errorClass: BrowserError,
    close: 'The browser channel closed',
    success: { ok: true, result: { value: 1 } },
    result: { value: 1 },
    failure: { ok: false, error: { code: 'denied', message: 'refused' } },
    create(write: (frame: unknown) => void): Client {
      const client = new NodeBrowser(write);
      return {
        request: (signal) => client.request('op', { x: 1 }, signal),
        receive: (frame) => client.respond(frame),
        closeAll: () => client.closeAll(),
      };
    },
  },
  {
    name: 'sandbox',
    request: { type: 'sandbox_request', op: 'network', args: { x: 1 } },
    cancel: 'sandbox_cancel',
    errorClass: SandboxRequestError,
    close: 'The sandbox channel closed',
    success: { ok: true, result: null },
    result: {},
    failure: { ok: false, error: { code: 'denied', message: 'refused' } },
    create(write: (frame: unknown) => void): Client {
      const client = new NodeSandboxChannel(write);
      return {
        request: (signal) => client.request('network', { x: 1 }, signal),
        receive: (frame) => client.respond(frame),
        closeAll: () => client.closeAll(),
      };
    },
  },
  {
    name: 'team',
    request: { type: 'team_call', operation: 'op', args: { x: 1 } },
    cancel: 'team_cancel',
    errorClass: Error,
    close: 'Team channel closed',
    success: { result: { value: 1 } },
    result: { value: 1 },
    failure: { error: 'refused' },
    create(write: (frame: unknown) => void): Client {
      const client = new ParentChannel(write);
      return {
        request: (signal) => client.call('op', { x: 1 }, signal),
        receive: (frame) => client.receive(frame),
        closeAll: () => client.closeAll(),
      };
    },
  },
  {
    name: 'write lease',
    request: { type: 'write_lease_request', path: '/workspace' },
    cancel: undefined,
    errorClass: Error,
    close: 'Write broker closed',
    success: { granted: true },
    result: undefined,
    failure: { granted: false, error: 'refused' },
    create(write: (frame: unknown) => void): Client {
      const client = new NodeWriteBroker(write);
      return {
        request: (signal) => client.acquire('/workspace', signal),
        receive: (frame) => client.respond(frame),
        closeAll: () => client.closeAll(),
      };
    },
  },
];

for (const channel of cases) {
  describe(`${channel.name} shared request lifecycle`, () => {
    it('preserves frames, correlates results, and removes listeners after success and failure', async () => {
      const frames: Frame[] = [];
      const client = channel.create((frame) => frames.push(frame as Frame));
      const controller = new AbortController();
      const remove = spyOn(controller.signal, 'removeEventListener');
      const success = client.request(controller.signal);
      const failure = client.request(controller.signal).catch((error) => error);
      expect(frames[0]).toEqual({ ...channel.request, id: expect.any(String) });
      expect(frames[1]!.id).not.toBe(frames[0]!.id);
      client.receive({ id: 3, ...channel.success });
      client.receive({ id: 'unknown', ...channel.success });
      client.receive({ id: frames[1]!.id, ...channel.failure });
      client.receive({ id: frames[0]!.id, ...channel.success });
      client.receive({ id: frames[0]!.id, ...channel.failure });
      expect(await success).toEqual(channel.result);
      const error = await failure;
      expect(error).toBeInstanceOf(channel.errorClass);
      expect((error as Error).message).toBe('refused');
      if (channel.name === 'gateway')
        expect(error).toMatchObject({ code: 'denied', status: 409, details: { version: 2 } });
      expect(remove).toHaveBeenCalledTimes(2);
      controller.abort();
      client.closeAll();
      expect(frames).toHaveLength(2);
      remove.mockRestore();
    });

    it('throws before sending for pre-abort and preserves cancellation frames for post-abort', async () => {
      const frames: Frame[] = [];
      const client = channel.create((frame) => frames.push(frame as Frame));
      const pre = new AbortController();
      const reason = new Error('already aborted');
      pre.abort(reason);
      expect(() => client.request(pre.signal)).toThrow(reason);
      expect(frames).toHaveLength(0);
      const controller = new AbortController();
      const remove = spyOn(controller.signal, 'removeEventListener');
      const result = client.request(controller.signal).catch((error) => error);
      controller.abort();
      client.receive({ id: frames[0]!.id, ...channel.success });
      client.closeAll();
      const error = await result;
      expect((error as Error).message).toBe('Aborted');
      expect(error).toBeInstanceOf(
        channel.cancel && channel.name !== 'team' ? channel.errorClass : Error,
      );
      expect(frames).toEqual([
        { ...channel.request, id: frames[0]!.id },
        ...(channel.cancel ? [{ type: channel.cancel, id: frames[0]!.id }] : []),
      ]);
      expect(remove).toHaveBeenCalledTimes(1);
      remove.mockRestore();
    });

    it('closes all pending requests without sending cancellation and permits later requests', async () => {
      const frames: Frame[] = [];
      const client = channel.create((frame) => frames.push(frame as Frame));
      const controller = new AbortController();
      const remove = spyOn(controller.signal, 'removeEventListener');
      const results = [client.request(controller.signal), client.request(controller.signal)].map(
        (promise) => promise.catch((error) => error),
      );
      client.closeAll();
      client.closeAll();
      controller.abort();
      for (const error of await Promise.all(results)) {
        expect(error).toBeInstanceOf(channel.errorClass);
        expect((error as Error).message).toBe(channel.close);
      }
      expect(remove).toHaveBeenCalledTimes(2);
      expect(frames).toHaveLength(2);
      client.receive({ id: frames[0]!.id, ...channel.success });
      const next = client.request();
      client.receive({ id: frames[2]!.id, ...channel.success });
      expect(await next).toEqual(channel.result);
      remove.mockRestore();
    });

    it('rejects synchronous write errors and removes the abort listener', async () => {
      let writes = 0;
      const failure = new Error('broken pipe');
      const client = channel.create(() => {
        writes++;
        throw failure;
      });
      const controller = new AbortController();
      const remove = spyOn(controller.signal, 'removeEventListener');
      expect(await client.request(controller.signal).catch((error) => error)).toBe(failure);
      expect(remove).toHaveBeenCalledTimes(1);
      controller.abort();
      client.closeAll();
      expect(writes).toBe(1);
      remove.mockRestore();
    });

    if (channel.cancel)
      it('still rejects with the abort error when sending cancellation throws', async () => {
        let writes = 0;
        const client = channel.create(() => {
          if (++writes === 2) throw new Error('cancel failed');
        });
        const controller = new AbortController();
        const result = client.request(controller.signal).catch((error) => error);
        expect(() => controller.abort()).not.toThrow();
        expect(await result).toMatchObject({ message: 'Aborted' });
        expect(await result).toBeInstanceOf(channel.errorClass);
        client.closeAll();
        expect(writes).toBe(2);
      });
  });
}

it('only the gateway arms a lost-reply timer (45 seconds); human waits have none', async () => {
  const timer = spyOn(globalThis, 'setTimeout');
  const clients = cases.map((channel) => channel.create(() => {}));
  const results: Promise<unknown>[] = [];
  try {
    for (const client of clients) results.push(client.request().catch((error) => error));
    expect(timer).toHaveBeenCalledTimes(1);
    expect(timer.mock.calls[0]![1]).toBe(45_000);
  } finally {
    timer.mockRestore();
    for (const client of clients) client.closeAll();
    await Promise.all(results);
  }
});
