import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  transformScrollModes,
  transformScrollHTML,
  buildTransformScrollDriver,
} from './document_transform_scroll_fixture.mjs';
test('128 independent transform scroll profiles preserve sources, clipping pixels and offset parents', () => {
  const f = JSON.parse(
    readFileSync(new URL('./fixtures/document-transform-scroll-chromium153.json', import.meta.url)),
  );
  assert.equal(f.browserVersion, '153.0.8010.12');
  assert.equal(f.cases.length, 128);
  assert.equal(transformScrollModes.length, 16);
  assert.equal(
    new Set(f.cases.map((r) => [r.mode, r.viewport.width, r.dpr, r.theme].join('/'))).size,
    128,
  );
  let clipped = 0,
    visible = 0;
  for (const r of f.cases) {
    assert.equal(r.html, transformScrollHTML(r.mode));
    assert.equal(r.driverSource, buildTransformScrollDriver());
    for (const phase of ['before', 'scrolled', 'changed']) {
      const state = r.result[phase];
      assert.equal(state.boxes.target.offset.parentId, 'host');
      for (const k of ['left', 'top', 'width', 'height', 'clientWidth', 'clientHeight'])
        assert.ok(Number.isInteger(state[k]));
    }
    for (const sample of Object.values(r.pixels)) {
      assert.equal(sample.rgba.length, 4);
      if (sample.hit === 'target') visible++;
      else clipped++;
    }
  }
  assert.ok(clipped > 0);
  assert.ok(visible > 0);
});
