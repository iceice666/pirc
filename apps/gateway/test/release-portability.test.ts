import { expect, test } from 'bun:test';
import { assertAppleDependencies } from '../../../scripts/release-portability.js';
test('release dependency gate admits only Apple libraries and the inspected dylib own ID', () => {
  const header = '/build/pirc-worker:\n';
  expect(() =>
    assertAppleDependencies(
      header + '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n',
    ),
  ).not.toThrow();
  for (const dependency of [
    '/opt/homebrew/lib/libfoo.dylib',
    '/usr/local/lib/foo.dylib',
    '/Users/private/libfoo.dylib',
    '/nix/store/libfoo',
    '@rpath/libfoo.dylib',
    '/usr/lib/../../private/foo',
  ])
    expect(() =>
      assertAppleDependencies(header + `\t${dependency} (compatibility version 1.0.0)\n`),
    ).toThrow('unshipped');
  const own = '/build/pirc-worker-inspection.dylib';
  expect(() =>
    assertAppleDependencies(
      header +
        `\t${own} (compatibility version 0.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n`,
      own,
    ),
  ).not.toThrow();
  expect(() =>
    assertAppleDependencies(
      header +
        `\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n\t${own} (compatibility version 0.0.0)\n`,
      own,
    ),
  ).toThrow('unshipped');
});
