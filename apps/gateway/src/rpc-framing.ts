import { StringDecoder } from 'node:string_decoder';

export class JsonlParser {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private bytes = 0;
  constructor(
    private readonly maxLineBytes: number,
    private readonly maxOutputBytes: number,
    private readonly onValue: (value: unknown) => void,
  ) {}

  push(chunk: Buffer): void {
    this.bytes += chunk.byteLength;
    if (this.bytes > this.maxOutputBytes) throw new Error('RPC output limit exceeded');
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
