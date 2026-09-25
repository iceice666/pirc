import type { EventCursor, GatewayEvent } from './types.js';
import { now } from './util.js';

export type EventListener = (event: GatewayEvent) => void;
interface StreamState {
  epoch: number;
  sequence: number;
  events: GatewayEvent[];
  listeners: Set<EventListener>;
}

export class EventHub {
  private readonly streams = new Map<string, StreamState>();
  private readonly global = new Set<EventListener>();
  constructor(private readonly capacity: number) {}

  /** Every event of every session (a node forwards them all to the daemon). */
  subscribeAll(listener: EventListener): () => void {
    this.global.add(listener);
    return () => this.global.delete(listener);
  }

  private stream(sessionId: string, epoch = 0): StreamState {
    let stream = this.streams.get(sessionId);
    if (!stream) {
      stream = { epoch, sequence: 0, events: [], listeners: new Set() };
      this.streams.set(sessionId, stream);
    }
    if (epoch > stream.epoch) {
      stream.epoch = epoch;
      stream.sequence = 0;
      stream.events = [];
    }
    return stream;
  }

  publish(sessionId: string, epoch: number, type: string, data: unknown): GatewayEvent {
    const stream = this.stream(sessionId, epoch);
    const event = {
      sessionId,
      epoch: stream.epoch,
      sequence: ++stream.sequence,
      type,
      data,
      timestamp: now(),
    };
    stream.events.push(event);
    if (stream.events.length > this.capacity)
      stream.events.splice(0, stream.events.length - this.capacity);
    for (const listener of stream.listeners) listener(event);
    for (const listener of this.global) listener(event);
    return event;
  }

  watermark(sessionId: string, epoch = 0): EventCursor {
    const stream = this.stream(sessionId, epoch);
    return { epoch: stream.epoch, sequence: stream.sequence };
  }

  replay(
    sessionId: string,
    cursor: EventCursor | null,
    epoch = 0,
  ): { reset: boolean; events: GatewayEvent[]; watermark: EventCursor } {
    const stream = this.stream(sessionId, epoch);
    const watermark = { epoch: stream.epoch, sequence: stream.sequence };
    if (!cursor) return { reset: false, events: [...stream.events], watermark };
    const oldest = stream.events[0]?.sequence ?? stream.sequence + 1;
    if (
      cursor.epoch !== stream.epoch ||
      cursor.sequence > stream.sequence ||
      cursor.sequence < oldest - 1
    )
      return { reset: true, events: [], watermark };
    return {
      reset: false,
      events: stream.events.filter((event) => event.sequence > cursor.sequence),
      watermark,
    };
  }

  subscribe(sessionId: string, listener: EventListener): () => void {
    const stream = this.stream(sessionId);
    stream.listeners.add(listener);
    return () => stream.listeners.delete(listener);
  }
}
