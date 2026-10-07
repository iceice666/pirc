/**
 * Image attachments of one `ptc` execution (plans/ptc-m1-contracts.md
 * "Attachments"). An operation's images stay on the host; the script sees
 * descriptors with an opaque, unguessable handle and may queue them for the
 * outer `ptc` result with `attachments.add(handle)`. No bytes, paths or URLs
 * ever enter the realm, and nothing here can read anything new: a handle only
 * names an image an operation of this execution already returned.
 *
 * Handles belong to one execution (the instance), so they cannot be used by
 * another session or a later call. They expire after 15 minutes or when the
 * execution ends; whatever was not queued is dropped then.
 */
import { randomBytes } from 'node:crypto';
import type { ImageContent } from '../messages.js';
import { PtcError, type AttachmentRef } from './contracts.js';

export type AttachmentDescriptor = AttachmentRef;

export const ATTACHMENT_LIMITS = Object.freeze({
  /** Attachments one `ptc` result may carry. */
  count: 4,
  /**
   * The queued images of one result, decoded. The result travels as one node RPC line (1 MiB
   * by default) three times over, with its text and details, so its base64 (4/3 larger) must
   * stay well below that line limit.
   */
  bytesEach: 512 * 1024,
  bytesTotal: 512 * 1024,
  ttlMs: 15 * 60 * 1000,
  /** Images kept for possible attachment; older unqueued ones are dropped first. */
  retained: 16,
  retainedBytes: 64 * 1024 * 1024,
  /** `attachments.add` calls per execution. */
  calls: 100,
});

export const HANDLE_PATTERN = /^att_[0-9a-f]{64}$/;

interface Stored {
  image: ImageContent;
  bytes: number;
  expiresAt: number;
}

const decodedBytes = (base64: string) =>
  Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);

export class Attachments {
  private readonly stored = new Map<string, Stored>();
  private readonly queued: string[] = [];
  private calls = 0;
  private closed = false;

  constructor(
    /** Whether the current model accepts images; checked on every `add`. */
    private readonly modelTakesImages: () => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  /** Keep an operation's image; the script gets only its descriptor. */
  register(image: ImageContent): AttachmentDescriptor {
    const handle = `att_${randomBytes(32).toString('hex')}`;
    const bytes = decodedBytes(image.data);
    if (!this.closed) {
      this.stored.set(handle, { image, bytes, expiresAt: this.now() + ATTACHMENT_LIMITS.ttlMs });
      this.evict();
    }
    return { handle, mimeType: image.mimeType, bytes };
  }

  private evict(): void {
    const total = () => [...this.stored.values()].reduce((sum, item) => sum + item.bytes, 0);
    for (const handle of [...this.stored.keys()]) {
      if (
        this.stored.size <= ATTACHMENT_LIMITS.retained &&
        total() <= ATTACHMENT_LIMITS.retainedBytes
      )
        return;
      if (!this.queued.includes(handle)) this.stored.delete(handle);
    }
  }

  /** `attachments.add(handle)`: queue an image for the outer result. */
  add(handle: unknown): { queued: number } {
    if (++this.calls > ATTACHMENT_LIMITS.calls)
      throw new PtcError(
        'QuotaExceeded',
        `More than ${ATTACHMENT_LIMITS.calls} attachments.add calls`,
      );
    if (typeof handle !== 'string' || !HANDLE_PATTERN.test(handle))
      throw new PtcError(
        'InvalidArguments',
        'attachments.add takes an image descriptor (or its handle) from an operation result',
      );
    const item = this.stored.get(handle);
    if (!item || this.closed)
      throw new PtcError(
        'InvalidArguments',
        'Unknown attachment handle: it was never issued in this ptc call, or was dropped',
      );
    if (item.expiresAt <= this.now()) {
      this.stored.delete(handle);
      throw new PtcError('InvalidArguments', 'This attachment handle expired');
    }
    if (!this.modelTakesImages())
      throw new PtcError(
        'CapabilityUnavailable',
        'The current model does not accept images; describe the image in text instead',
      );
    if (this.queued.includes(handle)) return { queued: this.queued.length };
    if (this.queued.length >= ATTACHMENT_LIMITS.count)
      throw new PtcError(
        'QuotaExceeded',
        `At most ${ATTACHMENT_LIMITS.count} attachments per ptc call`,
      );
    if (item.bytes > ATTACHMENT_LIMITS.bytesEach)
      throw new PtcError(
        'QuotaExceeded',
        `The image is larger than ${ATTACHMENT_LIMITS.bytesEach} bytes and cannot be attached`,
      );
    const total = this.queued.reduce(
      (sum, queued) => sum + (this.stored.get(queued)?.bytes ?? 0),
      0,
    );
    if (total + item.bytes > ATTACHMENT_LIMITS.bytesTotal)
      throw new PtcError(
        'QuotaExceeded',
        `Attachments of one ptc call are limited to ${ATTACHMENT_LIMITS.bytesTotal} bytes in total`,
      );
    this.queued.push(handle);
    return { queued: this.queued.length };
  }

  /**
   * End of the execution: the queued images (only when `deliver`), then every
   * handle is gone. Expired ones are not delivered.
   */
  close(deliver: boolean): ImageContent[] {
    const now = this.now();
    const images = deliver
      ? this.queued.flatMap((handle) => {
          const item = this.stored.get(handle);
          return item && item.expiresAt > now ? [item.image] : [];
        })
      : [];
    this.closed = true;
    this.stored.clear();
    this.queued.length = 0;
    return images;
  }
}
