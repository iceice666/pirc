/** Bounded Responses SSE observation independent of Pi's normalized usage/default zeros. */
import { OpenAIStreamEvidence, type OpenAIUsage } from './openai-contract.js';
export class OpenAIWireObserver {
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private buffer = '';
  private data: string[] = [];
  private frameBytes = 0;
  private bytes = 0;
  private evidence = new OpenAIStreamEvidence();
  private invalid = false;
  private ended = false;
  push(chunk: Uint8Array): void {
    this.bytes += chunk.byteLength;
    if (this.bytes > 256 * 1024 * 1024) throw new Error('Responses stream limit');
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      this.frameBytes += Buffer.byteLength(line);
      if (this.frameBytes > 1024 * 1024) throw new Error('Responses frame limit');
      if (!line) {
        if (this.data.length) {
          const text = this.data.join('\n');
          this.data = [];
          if (text === '[DONE]') this.ended = true;
          else {
            if (this.ended) this.invalid = true;
            try {
              this.evidence.observe(JSON.parse(text));
            } catch {
              this.invalid = true;
              throw new Error('Invalid Responses frame');
            }
          }
        }
        this.frameBytes = 0;
      } else if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''));
    }
    if (Buffer.byteLength(this.buffer) > 1024 * 1024) throw new Error('Responses line limit');
  }
  finish(): OpenAIUsage | null {
    try {
      this.buffer += this.decoder.decode();
    } catch {
      this.invalid = true;
    }
    return this.invalid || this.buffer.trim() || this.data.length ? null : this.evidence.usage();
  }
  success(): boolean {
    return (
      !this.invalid && !this.buffer.trim() && this.data.length === 0 && this.evidence.success()
    );
  }
  status(): 'complete' | 'invalid' | 'incomplete_frame' {
    if (this.buffer.trim() || this.data.length) return 'incomplete_frame';
    return this.invalid || !this.evidence.usage() ? 'invalid' : 'complete';
  }
  get responseBytes(): number {
    return this.bytes;
  }
}
