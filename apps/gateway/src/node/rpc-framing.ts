import { StringDecoder } from 'node:string_decoder';

/**
 * LF-framed JSON from an agent's stdout. Only a single line is bounded: an
 * agent streams for as long as it lives (every delta, every snapshot's
 * `get_messages`), so a cap on the running total would eventually kill any
 * long-lived session however well it behaves.
 */
export class JsonlParser {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  constructor(
    private readonly maxLineBytes: number,
    private readonly onValue: (value: unknown) => void,
  ) {}

  push(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes)
        throw new Error('RPC line limit exceeded');
      if (line.endsWith('\r')) throw new Error('RPC protocol requires LF-only framing');
      if (line.length) this.onValue(JSON.parse(line));
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxLineBytes)
      throw new Error('RPC line limit exceeded');
  }

  end(): void {
    this.buffer += this.decoder.end();
    if (this.buffer.length) throw new Error('RPC stream ended with an unterminated JSON line');
  }
}
