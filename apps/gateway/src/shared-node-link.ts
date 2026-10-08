import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ChunkStore } from './environment/chunks.js';
import { canonicalJson, parseJson } from './environment/json.js';

const FRAME = 65536,
  CHUNK = 32768,
  CREDIT = 4 * 1024 * 1024,
  RESERVE = 256 * 1024,
  LOGICAL = 16 * 1024 * 1024;
const schema = z.discriminatedUnion('kind', [
  z
    .object({
      type: z.literal('node.link'),
      kind: z.literal('control'),
      raw: z.string().max(FRAME),
    })
    .strict(),
  z
    .object({
      type: z.literal('node.link'),
      kind: z.literal('chunk'),
      id: z.string().uuid(),
      offset: z.number().int().nonnegative(),
      total: z.number().int().positive().max(LOGICAL),
      data: z.string().max(CHUNK * 2),
    })
    .strict(),
  z
    .object({
      type: z.literal('node.link'),
      kind: z.literal('credit'),
      bytes: z.number().int().positive().max(CREDIT),
    })
    .strict(),
]);
interface Data {
  id: string;
  bytes: Buffer;
  offset: number;
  key: string;
  resolve(): void;
  reject(error: Error): void;
}
/** One writer/credit window for every producer on a physical authenticated node socket. */
export class SharedNodeLink {
  private credit = CREDIT;
  private outstanding = 0;
  private controls: Array<{ raw: string; resolve(): void; reject(error: Error): void }> = [];
  private controlBytes = 0;
  private sendingControl: { reject(error: Error): void } | undefined;
  private data: Data[] = [];
  private sending: Data | undefined;
  private lastKey: string | undefined;
  private pumping = false;
  private closed = false;
  private incoming = new Map<string, { total: number; offset: number }>();
  private receiving = Promise.resolve();
  private queuedReceive = 0;
  private directory = mkdtempSync(path.join(tmpdir(), 'pirc-node-link-'));
  private store = new ChunkStore(this.directory);
  constructor(
    private io: {
      send(raw: string): Promise<void>;
      receive(raw: string): void;
      fail(error: Error): void;
    },
  ) {}
  get queuedBytes(): number {
    return (
      this.controlBytes + this.data.reduce((sum, item) => sum + item.bytes.length - item.offset, 0)
    );
  }
  send(raw: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Node link closed'));
    const size = Buffer.byteLength(raw);
    if (size > LOGICAL) return Promise.reject(new Error('Node logical message too large'));
    let message: Record<string, any>;
    try {
      message = JSON.parse(raw);
    } catch {
      return Promise.reject(new Error('Invalid node message'));
    }
    const control =
      ['heartbeat', 'heartbeat_ack'].includes(message.type) ||
      (message.type === 'environment.frame' && message.kind !== 'chunk');
    const key = String(
      message.requestId ?? message.streamId ?? message.sessionId ?? message.id ?? message.type,
    );
    // Legacy lifecycle messages stay on the ordered data lane: physical delivery
    // callbacks are not durable logical admission acknowledgments.
    if (control && size < 48000) return this.control({ type: 'node.link', kind: 'control', raw });
    if (
      this.data.length >= 128 ||
      this.data.reduce((sum, item) => sum + item.bytes.length, 0) +
        (this.sending?.bytes.length ?? 0) +
        size >
        LOGICAL * 2
    )
      return Promise.reject(new Error('Node send queue exceeded'));
    return new Promise((resolve, reject) => {
      this.data.push({
        id: randomUUID(),
        bytes: Buffer.from(raw),
        offset: 0,
        key,
        resolve,
        reject,
      });
      void this.pump();
    });
  }
  private control(frame: unknown): Promise<void> {
    const raw = canonicalJson(frame, FRAME),
      bytes = Buffer.byteLength(raw);
    if (this.closed || this.controlBytes + bytes > RESERVE)
      return Promise.reject(new Error('Node control queue exceeded'));
    return new Promise((resolve, reject) => {
      this.controls.push({ raw, resolve, reject });
      this.controlBytes += bytes;
      void this.pump();
    });
  }
  private async pump(): Promise<void> {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    let controls = 0;
    try {
      while (!this.closed) {
        if (this.controls.length && (controls < 8 || !this.data.length || !this.credit)) {
          const item = this.controls.shift()!;
          this.controlBytes -= Buffer.byteLength(item.raw);
          this.sendingControl = item;
          try {
            await this.io.send(item.raw);
            this.sendingControl = undefined;
            item.resolve();
          } catch (error) {
            item.reject(error as Error);
            throw error;
          }
          controls++;
          continue;
        }
        const index = this.data.findIndex((entry) => entry.key !== this.lastKey);
        const item = this.data.splice(index < 0 ? 0 : index, 1)[0];
        if (!item) break;
        if (!this.credit) {
          this.data.unshift(item);
          break;
        }
        const size = Math.min(CHUNK, this.credit, item.bytes.length - item.offset);
        this.credit -= size;
        this.outstanding += size;
        this.sending = item;
        await this.io.send(
          canonicalJson(
            {
              type: 'node.link',
              kind: 'chunk',
              id: item.id,
              offset: item.offset,
              total: item.bytes.length,
              data: item.bytes.subarray(item.offset, item.offset + size).toString('base64'),
            },
            FRAME,
          ),
        );
        if (this.closed) break;
        this.sending = undefined;
        item.offset += size;
        controls = 0;
        this.lastKey = item.key;
        if (item.offset === item.bytes.length) item.resolve();
        else {
          // Keep logical messages ordered within their stream while rotating streams.
          const next = this.data.findIndex((entry) => entry.key === item.key);
          if (next < 0) this.data.push(item);
          else this.data.splice(next, 0, item);
        }
      }
    } catch (error) {
      this.close(error as Error);
    } finally {
      this.pumping = false;
    }
  }
  receive(raw: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Node link closed'));
    let frame: z.infer<typeof schema>;
    try {
      frame = schema.parse(parseJson(raw, FRAME));
    } catch (error) {
      this.close(error as Error);
      return Promise.reject(error);
    }
    if (frame.kind === 'credit') {
      if (frame.bytes > this.outstanding) {
        const error = new Error('Forged node credit');
        this.close(error);
        return Promise.reject(error);
      }
      this.outstanding -= frame.bytes;
      this.credit += frame.bytes;
      void this.pump();
      return Promise.resolve();
    }
    if (frame.kind === 'control') {
      try {
        this.io.receive(frame.raw);
        return Promise.resolve();
      } catch (error) {
        this.close(error as Error);
        return Promise.reject(error);
      }
    }
    this.queuedReceive += Buffer.byteLength(raw);
    if (this.queuedReceive > CREDIT * 2 + RESERVE) {
      const error = new Error('Node receive quota exceeded');
      this.close(error);
      return Promise.reject(error);
    }
    const next = this.receiving
      .then(async () => {
        if (this.closed) return;
        const bytes = Buffer.from(frame.data, 'base64');
        if (!bytes.length || bytes.length > CHUNK || bytes.toString('base64') !== frame.data)
          throw new Error('Invalid node chunk');
        let state = this.incoming.get(frame.id);
        if (!state) {
          if (
            frame.offset ||
            this.incoming.size >= 128 ||
            [...this.incoming.values()].reduce((sum, item) => sum + item.total, 0) + frame.total >
              LOGICAL * 2
          )
            throw new Error('Node assembly quota exceeded');
          state = { total: frame.total, offset: 0 };
          this.incoming.set(frame.id, state);
        }
        if (
          state.offset !== frame.offset ||
          state.total !== frame.total ||
          frame.offset + bytes.length > frame.total
        )
          throw new Error('Invalid node chunk ordering');
        await this.store.append(frame.id, frame.offset, frame.total, bytes);
        if (this.closed) {
          await this.store.discard(frame.id);
          return;
        }
        state.offset += bytes.length;
        await this.control({ type: 'node.link', kind: 'credit', bytes: bytes.length });
        if (state.offset === state.total) {
          const source = await this.store.take(frame.id);
          this.incoming.delete(frame.id);
          if (!this.closed) this.io.receive(source);
        }
      })
      .finally(() => {
        this.queuedReceive -= Buffer.byteLength(raw);
      });
    this.receiving = next.catch((error) => this.close(error as Error));
    return next;
  }
  close(error = new Error('Node link closed')): void {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.controls.splice(0)) item.reject(error);
    this.sendingControl?.reject(error);
    this.sendingControl = undefined;
    this.sending?.reject(error);
    this.sending = undefined;
    for (const item of this.data.splice(0)) item.reject(error);
    void this.receiving.finally(() => rmSync(this.directory, { recursive: true, force: true }));
    this.io.fail(error);
  }
}
