import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, parseJson } from './json.js';
import {
  CONTROL_BYTES,
  RESULT_BYTES,
  decodeMessage,
  encodeMessage,
  type EnvironmentMessage,
} from './protocol.js';

const CHUNK = 32 * 1024;
const CREDIT = 4 * 1024 * 1024;
const RESERVE = 256 * 1024;
const MAX_MESSAGES = 32;
const frameSchema = z.discriminatedUnion('kind', [
  z
    .object({
      type: z.literal('environment.frame'),
      kind: z.literal('control'),
      message: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal('environment.frame'),
      kind: z.literal('chunk'),
      id: z.string().uuid(),
      offset: z.number().int().nonnegative(),
      total: z.number().int().positive().max(RESULT_BYTES),
      data: z.string().max(CHUNK * 2),
    })
    .strict(),
  z
    .object({
      type: z.literal('environment.frame'),
      kind: z.literal('credit'),
      bytes: z.number().int().positive().max(CREDIT),
    })
    .strict(),
]);
export type EnvironmentFrame = z.infer<typeof frameSchema>;
const control = (message: EnvironmentMessage) =>
  ![
    'execution.start',
    'environment.descriptor',
    'execution.result',
    'execution.reply',
    'execution.event',
    'artifact.fetch',
    'artifact.chunk',
  ].includes(message.type);

interface Outgoing {
  id: string;
  bytes: Buffer;
  offset: number;
  resolve(): void;
  reject(error: Error): void;
  cleanup(): void;
}
/**
 * Bounded Environment subchannel over an already authenticated socket. Raw frame
 * strings retain duplicate-key evidence. Credit is returned only after the
 * receiver's durable chunk sink commits. The supplied socket writer must resolve
 * after its write callback, not when placed in an unbounded user-space queue.
 * Does not claim fairness over legacy traffic bypassing that writer.
 */
export class EnvironmentFlow {
  private credit = CREDIT;
  private outstanding = 0;
  private data: Outgoing[] = [];
  private controls: Array<{ raw: string; resolve(): void; reject(error: Error): void }> = [];
  private controlBytes = 0;
  private pumping = false;
  private closed = false;
  private incoming = new Map<string, { total: number; offset: number }>();
  private incomingBytes = 0;
  private receiving: Promise<void> = Promise.resolve();
  private receivingControl: Promise<void> = Promise.resolve();
  constructor(
    private readonly io: {
      send(raw: string): Promise<void>;
      /** Persist a chunk before credit is granted; receiver owns bounded storage. */
      append(id: string, offset: number, total: number, bytes: Uint8Array): Promise<void>;
      take(id: string): Promise<string>;
      discard(id: string): Promise<void>;
      receive(message: EnvironmentMessage): Promise<void>;
      failed(error: Error): void;
    },
  ) {}

  send(message: EnvironmentMessage, signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Environment link offline'));
    signal?.throwIfAborted();
    const source = encodeMessage(message);
    if (control(message))
      return this.enqueueControl({ type: 'environment.frame', kind: 'control', message });
    if (
      this.data.length >= MAX_MESSAGES ||
      this.data.reduce((sum, item) => sum + item.bytes.length, 0) + Buffer.byteLength(source) >
        RESULT_BYTES * 2
    )
      return Promise.reject(new Error('Environment send quota exceeded'));
    return new Promise((resolve, reject) => {
      const abort = () => {
        // A partially sent logical message cannot be reused. Close the subchannel
        // instead of leaving a half-message consuming receiver capacity forever.
        this.close(new Error('Environment send cancelled'));
      };
      const item: Outgoing = {
        id: randomUUID(),
        bytes: Buffer.from(source),
        offset: 0,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', abort),
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.data.push(item);
      void this.pump();
    });
  }
  private enqueueControl(frame: EnvironmentFrame): Promise<void> {
    const raw = canonicalJson(frame, CONTROL_BYTES);
    if (this.closed || this.controlBytes + Buffer.byteLength(raw) > RESERVE)
      return Promise.reject(new Error('Environment control quota exceeded'));
    return new Promise((resolve, reject) => {
      this.controls.push({ raw, resolve, reject });
      this.controlBytes += Buffer.byteLength(raw);
      void this.pump();
    });
  }
  private async pump(): Promise<void> {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    let controls = 0;
    try {
      while (!this.closed) {
        const item = this.data[0];
        if (this.controls.length && (controls < 8 || !item || this.credit <= 0)) {
          const next = this.controls.shift()!;
          this.controlBytes -= Buffer.byteLength(next.raw);
          try {
            await this.io.send(next.raw);
            next.resolve();
          } catch (error) {
            next.reject(error as Error);
            throw error;
          }
          controls++;
          continue;
        }
        if (!item || this.credit <= 0) break;
        const size = Math.min(CHUNK, this.credit, item.bytes.length - item.offset);
        const raw = canonicalJson(
          {
            type: 'environment.frame',
            kind: 'chunk',
            id: item.id,
            offset: item.offset,
            total: item.bytes.length,
            data: item.bytes.subarray(item.offset, item.offset + size).toString('base64'),
          },
          CONTROL_BYTES,
        );
        this.credit -= size;
        this.outstanding += size;
        await this.io.send(raw);
        if (this.closed) break;
        item.offset += size;
        controls = 0;
        this.data.shift();
        if (item.offset === item.bytes.length) {
          item.cleanup();
          item.resolve();
        } else this.data.push(item); // Round-robin logical messages.
      }
    } catch (error) {
      this.close(error as Error);
    } finally {
      this.pumping = false;
    }
  }
  receive(raw: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Environment link offline'));
    if (Buffer.byteLength(raw) > CONTROL_BYTES) {
      this.close(new Error('Environment frame too large'));
      return Promise.reject(new Error('Environment frame too large'));
    }
    // Process credit immediately: durable incoming data waits must never block it.
    let frame: EnvironmentFrame;
    try {
      frame = frameSchema.parse(parseJson(raw, CONTROL_BYTES));
    } catch (error) {
      this.close(error as Error);
      return Promise.reject(error);
    }
    if (frame.kind === 'credit') {
      if (frame.bytes > this.outstanding) {
        this.close(new Error('Forged receive credit'));
        return Promise.reject(new Error('Forged receive credit'));
      }
      this.outstanding -= frame.bytes;
      this.credit += frame.bytes;
      void this.pump();
      return Promise.resolve();
    }
    const size = Buffer.byteLength(raw);
    this.incomingBytes += size;
    if (this.incomingBytes > CREDIT * 2 + RESERVE) {
      this.close(new Error('Environment receive queue exceeded'));
      return Promise.reject(new Error('Environment receive queue exceeded'));
    }
    const next = (frame.kind === 'control' ? this.receivingControl : this.receiving)
      .then(async () => {
        if (this.closed) return;
        if (frame.kind === 'control') {
          const message = decodeMessage(canonicalJson(frame.message, CONTROL_BYTES));
          if (!control(message)) throw new Error('Data message in control frame');
          await this.io.receive(message);
          return;
        }
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data))
          throw new Error('Invalid chunk encoding');
        const bytes = Buffer.from(frame.data, 'base64');
        if (!bytes.length || bytes.length > CHUNK) throw new Error('Invalid chunk size');
        let state = this.incoming.get(frame.id);
        if (!state) {
          if (
            frame.offset ||
            this.incoming.size >= MAX_MESSAGES ||
            [...this.incoming.values()].reduce((sum, item) => sum + item.total, 0) + frame.total >
              RESULT_BYTES * 2
          )
            throw new Error('Environment assembly quota exceeded');
          state = { total: frame.total, offset: 0 };
          this.incoming.set(frame.id, state);
        }
        if (
          state.total !== frame.total ||
          state.offset !== frame.offset ||
          frame.offset + bytes.length > frame.total
        )
          throw new Error('Out-of-order environment chunk');
        await this.io.append(frame.id, frame.offset, frame.total, bytes);
        if (this.closed) {
          await this.io.discard(frame.id);
          return;
        }
        state.offset += bytes.length;
        await this.enqueueControl({
          type: 'environment.frame',
          kind: 'credit',
          bytes: bytes.length,
        });
        if (state.offset === state.total) {
          const source = await this.io.take(frame.id);
          this.incoming.delete(frame.id);
          if (this.closed) return;
          const message = decodeMessage(source);
          if (control(message)) throw new Error('Control message in data frame');
          await this.io.receive(message);
        }
      })
      .finally(() => {
        this.incomingBytes -= size;
      });
    const settled = next.catch((error) => {
      this.close(error as Error);
    });
    if (frame.kind === 'control') this.receivingControl = settled;
    else this.receiving = settled;
    return next;
  }
  close(error = new Error('Environment link offline')): void {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.data.splice(0)) {
      item.cleanup();
      item.reject(error);
    }
    for (const item of this.controls.splice(0)) item.reject(error);
    this.controlBytes = 0;
    for (const id of this.incoming.keys()) void this.io.discard(id).catch(() => undefined);
    this.incoming.clear();
    this.io.failed(error);
  }
}
