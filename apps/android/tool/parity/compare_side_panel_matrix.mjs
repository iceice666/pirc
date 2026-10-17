import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const fixtureDir = resolve(root, 'fixtures/mobile-parity');
const buildDir = resolve(root, 'apps/android/build/parity');
const matrix = JSON.parse(
  await readFile(resolve(fixtureDir, 'side-panel-matrix.json'), 'utf8'),
);
const web = JSON.parse(
  await readFile(resolve(fixtureDir, 'side-panel-matrix-expected.json'), 'utf8'),
);
const native = JSON.parse(
  await readFile(resolve(buildDir, 'side-panel-matrix-native.json'), 'utf8'),
);

function uniqueIndex(records, source) {
  const index = new Map();
  for (const record of records) {
    assert.ok(record?.id, `${source} record has no id`);
    assert.ok(!index.has(record.id), `${source} duplicate id: ${record.id}`);
    index.set(record.id, record);
  }
  return index;
}

function finite(value, label) {
  assert.ok(Number.isFinite(value), `${label} is not finite: ${value}`);
}

function rect(value, label) {
  assert.ok(value && typeof value === 'object', `${label} missing rect`);
  for (const key of ['x', 'y', 'width', 'height']) {
    finite(value[key], `${label}.${key}`);
  }
  assert.ok(value.width >= 0 && value.height >= 0, `${label} has negative size`);
  return value;
}

function rectDelta(source, target) {
  const delta = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    delta[key] = target[key] - source[key];
  }
  delta.maxAbs = Math.max(...Object.values(delta).map(Math.abs));
  return delta;
}

function cleanText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\uE000-\uF8FF\uFFFC]/g, ' ')
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function optionalTextEqual(left, right) {
  if (left == null || right == null) return left == null && right == null;
  return cleanText(left) === cleanText(right);
}

function threeWayMatch(left, right) {
  if (left == null || right == null) return 'unknown';
  return left === right ? 'match' : 'mismatch';
}

function optionalNumberEqual(left, right) {
  if (left == null || !Number.isFinite(right)) {
    return left == null && !Number.isFinite(right);
  }
  const number = Number(left);
  return Number.isFinite(number) && number === right;
}

assert.equal(optionalTextEqual(null, null), true, 'missing values should match only each other');
assert.equal(optionalTextEqual(null, ''), false, 'a missing value must differ from an empty value');
assert.equal(optionalTextEqual(null, 0), false, 'a missing value must differ from numeric zero');
assert.equal(optionalNumberEqual(null, Number.NaN), true, 'missing numeric values should match');
assert.equal(optionalNumberEqual(null, 0), false, 'missing numeric values must differ from zero');
assert.equal(optionalNumberEqual(0, null), false, 'zero must differ from a missing numeric value');
assert.equal(optionalNumberEqual(0, 0), true, 'equal numeric values should match');
assert.equal(optionalNumberEqual(null, 0), false, 'missing numeric value must differ from zero');
assert.equal(optionalNumberEqual(0, 0), true, 'numeric zero should match numeric zero');
assert.equal(threeWayMatch(null, 'button'), 'unknown', 'missing role should remain unknown');
assert.equal(threeWayMatch('button', 'link'), 'mismatch', 'known role differences should be reported');

function applyWebTextTransform(value, transform) {
  if (transform === 'uppercase') return value.toLocaleUpperCase('en-US');
  if (transform === 'lowercase') return value.toLocaleLowerCase('en-US');
  if (transform === 'capitalize') {
    return value.replace(/(^|\s)(\p{L})/gu, (_, prefix, letter) =>
      prefix + letter.toLocaleUpperCase('en-US'),
    );
  }
  return value;
}

function textIdentity(value) {
  return cleanText(value).toLocaleLowerCase('en-US');
}

function controlTextIdentity(value) {
  return cleanText(value)
    .replace(/([\p{Ll}\d])([\p{Lu}])/gu, '$1 $2')
    .replace(/\s*([·→])\s*/gu, '$1')
    .toLocaleLowerCase('en-US');
}

function union(rects) {
  if (!rects.length) return null;
  const left = Math.min(...rects.map((box) => box.x));
  const top = Math.min(...rects.map((box) => box.y));
  const right = Math.max(...rects.map((box) => box.x + box.width));
  const bottom = Math.max(...rects.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function textGeometry(source, target) {
  const webFragments = (source.visibleTextRuns ?? []).flatMap((run) =>
    (run.visibleTextRects ?? []).map((box) => ({
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    })),
  );
  const nativeFragments = (target.textRuns ?? []).flatMap((run) =>
    (run.visibleTextRects ?? []).map((box) => ({
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    })),
  );
  const webUnion = union(webFragments);
  const nativeUnion = union(nativeFragments);
  return {
    webViewportClippedDomRangeFragmentCount: webFragments.length,
    nativeViewportClippedFlutterSelectionFragmentCount: nativeFragments.length,
    webUnion,
    nativeUnion,
    unionDelta:
      webUnion && nativeUnion ? rectDelta(webUnion, nativeUnion) : null,
    measurementNote:
      'These compare actual Web DOM Range fragments and Flutter RenderParagraph/RenderEditable selection boxes after clipping to viewport, active pane, and discovered scroll viewports. The rectangle union remains diagnostic, not an equivalence guarantee.',
  };
}

function controlKey(control, source) {
  if (source === 'web') {
    return controlTextIdentity(
      control.ariaLabel ||
        control.title ||
        control.placeholder ||
        control.text,
    );
  }
  return controlTextIdentity(
    control.accessibleName ||
      control.tooltip ||
      control.placeholder ||
      control.label,
  );
}

function compareControls(source, target) {
  const allWebControls = source.controls ?? [];
  const allNativeControls = target.controls ?? [];
  const webControls = allWebControls.filter((control) => control.visibleRect);
  const nativeControls = allNativeControls.filter((control) => control.visibleRect);
  const available = nativeControls.map((control, index) => ({ control, index }));
  const pairs = [];
  const unmatchedWeb = [];
  for (const control of webControls) {
    const key = controlKey(control, 'web');
    let candidateIndex = available.findIndex(
      ({ control: nativeControl }) =>
        key && controlKey(nativeControl, 'native') === key,
    );
    let matchKind = 'exact-accessible-text';
    if (candidateIndex < 0) {
      const valueKey = textIdentity(control.value);
      if (valueKey) {
        candidateIndex = available.findIndex(
          ({ control: nativeControl }) =>
            textIdentity(nativeControl.value) === valueKey &&
            (control.type ?? '') ===
              (nativeControl.keyboardType?.replace('TextInputType.', '') ?? ''),
        );
        matchKind = 'value-and-input-type';
      }
    }
    if (candidateIndex < 0) {
      const looseKey = controlTextIdentity(control.text);
      if (looseKey) {
        candidateIndex = available.findIndex(({ control: nativeControl }) => {
          const nativeKey = controlTextIdentity(
            nativeControl.label || nativeControl.accessibleName ||
              nativeControl.tooltip || nativeControl.placeholder,
          );
          return (
            nativeKey &&
            (nativeKey.includes(looseKey) || looseKey.includes(nativeKey))
          );
        });
        matchKind = 'text-substring';
      }
    }
    if (
      candidateIndex < 0 &&
      control.tag === 'input'
    ) {
      const webRect = control.visibleRect;
      candidateIndex = available.findIndex(({ control: nativeControl }) => {
        if (nativeControl.widget !== 'TextField' || !webRect || !nativeControl.visibleRect) {
          return false;
        }
        const nativeRect = nativeControl.visibleRect;
        const overlapWidth = Math.max(
          0,
          Math.min(webRect.x + webRect.width, nativeRect.x + nativeRect.width) -
            Math.max(webRect.x, nativeRect.x),
        );
        const overlapHeight = Math.max(
          0,
          Math.min(webRect.y + webRect.height, nativeRect.y + nativeRect.height) -
            Math.max(webRect.y, nativeRect.y),
        );
        const overlap = overlapWidth * overlapHeight;
        const minArea = Math.min(
          webRect.width * webRect.height,
          nativeRect.width * nativeRect.height,
        );
        return minArea > 0 && overlap / minArea >= 0.75;
      });
      if (candidateIndex >= 0) matchKind = 'input-type-and-visible-geometry';
    }
    if (candidateIndex < 0) {
      unmatchedWeb.push({ key, control });
      continue;
    }
    const [{ control: nativeControl }] = available.splice(candidateIndex, 1);
    const sourceRect = rect(
      control.visibleRect,
      `Web visible control ${key || control.tag}`,
    );
    const targetRect = rect(
      nativeControl.visibleRect,
      `Native visible control ${key || nativeControl.widget}`,
    );
    pairs.push({
      key,
      matchKind,
      web: {
        tag: control.tag,
        role: control.role,
        text: control.text,
        ariaLabel: control.ariaLabel,
        title: control.title,
        placeholder: control.placeholder,
        value: control.value,
        disabled: control.disabled,
        effectiveDisabled: control.effectiveDisabled,
        selected: control.selected,
        style: control.style,
        rect: rect(control.rect, `Web control full rect ${key || control.tag}`),
        visibleRect: sourceRect,
      },
      native: {
        widget: nativeControl.widget,
        key: nativeControl.key,
        label: nativeControl.label,
        accessibleName: nativeControl.accessibleName,
        tooltip: nativeControl.tooltip,
        role: nativeControl.semanticsRole ?? null,
        selected: nativeControl.semanticsSelected ?? null,
        placeholder: nativeControl.placeholder,
        value: nativeControl.value,
        enabled: nativeControl.enabled,
        readOnly: nativeControl.readOnly,
        textStyle: nativeControl.textStyle,
        rect: rect(
          nativeControl.rect,
          `Native control full rect ${key || nativeControl.widget}`,
        ),
        visibleRect: targetRect,
      },
      visibleRectDelta: rectDelta(sourceRect, targetRect),
      fullRectDelta: rectDelta(
        rect(control.rect, `Web control full rect ${key || control.tag}`),
        rect(nativeControl.rect, `Native control full rect ${key || nativeControl.widget}`),
      ),
      enabledEqual:
        typeof control.disabled === 'boolean' &&
        typeof nativeControl.enabled === 'boolean'
          ? !control.disabled === nativeControl.enabled
          : null,
      placeholderEqual:
        optionalTextEqual(control.placeholder, nativeControl.placeholder),
      valueEqual:
        optionalTextEqual(control.value, nativeControl.value),
      roleMatch: threeWayMatch(control.role, nativeControl.semanticsRole),
      selectedMatch: threeWayMatch(
        control.selected == null ? null : control.selected === 'true',
        nativeControl.semanticsSelected,
      ),
    });
  }
  return {
    webCount: allWebControls.length,
    nativeCount: allNativeControls.length,
    webVisibleCount: webControls.length,
    nativeVisibleCount: nativeControls.length,
    webOutsideViewportOrClipCount: allWebControls.length - webControls.length,
    nativeOutsideViewportOrClipCount: allNativeControls.length - nativeControls.length,
    exactOrTextPairs: pairs.length,
    pairingMeaning:
      'Pairs use accessible text/identity and visible geometry; they do not establish complete role, state, or interaction equivalence. See roleMatch and selectedMatch on each pair; unknown means one side did not expose that semantic.',
    pairs,
    unmatchedWeb: unmatchedWeb.map(({ key, control }) => ({ key, control })),
    unmatchedNative: available.map(({ control }) => ({
      key: controlKey(control, 'native'),
      control,
    })),
  };
}

function compareIndicators(source, target) {
  const web = source.indicators ?? [];
  const native = target.indicators ?? [];
  const visibleWeb = web.filter((indicator) => indicator.visibleRect);
  const visibleNative = native.filter((indicator) => indicator.visibleRect);
  const available = [...visibleNative];
  const pairs = visibleWeb.map((indicator) => {
    const label = textIdentity(indicator.ariaLabel);
    const index = available.findIndex(
      (candidate) => textIdentity(candidate.semanticsLabel) === label,
    );
    const nativeIndicator = index < 0 ? null : available.splice(index, 1)[0];
    if (!nativeIndicator) return { web: indicator, native: null, match: false };
    const webRect = rect(indicator.visibleRect, 'Web indicator visible rect');
    const nativeRect = rect(nativeIndicator.visibleRect, 'Native indicator visible rect');
    const nativeValue = Number.parseFloat(
      String(nativeIndicator.semanticsValue ?? '').replace('%', ''),
    );
    return {
      web: indicator,
      native: nativeIndicator,
      visibleRectDelta: rectDelta(webRect, nativeRect),
      valueEqual: optionalNumberEqual(indicator.ariaValueNow, nativeValue),
      labelEqual: label === textIdentity(nativeIndicator.semanticsLabel),
      rangeEqual:
        String(indicator.ariaValueMin) === String(nativeIndicator.semanticsMinValue) &&
        String(indicator.ariaValueMax) === String(nativeIndicator.semanticsMaxValue),
    };
  });
  return {
    webCount: web.length,
    nativeCount: native.length,
    webVisibleCount: visibleWeb.length,
    nativeVisibleCount: visibleNative.length,
    pairs,
    unmatchedWeb: pairs.filter((pair) => !pair.native).map((pair) => pair.web),
    unmatchedNative: available,
  };
}

assert.equal(web.fixtureId, matrix.id, 'Web fixture ID mismatch');
assert.equal(native.fixtureId, matrix.id, 'Native fixture ID mismatch');
assert.equal(web.webRevision, matrix.webRevision, 'Web source revision mismatch');
assert.equal(native.webRevision, matrix.webRevision, 'Native source revision mismatch');
assert.equal(web.caseCount, web.cases.length, 'Web caseCount mismatch');
assert.equal(native.caseCount, native.cases.length, 'Native caseCount mismatch');

const expectedIds = [];
for (const width of matrix.widths) {
  for (const view of matrix.views) {
    for (const theme of matrix.themes) {
      for (const scale of matrix.textScales) {
        expectedIds.push(`${width}-${view}-${theme}-scale${scale}`);
      }
    }
  }
}
const expectedSet = new Set(expectedIds);
assert.equal(expectedSet.size, expectedIds.length, 'Matrix definition repeats IDs');
assert.equal(web.cases.length, expectedIds.length, 'Web matrix count mismatch');
assert.equal(native.cases.length, expectedIds.length, 'Native matrix count mismatch');
const webById = uniqueIndex(web.cases, 'Web');
const nativeById = uniqueIndex(native.cases, 'Native');
assert.deepEqual([...webById.keys()].sort(), [...expectedSet].sort(), 'Web manifest mismatch');
assert.deepEqual([...nativeById.keys()].sort(), [...expectedSet].sort(), 'Native manifest mismatch');

const rows = [];
for (const id of expectedIds) {
  const source = webById.get(id);
  const target = nativeById.get(id);
  assert.equal(source.config.width, target.config.width, `${id} width mismatch`);
  assert.equal(source.config.view, target.config.view, `${id} view mismatch`);
  assert.equal(source.config.theme, target.config.theme, `${id} theme mismatch`);
  assert.equal(source.config.scale, target.config.scale, `${id} scale mismatch`);
  assert.equal(source.config.height, target.config.height, `${id} height mismatch`);
  assert.deepEqual(source.fixtureErrors, [], `${id} Web fixture error`);
  assert.ok(source.activePanel.text.trim(), `${id} has no Web tab content`);
  assert.ok(target.textRuns.length, `${id} has no native text capture`);
  assert.ok(Array.isArray(source.visibleTextRuns), `${id} Web visible text runs missing`);
  assert.ok(target.textRuns.some((run) => Array.isArray(run.visibleTokens)), `${id} native visible token measurements missing`);
  assert.ok(target.visualParityAccepted === false, `${id} must remain unaccepted`);

  const webPanel = rect(source.panel.rect, `${id} Web panel`);
  const nativePanel = rect(target.panel, `${id} native panel`);
  const webTabs = rect(source.tablist.rect, `${id} Web tabs`);
  const nativeTabs = rect(target.tabs.rect, `${id} native tabs`);
  const webContent = rect(source.activePanel.rect, `${id} Web active panel`);
  const nativeContent = rect(target.activeContent.rect, `${id} native active content`);
  for (const [index, control] of (source.controls ?? []).entries()) {
    rect(control.rect, `${id} Web control ${index}`);
    if (control.visibleRect) rect(control.visibleRect, `${id} Web visible control ${index}`);
  }
  for (const [index, node] of (source.textNodes ?? []).entries()) {
    rect(node.rect, `${id} Web text node ${index}`);
    for (const [fragmentIndex, fragment] of (node.textRects ?? []).entries()) {
        rect(fragment, `${id} Web text node ${index} fragment ${fragmentIndex}`);
    }
  }
  for (const [index, run] of (source.visibleTextRuns ?? []).entries()) {
    assert.equal(typeof run.text, 'string', `${id} Web visible text token ${index} missing text`);
    for (const [fragmentIndex, fragment] of (run.visibleTextRects ?? []).entries()) {
      rect(fragment, `${id} Web visible token ${index} fragment ${fragmentIndex}`);
    }
  }
  for (const [index, control] of (target.controls ?? []).entries()) {
    rect(control.rect, `${id} native control ${index}`);
    if (control.visibleRect) rect(control.visibleRect, `${id} native visible control ${index}`);
  }
  for (const [index, node] of (target.textRuns ?? []).entries()) {
    rect(node.rect, `${id} native text run ${index}`);
    for (const [fragmentIndex, fragment] of (node.selectionBoxes ?? []).entries()) {
      for (const key of ['x', 'y', 'width', 'height']) {
        finite(fragment[key], `${id} native text run ${index} selection ${fragmentIndex}.${key}`);
      }
    }
  }
  const textWeb = cleanText(
    (source.visibleTextRuns ?? [])
      .map((run) => applyWebTextTransform(run.text, run.textTransform))
      .join(' '),
  );
  const textNative = cleanText(
    (target.textRuns ?? [])
      .flatMap((run) => (run.visibleTokens ?? []).map((token) => token.text))
      .join(' '),
  );
  const rawNativeText = cleanText(
    (target.textRuns ?? []).map((run) => run.text).join(' '),
  );
  const textComparison = {
    normalization:
      'NFKC; strip private-use icon glyphs, object-replacement markers and zero-width controls; collapse whitespace.',
    comparisonScope: 'viewport-visible, word-level Web DOM ranges and native Flutter selection boxes; a whole word is included if any part intersects all clipping rectangles.',
    visibleWebCharacters: textWeb.length,
    visibleNativeCharacters: textNative.length,
    rawWebDomInnerTextCharacters: cleanText(source.activePanel.text).length,
    rawNativeInstantiatedTextCharacters: rawNativeText.length,
    rawWebDomInnerText: source.activePanel.text,
    rawNativeInstantiatedText: (target.textRuns ?? []).map((run) => run.text).join(' '),
    exact: source.config.view === 'terminal' || source.config.view === 'browser'
      ? null
      : textWeb === textNative,
    firstDifference: null,
    webPreview: textWeb.slice(0, 500),
    nativePreview: textNative.slice(0, 500),
    note:
      source.config.view === 'terminal'
        ? 'The terminal body is canvas-rendered. Compare the actual xterm replay fixture payload separately; this text capture covers tab chrome/accessibility text.'
        : source.config.view === 'browser'
        ? 'The browser frame is image/canvas content. Compare captured browser state/log/frame payload separately; DOM and Flutter placeholder text remain visible-text diagnostics.'
        : 'Raw Web innerText and the Native instantiated widget text are diagnostics with different coverage. exact compares only word-level ranges with visible clipped geometry; CSS layout gaps between DOM nodes are not treated as missing literal spaces.',
  };
  if (textComparison.exact === false) {
    let index = 0;
    while (
      index < Math.min(textWeb.length, textNative.length) &&
      textWeb[index] === textNative[index]
    ) {
      index++;
    }
    textComparison.firstDifference = {
      index,
      web: textWeb.slice(Math.max(0, index - 90), index + 150),
      native: textNative.slice(Math.max(0, index - 90), index + 150),
    };
  }

  const webTabByLabel = new Map(
    source.tabs.map((tab) => [cleanText(tab.title || tab.label), tab]),
  );
  const nativeTabByLabel = new Map(target.tabs.items.map((tab) => [cleanText(tab.label), tab]));
  assert.equal(webTabByLabel.size, source.tabs.length, `${id} duplicate Web tab labels`);
  assert.equal(nativeTabByLabel.size, target.tabs.items.length, `${id} duplicate native tab labels`);
  assert.deepEqual(
    [...webTabByLabel.keys()].sort(),
    [...nativeTabByLabel.keys()].sort(),
    `${id} tab labels mismatch`,
  );
  const tabs = [...webTabByLabel].map(([label, webTab]) => {
    const nativeTab = nativeTabByLabel.get(label);
    const sourceRect = rect(webTab.rect, `${id} Web tab ${label}`);
    const targetRect = rect(nativeTab.rect, `${id} native tab ${label}`);
      return {
        label,
        roleMatch: threeWayMatch(webTab.role, nativeTab.semanticsRole),
        selectedEqual:
          (webTab.selected === 'true') === nativeTab.semanticsSelected,
        selectedMatch: threeWayMatch(
          webTab.selected == null ? null : webTab.selected === 'true',
          nativeTab.semanticsSelected,
        ),
        webRole: webTab.role ?? null,
        nativeRole: nativeTab.semanticsRole ?? null,
        webSelected: webTab.selected === 'true',
      nativeSelected: nativeTab.semanticsSelected,
      rectDelta: rectDelta(sourceRect, targetRect),
    };
  });
  assert.ok(tabs.every((tab) => tab.selectedEqual), `${id} selected tab semantics differ`);

  const canvasWeb = source.canvasContent;
  const canvasNative = target.canvasContent;
  const canvasComparison = {
    kind: source.config.view,
    presentOnBoth: Boolean(canvasWeb) && Boolean(canvasNative),
    comparisonScope:
      'Captured replay/state fixture payload equality only; screenshots and rendered canvas pixels are not compared.',
    payloadEqual:
      Boolean(canvasWeb) && Boolean(canvasNative)
        ? JSON.stringify(canvasWeb) === JSON.stringify(canvasNative)
        : null,
    web: canvasWeb,
    native: canvasNative,
  };
  if (['terminal', 'browser'].includes(source.config.view)) {
    assert.equal(canvasComparison.payloadEqual, true, `${id} canvas fixture payload differs`);
  }

  rows.push({
    id,
    config: source.config,
    geometry: {
      panel: rectDelta(webPanel, nativePanel),
      tablist: rectDelta(webTabs, nativeTabs),
      activeContent: rectDelta(webContent, nativeContent),
    },
    tabs,
    visibleText: textComparison,
    textGeometry: textGeometry(source, target),
    controls: compareControls(source, target),
    indicators: compareIndicators(source, target),
    api: {
      web: source.apiRequests.map((request) => ({
        method: request.method,
        path: request.path,
      })),
      native: target.apiRequests.map((request) => ({
        method: request.httpMethod,
        path: request.path,
      })),
      socketEventsWeb: source.socketEvents,
      socketRequestsNative: target.socketRequests,
    },
    canvasContent: canvasComparison,
    screenshots: {
      web: source.screenshot,
      native: target.screenshot,
    },
    visualParityAccepted: false,
  });
}

function maximumDelta(selector) {
  let max = { absolute: -1, id: null, field: null, signed: null };
  for (const row of rows) {
    const fields = selector(row);
    for (const [field, value] of Object.entries(fields)) {
      if (typeof value !== 'number') continue;
      if (Math.abs(value) > max.absolute) {
        max = { absolute: Math.abs(value), id: row.id, field, signed: value };
      }
    }
  }
  return max;
}

const summaryByView = Object.fromEntries(
  matrix.views.map((view) => {
    const selected = rows.filter((row) => row.config.view === view);
    const exactText = selected.filter((row) => row.visibleText.exact === true).length;
    const textMismatches = selected
      .filter((row) => row.visibleText.exact === false)
      .map((row) => ({ id: row.id, firstDifference: row.visibleText.firstDifference }));
    const tabRectMaximum = Math.max(
      0,
      ...selected.flatMap((row) =>
        row.tabs.map((tab) => tab.rectDelta.maxAbs),
      ),
    );
    const controlPairs = selected.reduce(
      (sum, row) => sum + row.controls.exactOrTextPairs,
      0,
    );
    const unmatchedWebControls = selected.reduce(
      (sum, row) => sum + row.controls.unmatchedWeb.length,
      0,
    );
    const unmatchedNativeControls = selected.reduce(
      (sum, row) => sum + row.controls.unmatchedNative.length,
      0,
    );
    const pairSemanticCounts = selected
      .flatMap((row) => row.controls.pairs)
      .reduce(
        (counts, pair) => {
          counts.roleMatch[pair.roleMatch]++;
          counts.selectedMatch[pair.selectedMatch]++;
          return counts;
        },
        {
          roleMatch: { match: 0, mismatch: 0, unknown: 0 },
          selectedMatch: { match: 0, mismatch: 0, unknown: 0 },
        },
      );
    const canvasFixturePayloadMatches = selected.filter(
      (row) => row.canvasContent.payloadEqual === true,
    ).length;
    return [
      view,
      {
        cases: selected.length,
        textExactCases: exactText,
        textMismatchCases: textMismatches.length,
        textMismatches: textMismatches.slice(0, 4),
        maxPanelDelta: maximumDeltaFor(selected, (row) => row.geometry.panel),
        maxTablistDelta: maximumDeltaFor(selected, (row) => row.geometry.tablist),
        maxActiveContentDelta: maximumDeltaFor(selected, (row) => row.geometry.activeContent),
        maxTabItemDelta: tabRectMaximum,
        controlPairs,
        pairSemanticCounts,
        unmatchedWebControls,
        unmatchedNativeControls,
        canvasFixturePayloadMatches,
      },
    ];
  }),
);

function maximumDeltaFor(selected, getDelta) {
  let max = { absolute: 0, id: null, field: null, signed: 0 };
  for (const row of selected) {
    const delta = getDelta(row);
    for (const field of ['x', 'y', 'width', 'height']) {
      if (Math.abs(delta[field]) > max.absolute) {
        max = {
          absolute: Math.abs(delta[field]),
          id: row.id,
          field,
          signed: delta[field],
        };
      }
    }
  }
  return max;
}

const output = {
  schemaVersion: 1,
  fixtureId: matrix.id,
  webRevision: matrix.webRevision,
  caseCount: rows.length,
  source: {
    webBrowser: web.browser,
    webRuntimeFonts: web.cases[0]?.runtimeFonts,
    nativeRuntimeFonts: native.cases[0]?.runtimeFonts,
    inputSources: {
      web: 'SidePanel.svelte + the actual tab child, mounted in a parity page using the pinned production CSS and existing fixture endpoints.',
      native: 'NativeSidePanel + actual WorkPanel child mounted under Flutter test with existing fixture gateway responses.',
    },
  },
  gates: {
    pinnedWebRevision: matrix.webRevision,
    exactSevenWidthThemeScaleTabManifest: true,
    allWebFixtureErrorsEmpty: true,
    allNativeCapturesNonempty: true,
    allSourceAndNativeGeometryFinite: true,
    visualParityAccepted: false,
    acceptanceNote:
      'This tool reports measurements and verifies corpus integrity. It does not accept visual parity; text, control, canvas, and font/rendering residuals require review.',
  },
  summaryByView,
  rows,
  globalMaximumPanelDelta: maximumDeltaFor(rows, (row) => row.geometry.panel),
  globalMaximumTablistDelta: maximumDeltaFor(rows, (row) => row.geometry.tablist),
  globalMaximumActiveContentDelta: maximumDeltaFor(rows, (row) => row.geometry.activeContent),
  visualParityAccepted: false,
};

const outputPath = resolve(buildDir, 'side-panel-matrix-comparison.json');
await mkdir(buildDir, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      output: outputPath,
      caseCount: rows.length,
      visualParityAccepted: false,
      summaryByView,
      globalMaximumPanelDelta: output.globalMaximumPanelDelta,
      globalMaximumTablistDelta: output.globalMaximumTablistDelta,
      globalMaximumActiveContentDelta: output.globalMaximumActiveContentDelta,
    },
    null,
    2,
  ),
);
