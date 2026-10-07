import { describe, expect, it } from 'bun:test';
import {
  compactSignatureOf,
  fitSignatures,
  signatureOf,
  summaryOf,
  tsType,
} from '../src/agent/ptc/signatures.js';
import { lsTool, readTool } from '../src/agent/tools/files.js';
import { bashTool } from '../src/agent/tools/bash.js';

describe('capability signatures for the system prompt', () => {
  it('renders JSON schemas as compact TypeScript types', () => {
    expect(tsType({ type: 'string' })).toBe('string');
    expect(tsType({ type: 'integer' })).toBe('number');
    expect(tsType({ const: 'text' })).toBe('"text"');
    expect(tsType({ type: 'string', enum: ['a', 'b'] })).toBe('"a" | "b"');
    expect(tsType({ type: ['integer', 'null'] })).toBe('number | null');
    expect(tsType({ type: 'array', items: { type: ['string', 'null'] } })).toBe(
      '(string | null)[]',
    );
    expect(
      tsType({
        type: 'object',
        properties: { a: { type: 'string' }, 'b-c': { type: 'boolean' } },
        required: ['a'],
        additionalProperties: true,
      }),
    ).toBe('{ a: string; "b-c"?: boolean; [key: string]: unknown }');
    expect(tsType({ type: 'object', properties: {}, additionalProperties: false })).toBe('{}');
    expect(tsType({ type: 'object' })).toBe('Record<string, unknown>');
    expect(tsType({ oneOf: [{ type: 'string' }, { type: 'string' }, { type: 'null' }] })).toBe(
      'string | null',
    );
    expect(tsType({})).toBe('unknown');
    // Nullable enums and consts keep their null; only top-level unions are parenthesized.
    expect(tsType({ type: ['string', 'null'], enum: ['a', 'b'] })).toBe('"a" | "b" | null');
    expect(
      tsType({
        type: 'array',
        items: {
          type: 'object',
          properties: { k: { type: 'string', enum: ['x', 'y'] } },
          required: ['k'],
        },
      }),
    ).toBe('{ k: "x" | "y" }[]');
    // Deep nesting is cut short.
    const deep = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] };
    let schema: Record<string, unknown> = deep;
    for (let i = 0; i < 4; i++)
      schema = { type: 'object', properties: { n: schema }, required: ['n'] };
    expect(tsType(schema)).toBe('{ n: { n: { n: object } } }');
  });

  it('gives other capabilities a one-line call signature without result fields', () => {
    const line = compactSignatureOf(lsTool);
    expect(line).toBe(
      '`tools.ls(args?: { path?: string })` — List a directory (directories end with /).',
    );
    expect(line).not.toContain('\n');
  });

  it('fits core blocks first, then others in order, and names the rest sorted', () => {
    const block = (name: string, size: number) => ({ name, block: name.padEnd(size, '.') });
    const result = fitSignatures(
      [block('read', 40), block('bash', 40)],
      [block('a_small', 10), block('c_big', 50), block('b_mid', 20)],
      100,
    );
    expect(result.coreListed.map((b) => b.slice(0, 4))).toEqual(['read', 'bash']);
    expect(result.otherListed.map((b) => b.replace(/\.+$/, ''))).toEqual(['a_small']);
    expect(result.unlisted).toEqual(['b_mid', 'c_big']);
  });

  it('keeps abbreviations inside the first sentence', () => {
    expect(summaryOf('Find files by glob (e.g. `**/*.ts`). Skips .git.')).toBe(
      'Find files by glob (e.g. `**/*.ts`).',
    );
    expect(summaryOf('One.\nTwo.')).toBe('One.');
    expect(summaryOf('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('gives a capability its call, result fields without text/images, summary and notes', () => {
    const block = signatureOf(readTool);
    expect(block.split('\n')[0]).toBe(
      '`tools.read(args: { path: string; offset?: number; limit?: number }): { kind: "text"; path: string; content: string; contentTruncated: boolean; offset: number; lines: number; totalLines: number; nextOffset: number | null; truncated: boolean } | { kind: "image"; path: string; mimeType: string; bytes: number }`',
    );
    expect(block).not.toContain('images');
    expect(signatureOf(lsTool).split('\n')[0]).toStartWith(
      '`tools.ls(args?: { path?: string }): {',
    );
    expect(signatureOf(bashTool)).toContain('a non-zero exit resolves normally');
    expect(block.split('\n')[1]).toBe(
      '  Read a file. (path: File path, relative to the workspace or absolute; offset: 1-based first line; limit: Maximum lines to return)',
    );
  });
});
