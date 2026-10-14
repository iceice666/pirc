import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { copyNotices } from '../release-notices.js';

test('retains nested QuickJS and other vendored notices without source code', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pirc-notices-'));
  try {
    const vendor = path.join(root, 'vendor');
    const out = path.join(root, 'notices');
    const quickjs = path.join(vendor, 'rquickjs-sys', 'quickjs');
    mkdirSync(quickjs, { recursive: true });
    writeFileSync(path.join(quickjs, 'LICENSE'), 'QuickJS MIT notice');
    writeFileSync(path.join(quickjs, 'quickjs.c'), 'not shipped');
    copyNotices(vendor, out);
    expect(readFileSync(path.join(out, 'rquickjs-sys/quickjs/LICENSE'), 'utf8')).toBe(
      'QuickJS MIT notice',
    );
    expect(existsSync(path.join(out, 'rquickjs-sys/quickjs/quickjs.c'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
