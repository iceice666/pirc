import { expect, test } from 'bun:test';
import { parseCpuUsec, parseMemoryBytes, unifiedCgroup } from './ptc-m1/resources.js';

test('cgroup parsers reject missing, duplicate, unsafe and malformed measurements', () => {
  expect(parseCpuUsec('usage_usec 12345\nuser_usec 10000\nsystem_usec 2345\n')).toBe(12345);
  expect(parseMemoryBytes('1048576\n')).toBe(1048576);
  expect(unifiedCgroup('0::/user.slice/fixture.service\n')).toBe('/user.slice/fixture.service');
  for (const value of [
    '',
    'user_usec 1',
    'usage_usec -1',
    'usage_usec 1\nusage_usec 2',
    'usage_usec 1.5',
    'usage_usec 9007199254740992',
  ])
    expect(() => parseCpuUsec(value)).toThrow();
  for (const value of ['', '0', '-1', '1.5', 'Infinity', '9007199254740992', '10\n20'])
    expect(() => parseMemoryBytes(value)).toThrow();
  for (const value of ['', '0::/', '0::/../x', '1:cpu:/x', '0::/x\n0::/y'])
    expect(() => unifiedCgroup(value)).toThrow();
});
