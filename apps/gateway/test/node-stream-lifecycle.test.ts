import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'bun:test';
import type { WebSocket } from 'ws';
import { NodeRegistry, RELAY_MESSAGE_MAX_BYTES, type TerminalStream } from '../src/daemon/nodes.js';
import { ModelStore } from '../src/models.js';
import { NODE_FRAME_MAX_BYTES, NODE_PROTOCOL_VERSION } from '../src/protocol.js';

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  frames: Record<string, any>[] = [];
  closes: Array<{ code: number | undefined; reason: string | undefined }> = [];
  failType: string | undefined;
  throwType: string | undefined;
  lateFailure?: () => void;
  delayType?: string;
  deferClose = false;
  accountBuffer = false;

  send(raw: string, callback?: (error?: Error) => void) {
    const frame = JSON.parse(raw);
    if (frame.type === this.throwType) throw new Error('send threw');
    if (frame.type === this.failType) {
      callback?.(new Error('send failed'));
      return;
    }
    this.frames.push(frame);
    if (this.accountBuffer) this.bufferedAmount += Buffer.byteLength(raw) + 14;
    if (frame.type === this.delayType)
      this.lateFailure = () => callback?.(new Error('late failure'));
    else callback?.();
  }
  close(code?: number, reason?: string) {
    if (this.readyState !== this.OPEN) return;
    this.closes.push({ code, reason });
    this.readyState = 2;
    if (!this.deferClose) this.finishClose();
  }
  finishClose() {
    this.readyState = 3;
    this.emit('close');
  }
  input(message: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(message)));
  }
}

const registries: NodeRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.close();
});
function setup() {
  const nodes = new NodeRegistry(new ModelStore());
  registries.push(nodes);
  const attach = (id = 'node') => {
    const socket = new FakeSocket();
    nodes.attach(id, socket as unknown as WebSocket);
    socket.input({
      type: 'register',
      role: 'node',
      protocol: NODE_PROTOCOL_VERSION,
      workspaces: [],
    });
    return socket;
  };
  return { nodes, attach, socket: attach() };
}
const target = { user: 'owner', sessionId: 'session', terminalId: 'terminal' };
function open(nodes: NodeRegistry, nodeId = 'node') {
  const frames: unknown[] = [];
  const closed: number[] = [];
  let stream: TerminalStream | undefined;
  stream = nodes.openTerminal(nodeId, target, {
    onFrame: (frame) => frames.push(frame),
    onClose(code) {
      closed.push(code);
      stream?.close(); // The browser route also closes its stream during cleanup.
    },
  });
  return { stream, frames, closed };
}
const detaches = (socket: FakeSocket) => socket.frames.filter((f) => f.type === 'terminal_close');

describe('node stream finalization', () => {
  it('detaches exactly once on local close and ignores late frames', () => {
    const { nodes, socket } = setup();
    const { stream, frames, closed } = open(nodes);
    const streamId = socket.frames.find((f) => f.type === 'terminal_open')!.streamId;
    stream.close();
    stream.close();
    stream.send({ type: 'input', data: 'ignored' });
    socket.input({ type: 'terminal_frame', streamId, frame: 'late' });
    expect(detaches(socket)).toEqual([{ type: 'terminal_close', streamId }]);
    expect(frames).toEqual([]);
    expect(closed).toEqual([]);
    expect(socket.closes).toEqual([]);
  });

  for (const failure of ['callback', 'throw', 'oversize', 'backpressure'] as const) {
    it(`detaches after ${failure} without disrupting another stream`, () => {
      const { nodes, socket } = setup();
      const first = open(nodes);
      const other = open(nodes);
      if (failure === 'callback') socket.failType = 'terminal_input';
      if (failure === 'throw') socket.throwType = 'terminal_input';
      if (failure === 'backpressure') socket.bufferedAmount = 4 * NODE_FRAME_MAX_BYTES;
      first.stream.send(
        failure === 'oversize'
          ? 'x'.repeat(RELAY_MESSAGE_MAX_BYTES.terminal + 1)
          : { type: 'input', data: 'x' },
      );
      expect(first.closed).toEqual([
        failure === 'oversize' ? 1009 : failure === 'backpressure' ? 1013 : 1011,
      ]);
      expect(detaches(socket)).toHaveLength(1);
      expect(socket.closes).toEqual([]);
      socket.bufferedAmount = 0;
      socket.failType = undefined;
      socket.throwType = undefined;
      other.stream.send({ type: 'input', data: 'still alive' });
      expect(socket.frames.at(-1)?.message.data).toBe('still alive');
      expect(other.closed).toEqual([]);
    });
  }

  it('settles an initial open failure and permits idempotent cleanup', () => {
    const { nodes, socket } = setup();
    socket.failType = 'terminal_open';
    const { stream, closed } = open(nodes);
    stream.close();
    expect(closed).toEqual([1011]);
    expect(detaches(socket)).toHaveLength(1);
  });

  it('does not echo remote closes or let another node close the stream', () => {
    const { nodes, socket, attach } = setup();
    const other = attach('other');
    const { stream, closed } = open(nodes);
    const streamId = socket.frames.find((f) => f.type === 'terminal_open')!.streamId;
    other.input({ type: 'terminal_closed', streamId, code: 1000, reason: 'wrong node' });
    expect(closed).toEqual([]);
    socket.input({ type: 'terminal_closed', streamId, code: 1000, reason: 'shell exited' });
    stream.close();
    expect(closed).toEqual([1000]);
    expect(detaches(socket)).toHaveLength(0);
  });

  it('link loss closes once without sending detach', () => {
    const { nodes, socket } = setup();
    const { closed, stream } = open(nodes);
    socket.close(1006, 'lost');
    stream.close();
    expect(closed).toEqual([1012]);
    expect(detaches(socket)).toHaveLength(0);
  });

  it('late send failure on a replaced link cannot affect its successor', () => {
    const { nodes, socket, attach } = setup();
    const old = open(nodes);
    socket.delayType = 'terminal_input';
    old.stream.send({ type: 'input', data: 'x' });
    const replacement = attach();
    const current = open(nodes);
    socket.lateFailure?.();
    old.stream.close();
    current.stream.send({ type: 'input', data: 'new' });
    expect(old.closed).toEqual([1012]);
    expect(current.closed).toEqual([]);
    expect(detaches(replacement)).toHaveLength(0);
    expect(replacement.closes).toHaveLength(0);
  });

  it('reserves enough bounded control space to detach every admitted stream', () => {
    const { nodes, socket } = setup();
    const streams = Array.from({ length: 64 }, () => open(nodes));
    socket.bufferedAmount = 4 * NODE_FRAME_MAX_BYTES;
    socket.accountBuffer = true;
    for (const { stream } of streams) stream.close();
    expect(detaches(socket)).toHaveLength(64);
    expect(socket.bufferedAmount).toBeLessThanOrEqual(4 * NODE_FRAME_MAX_BYTES + 64 * 256);
    expect(socket.closes).toHaveLength(0);
  });

  it('a delayed detach failure and old close event leave the replacement usable', () => {
    const { nodes, socket, attach } = setup();
    const first = open(nodes);
    const other = open(nodes);
    socket.deferClose = true;
    socket.delayType = 'terminal_close';
    first.stream.close();
    const lateFailure = socket.lateFailure!;
    lateFailure();
    expect(socket.readyState).toBe(2);
    expect(other.closed).toEqual([]);
    expect(() => open(nodes)).toThrow('Node is offline');
    const replacement = attach();
    const current = open(nodes);
    expect(other.closed).toEqual([1012]);
    lateFailure();
    socket.finishClose();
    current.stream.send({ type: 'input', data: 'new link' });
    expect(current.closed).toEqual([]);
    expect(replacement.frames.at(-1)?.message.data).toBe('new link');
    expect(detaches(replacement)).toHaveLength(0);
    expect(replacement.closes).toHaveLength(0);
  });

  for (const failure of ['callback', 'throw', 'reserve_exhausted'] as const) {
    it(`tears down the original link if detach cannot be delivered (${failure})`, () => {
      const { nodes, socket } = setup();
      const first = open(nodes);
      const other = open(nodes);
      if (failure === 'callback') socket.failType = 'terminal_close';
      if (failure === 'throw') socket.throwType = 'terminal_close';
      if (failure === 'reserve_exhausted') socket.bufferedAmount = 5 * NODE_FRAME_MAX_BYTES;
      first.stream.close();
      expect(socket.closes).toEqual([{ code: 1013, reason: 'stream cleanup failed' }]);
      expect(other.closed).toEqual([1012]);
      expect(nodes.get('node')).toBeUndefined();
    });
  }
});
