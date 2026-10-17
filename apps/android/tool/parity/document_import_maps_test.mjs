import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./document_import_maps_source.js', import.meta.url), 'utf8');
const origin = 'https://document.example/';
const mapBase = origin + 'import-map.json';
const warnings = () => {
  const entries = [];
  return {entries, diagnostic: (level, message) => entries.push({level, message})};
};
function create(options = {}) {
  const context = vm.createContext({URL});
  vm.runInContext(source + '\nglobalThis.createPircDocumentImportMaps = createPircDocumentImportMaps;', context);
  return context.createPircDocumentImportMaps({URL, ...options});
}

const map = value => JSON.stringify(value);

test('normalizes URL-like keys and addresses while retaining exact bare and custom-scheme mappings', () => {
  const diagnostics = warnings();
  const maps = create({diagnostic: diagnostics.diagnostic});
  maps.add(map({imports: {
    library: './vendor/library.js',
    './assets/main.js': '/static/main.js',
    '/assets/': '../static/assets/',
    'pirc-resource://bundle/mod.js': 'pirc-resource://mirror/bundle/mod.js',
    embedded: 'data:text/javascript,export%20default%201',
  }}), mapBase);

  assert.equal(maps.resolve('library', origin + 'src/main.js'), origin + 'vendor/library.js');
  assert.equal(maps.resolve('../assets/main.js', origin + 'src/main.js'), origin + 'static/main.js');
  assert.equal(maps.resolve('../assets/icon.svg', origin + 'src/main.js'), origin + 'static/assets/icon.svg');
  assert.equal(maps.resolve('pirc-resource://bundle/mod.js', origin + 'src/main.js'),
    'pirc-resource://mirror/bundle/mod.js');
  assert.equal(maps.resolve('embedded', origin + 'src/main.js'), 'data:text/javascript,export%20default%201');
  assert.deepEqual(diagnostics.entries, []);
});

test('uses the longest prefix, enforces slash boundaries, and rejects prefix backtracking', () => {
  const maps = create();
  maps.add(map({imports: {
    'pkg/': '/modules/base/',
    'pkg/sub/': '/modules/nested/',
    'pkg/sub': '/modules/exact.js',
    'safe/': '/modules/safe/',
  }}), mapBase);

  assert.equal(maps.resolve('pkg/sub/item.js', origin + 'main.js'), origin + 'modules/nested/item.js');
  assert.equal(maps.resolve('pkg/other.js', origin + 'main.js'), origin + 'modules/base/other.js');
  assert.equal(maps.resolve('pkg/sub', origin + 'main.js'), origin + 'modules/exact.js');
  assert.equal(maps.resolve('pkg/submarine/item.js', origin + 'main.js'), origin + 'modules/base/submarine/item.js');
  assert.throws(() => maps.resolve('safe/../outside.js', origin + 'main.js'), /backtracks above import map prefix/);
  assert.throws(() => maps.resolve('pkgx/item.js', origin + 'main.js'), /Bare module specifier/);
});

test('checks scoped maps from most to least specific, then global imports', () => {
  const maps = create();
  maps.add(map({
    imports: {shared: '/global/shared.js', globalOnly: '/global/only.js'},
    scopes: {
      '/app/': {shared: '/app/shared.js', appOnly: '/app/only.js'},
      '/app/vendor/': {vendorOnly: '/vendor/only.js'},
    },
  }), mapBase);

  assert.equal(maps.resolve('shared', origin + 'app/vendor/main.js'), origin + 'app/shared.js');
  assert.equal(maps.resolve('vendorOnly', origin + 'app/vendor/main.js'), origin + 'vendor/only.js');
  assert.equal(maps.resolve('appOnly', origin + 'app/vendor/main.js'), origin + 'app/only.js');
  assert.equal(maps.resolve('globalOnly', origin + 'app/vendor/main.js'), origin + 'global/only.js');
  assert.equal(maps.resolve('shared', origin + 'elsewhere/main.js'), origin + 'global/shared.js');
});

test('scope prefixes may be cross-origin and only match their own serialized URL prefix', () => {
  const maps = create();
  maps.add(map({scopes: {
    'https://cdn.example.test/packages/': {dep: 'https://cdn.example.test/vendor/dep.js'},
  }}), mapBase);

  assert.equal(maps.resolve('dep', 'https://cdn.example.test/packages/app/main.js'),
    'https://cdn.example.test/vendor/dep.js');
  assert.throws(() => maps.resolve('dep', 'https://other.example.test/packages/app/main.js'), /Bare module specifier/);
});

test('null and malformed targets block resolution without falling through to broader maps', () => {
  const diagnostics = warnings();
  const maps = create({diagnostic: diagnostics.diagnostic});
  maps.add(map({imports: {
    module: null,
    'blocked/fallback.js': '/fallback.js',
    'invalid/': 'relative-without-sigil',
    'slash/': '/must-end-in-slash',
    '/normalized-slash/.': '/must-also-end-in-slash',
    empty: '',
    '': '/ignored.js',
  }, scopes: {'/app/': {'blocked/': 9}}}), mapBase);
  maps.add(map({imports: {module: '/later/module.js', 'blocked/fallback.js': '/fallback.js'}}), mapBase);

  assert.throws(() => maps.resolve('module', origin + 'main.js'), /blocked by a null import map entry/);
  assert.throws(() => maps.resolve('blocked/fallback.js', origin + 'app/main.js'), /blocked by a null import map prefix/);
  assert.throws(() => maps.resolve('invalid/file.js', origin + 'main.js'), /blocked by a null import map prefix/);
  assert.throws(() => maps.resolve('slash/file.js', origin + 'main.js'), /blocked by a null import map prefix/);
  assert.throws(() => maps.resolve('/normalized-slash/file.js', origin + 'main.js'), /blocked by a null import map prefix/);
  assert.throws(() => maps.resolve('empty', origin + 'main.js'), /blocked by a null import map entry/);
  assert.ok(diagnostics.entries.length >= 5);
  assert.ok(diagnostics.entries.every(entry => entry.level === 'warning'));
});

test('rejects invalid top-level JSON structures but warns and ignores malformed entries', () => {
  const diagnostics = warnings();
  const maps = create({diagnostic: diagnostics.diagnostic});
  for (const invalid of ['null', '[]', '"not an object"', '{"imports":null}', '{"scopes":[]}', '{"scopes":{"/app/":null}}', '{"integrity":false}'])
    assert.throws(() => maps.add(invalid, mapBase), error => error?.name === 'TypeError', invalid);

  maps.add(map({unknown: true, scopes: {'http://[invalid/': {ignored: '/x.js'}, '/app/': {valid: '/app/valid.js'}}}), mapBase);
  assert.equal(maps.resolve('valid', origin + 'app/main.js'), origin + 'app/valid.js');
  assert.throws(() => maps.resolve('ignored', origin + 'main.js'), /Bare module specifier/);
  assert.ok(diagnostics.entries.some(entry => /unrecognized import map top-level key/.test(entry.message)));
  assert.ok(diagnostics.entries.some(entry => /scope prefix .* not a valid URL/.test(entry.message)));
});

test('normalizes integrity URL keys, ignores invalid entries, and keeps first metadata', () => {
  const diagnostics = warnings();
  const maps = create({diagnostic: diagnostics.diagnostic});
  maps.add(map({integrity: {
    './scripts/../scripts/app.js': 'sha384-first',
    'https://document.example/scripts/other.js': 'sha512-other',
    'bare/path.js': 'sha256-bare',
    './scripts/ignored.js': 7,
    './scripts/ignored-null.js': null,
  }}), mapBase);
  maps.add(map({integrity: {
    '/scripts/app.js': 'sha512-later',
    './scripts/new.js': 'sha256-new',
  }}), mapBase);

  assert.equal(maps.integrityFor(origin + 'scripts/../scripts/app.js'), 'sha384-first');
  assert.equal(maps.integrityFor(origin + 'scripts/other.js'), 'sha512-other');
  assert.equal(maps.integrityFor(origin + 'scripts/new.js'), 'sha256-new');
  assert.equal(maps.integrityFor(origin + 'scripts/ignored.js'), null);
  assert.equal(maps.integrityFor(origin + 'scripts/ignored-null.js'), null);
  assert.equal(maps.integrityFor('not a URL'), null);
  assert.ok(diagnostics.entries.some(entry => /integrity key .* not a valid URL-like URL/.test(entry.message)));
  assert.ok(diagnostics.entries.some(entry => /integrity metadata .* must be a string/.test(entry.message)));
  assert.ok(diagnostics.entries.some(entry => /first mapping wins/.test(entry.message)));
});

test('later maps add new keys but keep first mappings for duplicate normalized keys', () => {
  const diagnostics = warnings();
  const maps = create({diagnostic: diagnostics.diagnostic});
  maps.add(map({imports: {same: '/first.js', './alias.js': '/first-alias.js'}}), mapBase);
  maps.add(map({imports: {same: '/second.js', [origin + 'alias.js']: '/second-alias.js', later: '/later.js'}}), mapBase);

  assert.equal(maps.resolve('same', origin + 'main.js'), origin + 'first.js');
  assert.equal(maps.resolve('./alias.js', origin + 'main.js'), origin + 'first-alias.js');
  assert.equal(maps.resolve('later', origin + 'main.js'), origin + 'later.js');
  assert.ok(diagnostics.entries.some(entry => /first mapping wins/.test(entry.message)));
});

test('freezes mappings that could change already-resolved global and scoped graph entries', () => {
  const diagnostics = warnings();
  const maps = create({diagnostic: diagnostics.diagnostic});
  maps.add(map({
    imports: {'pkg/': '/v1/pkg/'},
    scopes: {'/app/': {dep: '/v1/dep.js'}},
  }), mapBase);

  assert.equal(maps.resolve('pkg/sub/entry.js', origin + 'first.js'), origin + 'v1/pkg/sub/entry.js');
  assert.equal(maps.resolve('dep', origin + 'app/first.js'), origin + 'v1/dep.js');
  assert.equal(maps.resolve('dep', origin + 'app/nested/first.js'), origin + 'v1/dep.js');
  maps.add(map({
    imports: {'pkg/sub/': '/v2/pkg/sub/', 'pkg/sub/entry.js': '/v2/exact.js', untouched: '/new.js'},
    scopes: {'/app/': {dep: '/v2/dep.js'}, '/app/nested/': {dep: '/v3/dep.js'}},
  }), mapBase);

  // The exact rule is pruned for the resolved record, while the current global
  // merge algorithm retains the shorter prefix rule. The original pair stays cached.
  assert.equal(maps.resolve('pkg/sub/entry.js', origin + 'first.js'), origin + 'v1/pkg/sub/entry.js');
  assert.equal(maps.resolve('pkg/sub/entry.js', origin + 'second.js'), origin + 'v2/pkg/sub/entry.js');
  assert.equal(maps.resolve('dep', origin + 'app/second.js'), origin + 'v1/dep.js');
  // Unrelated entries from the later map remain usable.
  assert.equal(maps.resolve('untouched', origin + 'second.js'), origin + 'new.js');
  // The new nested scope was also blocked for the already-resolved scoped key.
  assert.equal(maps.resolve('dep', origin + 'app/nested/second.js'), origin + 'v1/dep.js');
  assert.ok(diagnostics.entries.some(entry => /already-resolved module/.test(entry.message)));
});

test('failed bare resolutions are not frozen and can be mapped by a later import map', () => {
  const maps = create();
  assert.throws(() => maps.resolve('later', origin + 'main.js'), /Bare module specifier/);
  maps.add(map({imports: {later: '/later.js'}}), mapBase);
  assert.equal(maps.resolve('later', origin + 'main.js'), origin + 'later.js');
});

test('URL-like prefix maps do not capture non-special custom-scheme URL prefixes', () => {
  const maps = create();
  maps.add(map({imports: {'pirc-resource://bundle/': 'pirc-resource://mapped/'}}), mapBase);
  assert.equal(maps.resolve('pirc-resource://bundle/file.js', origin + 'main.js'), 'pirc-resource://bundle/file.js');
});
