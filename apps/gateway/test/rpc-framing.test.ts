import { describe, expect, it } from 'bun:test';
import { JsonlParser } from '../src/node/rpc-framing.js';

describe('JsonlParser', () => {
  it('preserves split UTF-8 and treats only LF as framing', () => {
    const values: unknown[] = [];
    const parser = new JsonlParser(1024, (value) => values.push(value));
    const bytes = Buffer.from('{"text":"☃ still-one-line"}\n');
    parser.push(bytes.subarray(0, 11));
    parser.push(bytes.subarray(11));
    parser.end();
    expect(values).toEqual([{ text: '☃ still-one-line' }]);
  });
  it('rejects CRLF and unterminated lines', () => {
    expect(() => new JsonlParser(100, () => {}).push(Buffer.from('{}\r\n'))).toThrow(/LF-only/);
    const parser = new JsonlParser(100, () => {});
    parser.push(Buffer.from('{}'));
    expect(() => parser.end()).toThrow(/unterminated/);
  });
  it('bounds a single line, complete or still buffered', () => {
    expect(() => new JsonlParser(2, () => {}).push(Buffer.from('{}{}\n'))).toThrow(/line limit/);
    expect(() => new JsonlParser(2, () => {}).push(Buffer.from('{"a"'))).toThrow(/line limit/);
  });
  it('never limits the total a long-lived agent writes', () => {
    // A runner once died after ~16 MiB of ordinary output spread over a session.
    let count = 0;
    const parser = new JsonlParser(1024, () => count++);
    const line = Buffer.from(`${JSON.stringify({ pad: 'x'.repeat(1000) })}\n`);
    for (let index = 0; index < 20_000; index++) parser.push(line);
    expect(count).toBe(20_000);
  });
});
