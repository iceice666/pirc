import { describe, expect, it } from 'bun:test';
import { JsonlParser } from '../src/rpc-framing.js';

describe('JsonlParser', () => {
  it('preserves split UTF-8 and treats only LF as framing', () => {
    const values: unknown[] = [];
    const parser = new JsonlParser(1024, 4096, (value) => values.push(value));
    const bytes = Buffer.from('{"text":"☃ still-one-line"}\n');
    parser.push(bytes.subarray(0, 11));
    parser.push(bytes.subarray(11));
    parser.end();
    expect(values).toEqual([{ text: '☃ still-one-line' }]);
  });
  it('rejects CRLF and unterminated lines', () => {
    expect(() => new JsonlParser(100, 100, () => {}).push(Buffer.from('{}\r\n'))).toThrow(
      /LF-only/,
    );
    const parser = new JsonlParser(100, 100, () => {});
    parser.push(Buffer.from('{}'));
    expect(() => parser.end()).toThrow(/unterminated/);
  });
  it('enforces line and total output bounds', () => {
    expect(() => new JsonlParser(2, 100, () => {}).push(Buffer.from('{}{}\n'))).toThrow(
      /line limit/,
    );
    expect(() => new JsonlParser(100, 2, () => {}).push(Buffer.from('{}\n'))).toThrow(
      /output limit/,
    );
  });
});
