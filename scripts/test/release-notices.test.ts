import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { copyNotices, copyProjectLicense } from '../release-notices.js';

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

test('native and standalone web staging retain the project license and dependency terms', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pirc-release-license-'));
  try {
    const source = path.join(root, 'source');
    const vendor = path.join(source, 'vendor', 'dependency');
    mkdirSync(vendor, { recursive: true });
    const license = readFileSync(new URL('../../LICENSE', import.meta.url), 'utf8');
    writeFileSync(path.join(source, 'LICENSE'), license);
    writeFileSync(path.join(vendor, 'LICENSE'), 'Dependency license remains separate');
    for (const name of ['native', 'web']) {
      const stage = path.join(root, name);
      copyProjectLicense(source, stage);
      copyNotices(path.join(source, 'vendor'), path.join(stage, 'third-party-notices'));
      expect(readFileSync(path.join(stage, 'LICENSE'), 'utf8')).toBe(license);
      expect(readFileSync(path.join(stage, 'third-party-notices/dependency/LICENSE'), 'utf8')).toBe(
        'Dependency license remains separate',
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing project license prevents staging an apparently licensed archive', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pirc-release-license-'));
  try {
    expect(() => copyProjectLicense(root, path.join(root, 'stage'))).toThrow();
    expect(existsSync(path.join(root, 'stage'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
