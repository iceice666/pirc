import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

// Protocol behavior ONLY: execute the operator-built native finite driver with
// empty environment and pipe-only stdio, without claiming sandbox containment.
// Real launch/authority tests separately exercise the trusted bootstrap.
const executable = process.env.PIRC_TEST_GATEWAY_WORKER;
const enabled = process.platform === 'darwin' && Boolean(executable);
const run = (input: string | Buffer) =>
  spawnSync(executable!, [], {
    cwd: '/',
    env: {},
    input,
    encoding: 'utf8',
    timeout: 2000,
    maxBuffer: 8192,
  });

const reply = (next: string, seq: number) => JSON.stringify({ next, seq }) + '\n';

test.skipIf(!enabled)('native macOS phase protocol follows model/tools/model/done sequence', () => {
  const result = run(reply('tools', 1) + reply('model', 2) + reply('done', 3) + reply('done', 4));
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe(
    '{"seq":1,"action":"model"}\n' +
      '{"seq":2,"action":"tools"}\n' +
      '{"seq":3,"action":"model"}\n' +
      '{"seq":4,"action":"done"}\n',
  );
});

test.skipIf(!enabled)('native macOS phase protocol retains legacy terminal ACK semantics', () => {
  const result = run(reply('done', 1) + reply('tools', 2));
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('{"seq":1,"action":"model"}\n{"seq":2,"action":"done"}\n');
});

const invalid: Array<[string, string | Buffer]> = [
  ['empty EOF', ''],
  ['truncated frame', '{"next":"done","seq":1}'],
  ['wrong sequence', reply('done', 2)],
  ['zero sequence', reply('done', 0)],
  ['negative sequence', '{"next":"done","seq":-1}\n'],
  ['unsigned overflow', '{"next":"done","seq":18446744073709551617}\n'],
  ['unsafe integer', '{"next":"done","seq":9007199254740992}\n'],
  ['leading zero', '{"next":"done","seq":01}\n'],
  ['signed positive', '{"next":"done","seq":+1}\n'],
  ['fraction', '{"next":"done","seq":1.0}\n'],
  ['exponent', '{"next":"done","seq":1e0}\n'],
  ['unknown action', reply('unknown', 1)],
  ['long action', reply('modelmodel', 1)],
  ['duplicate sequence', '{"next":"done","seq":1,"seq":1}\n'],
  ['duplicate action', '{"next":"done","next":"done","seq":1}\n'],
  ['unknown field', '{"next":"done","seq":1,"extra":true}\n'],
  ['reordered fields', '{"seq":1,"next":"done"}\n'],
  ['noncanonical whitespace', '{"next": "done","seq":1}\n'],
  ['leading whitespace', ' {"next":"done","seq":1}\n'],
  ['trailing JSON', '{"next":"done","seq":1}{}\n'],
  ['CRLF', '{"next":"done","seq":1}\r\n'],
  ['NUL', Buffer.from('{"next":"done","seq":1}\0\n')],
  ['escaped action', '{"next":"do\\u006ee","seq":1}\n'],
  ['oversized terminated frame', 'x'.repeat(4097) + '\n'],
  ['oversized unterminated frame', 'x'.repeat(4098)],
];

for (const [name, input] of invalid)
  test.skipIf(!enabled)(`native macOS phase protocol rejects ${name}`, () => {
    const result = run(input);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('{"seq":1,"action":"model"}\n');
    expect(result.stderr).toBe('');
  });

test.skipIf(!enabled)('native macOS phase protocol refuses EOF instead of terminal ACK', () => {
  const result = run(reply('done', 1));
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(2);
  expect(result.stdout).toBe('{"seq":1,"action":"model"}\n{"seq":2,"action":"done"}\n');
});
