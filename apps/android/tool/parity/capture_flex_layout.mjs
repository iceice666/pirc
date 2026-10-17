import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireTestBrowserExecutable } from './test_browser.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../../..');
const outputPath = path.join(repositoryRoot, 'fixtures/mobile-parity/html-flex-layout.json');
const requireFromGateway = createRequire(path.join(repositoryRoot, 'apps/gateway/package.json'));
const { chromium } = requireFromGateway('playwright-core');
const executablePath = requireTestBrowserExecutable(process.env.PIRC_TEST_BROWSER);
const fixedWebBaselineCommit = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const colors = ['#ef4444', '#22c55e', '#3b82f6', '#f59e0b', '#a855f7', '#14b8a6'];

function itemStyles(...styles) {
  return styles.map((style, index) => ({
    display: 'block',
    margin: '0',
    padding: '0',
    border: '0 solid transparent',
    'box-sizing': 'content-box',
    height: '20px',
    'background-color': colors[index % colors.length],
    ...style,
  }));
}

function makeCase({
  id,
  description,
  width,
  height = null,
  direction = 'ltr',
  viewport = { width: 1200, height: 1000 },
  containerOverrides = {},
  items,
  mediaCss = '',
  itemContents = null,
}) {
  const containerStyle = {
    display: 'flex',
    width: `${width}px`,
    margin: '0',
    padding: '0',
    border: '0 solid transparent',
    'box-sizing': 'content-box',
    direction,
    'flex-direction': 'row',
    'flex-wrap': 'nowrap',
    'justify-content': 'flex-start',
    'align-items': 'stretch',
    'align-content': 'normal',
    'row-gap': '0px',
    'column-gap': '0px',
    ...containerOverrides,
  };
  if (height !== null) containerStyle.height = `${height}px`;

  return {
    id,
    description,
    viewport,
    width,
    height,
    direction,
    containerStyle,
    itemStyles: items,
    ...(itemContents === null ? {} : { itemContents }),
    mediaCss,
  };
}

const cases = [
  makeCase({
    id: 'row-flex-one-each',
    description: 'Three flex: 1 items divide a 360px row equally.',
    width: 360,
    items: itemStyles({ flex: '1' }, { flex: '1' }, { flex: '1' }),
  }),
  makeCase({
    id: 'row-weighted-grow',
    description: 'Positive free space is distributed by grow factors 1, 2, and 3.',
    width: 410,
    containerOverrides: { 'column-gap': '10px' },
    items: itemStyles(
      { flex: '1 1 0px' },
      { flex: '2 1 0px' },
      { flex: '3 1 0px' },
    ),
  }),
  makeCase({
    id: 'row-grow-from-pixel-bases',
    description: 'Positive free space is distributed after pixel flex bases.',
    width: 420,
    containerOverrides: { 'column-gap': '10px' },
    items: itemStyles(
      { flex: '1 1 40px' },
      { flex: '2 1 60px' },
      { flex: '1 1 80px' },
    ),
  }),
  makeCase({
    id: 'row-grow-from-percentage-bases',
    description: 'Percentage flex bases resolve against the inner row width before growing.',
    width: 400,
    items: itemStyles(
      { flex: '1 1 10%' },
      { flex: '1 1 20%' },
      { flex: '1 1 30%' },
    ),
  }),
  makeCase({
    id: 'row-pixel-flex-bases-without-grow',
    description: 'Fixed pixel flex bases leave positive free space at the main end.',
    width: 420,
    items: itemStyles(
      { flex: '0 0 80px' },
      { flex: '0 0 120px' },
      { flex: '0 0 100px' },
    ),
  }),
  makeCase({
    id: 'row-percentage-flex-bases-without-grow',
    description: 'Fixed percentage flex bases are sized from the inner row width.',
    width: 400,
    items: itemStyles(
      { flex: '0 0 20%' },
      { flex: '0 0 30%' },
      { flex: '0 0 10%' },
    ),
  }),
  makeCase({
    id: 'row-equal-shrink-pixel-bases',
    description: 'Equal shrink factors reduce three 180px bases into a 420px row.',
    width: 420,
    items: itemStyles(
      { flex: '0 1 180px' },
      { flex: '0 1 180px' },
      { flex: '0 1 180px' },
    ),
  }),
  makeCase({
    id: 'row-weighted-shrink-pixel-bases',
    description: 'Shrink factors weight the scaled flex-base loss at 1, 2, and 3.',
    width: 300,
    items: itemStyles(
      { flex: '0 1 180px' },
      { flex: '0 2 120px' },
      { flex: '0 3 100px' },
    ),
  }),
  makeCase({
    id: 'row-shrink-zero-overflow',
    description: 'Zero shrink factors keep three 120px items wider than their row.',
    width: 300,
    items: itemStyles(
      { flex: '0 0 120px' },
      { flex: '0 0 120px' },
      { flex: '0 0 120px' },
    ),
  }),
  makeCase({
    id: 'row-min-width-freeze-redistributes',
    description: 'A minimum width freezes one item and redistributes remaining free space.',
    width: 240,
    items: itemStyles(
      { flex: '1 1 0px', 'min-width': '160px' },
      { flex: '1 1 0px' },
      { flex: '1 1 0px' },
    ),
  }),
  makeCase({
    id: 'row-max-width-freeze-redistributes',
    description: 'A maximum width freezes one growing item and redistributes remaining free space.',
    width: 300,
    items: itemStyles(
      { flex: '1 1 0px', 'max-width': '50px' },
      { flex: '1 1 0px' },
      { flex: '1 1 0px' },
    ),
  }),
  makeCase({
    id: 'row-min-max-freeze-refreeze',
    description: 'Minimum and maximum violations freeze separate items before the third is refilled.',
    width: 300,
    items: itemStyles(
      { flex: '1 1 0px', 'min-width': '120px' },
      { flex: '1 1 0px', 'max-width': '40px' },
      { flex: '1 1 0px' },
    ),
  }),
  makeCase({
    id: 'wrapped-row-column-and-row-gaps',
    description: 'Column gap separates items within lines and row gap separates three wrapped lines.',
    width: 230,
    containerOverrides: {
      'flex-wrap': 'wrap',
      'column-gap': '10px',
      'row-gap': '20px',
    },
    items: itemStyles(
      { flex: '0 0 100px', height: '30px' },
      { flex: '0 0 100px', height: '30px' },
      { flex: '0 0 100px', height: '30px' },
      { flex: '0 0 100px', height: '30px' },
      { flex: '0 0 100px', height: '30px' },
    ),
  }),
  makeCase({
    id: 'wrapped-row-gap-without-column-gap',
    description: 'Only row gap is present between two rows; items within each row touch.',
    width: 220,
    containerOverrides: { 'flex-wrap': 'wrap', 'row-gap': '18px' },
    items: itemStyles(
      { flex: '0 0 110px', height: '24px' },
      { flex: '0 0 110px', height: '24px' },
      { flex: '0 0 110px', height: '24px' },
      { flex: '0 0 110px', height: '24px' },
    ),
  }),
  makeCase({
    id: 'row-wrap-two-lines',
    description: 'Four fixed-width boxes wrap into two rows at the available width.',
    width: 250,
    containerOverrides: { 'flex-wrap': 'wrap', 'column-gap': '10px' },
    items: itemStyles(
      { flex: '0 0 120px', height: '28px' },
      { flex: '0 0 120px', height: '28px' },
      { flex: '0 0 120px', height: '28px' },
      { flex: '0 0 120px', height: '28px' },
    ),
  }),
  makeCase({
    id: 'row-wrap-reverse-definite-cross-size',
    description: 'Three wrapped lines are stacked from the cross-end in a definite-height container.',
    width: 220,
    height: 130,
    containerOverrides: {
      'flex-wrap': 'wrap-reverse',
      'column-gap': '10px',
      'row-gap': '10px',
      'align-content': 'flex-start',
    },
    items: itemStyles(
      { flex: '0 0 100px', height: '30px' },
      { flex: '0 0 100px', height: '30px' },
      { flex: '0 0 100px', height: '30px' },
      { flex: '0 0 100px', height: '30px' },
      { flex: '0 0 100px', height: '30px' },
    ),
  }),
  makeCase({
    id: 'row-reverse-ltr',
    description: 'A row-reverse container lays out items from its right main-start.',
    width: 320,
    containerOverrides: { 'flex-direction': 'row-reverse' },
    items: itemStyles(
      { flex: '0 0 60px', height: '24px' },
      { flex: '0 0 80px', height: '24px' },
      { flex: '0 0 40px', height: '24px' },
    ),
  }),
  makeCase({
    id: 'row-rtl',
    description: 'An RTL row lays out its first item from the right main-start.',
    width: 320,
    direction: 'rtl',
    items: itemStyles(
      { flex: '0 0 60px', height: '24px' },
      { flex: '0 0 80px', height: '24px' },
      { flex: '0 0 40px', height: '24px' },
    ),
  }),
  makeCase({
    id: 'row-reverse-rtl',
    description: 'RTL direction and row-reverse both affect the resolved main-start.',
    width: 320,
    direction: 'rtl',
    containerOverrides: { 'flex-direction': 'row-reverse' },
    items: itemStyles(
      { flex: '0 0 60px', height: '24px' },
      { flex: '0 0 80px', height: '24px' },
      { flex: '0 0 40px', height: '24px' },
    ),
  }),
  makeCase({
    id: 'column-fixed-height-equal-grow',
    description: 'Three flex: 1 items share a definite 300px column height.',
    width: 180,
    height: 300,
    containerOverrides: { 'flex-direction': 'column' },
    items: itemStyles(
      { flex: '1', width: '80px' },
      { flex: '1', width: '80px' },
      { flex: '1', width: '80px' },
    ),
  }),
  makeCase({
    id: 'column-fixed-height-weighted-grow-with-gap',
    description: 'Column grow factors 1 and 2 share free height after a 12px row gap.',
    width: 180,
    height: 300,
    containerOverrides: {
      'flex-direction': 'column',
      'row-gap': '12px',
    },
    items: itemStyles(
      { flex: '1 1 40px', width: '90px' },
      { flex: '2 1 60px', width: '90px' },
    ),
  }),
  makeCase({
    id: 'column-natural-height-fixed-items',
    description: 'An auto-height column keeps explicit item heights and grows to their sum.',
    width: 180,
    containerOverrides: { 'flex-direction': 'column', 'align-items': 'flex-start' },
    items: itemStyles(
      { flex: '0 0 auto', width: '80px', height: '24px' },
      { flex: '0 0 auto', width: '110px', height: '48px' },
      { flex: '0 0 auto', width: '60px', height: '32px' },
    ),
  }),
  makeCase({
    id: 'column-natural-height-auto-basis',
    description: 'An auto-height column with auto bases preserves the explicit natural heights.',
    width: 180,
    containerOverrides: { 'flex-direction': 'column', 'align-items': 'flex-start' },
    items: itemStyles(
      { flex: '0 1 auto', width: '80px', height: '35px' },
      { flex: '0 1 auto', width: '80px', height: '55px' },
    ),
  }),
  makeCase({
    id: 'column-reverse',
    description: 'A column-reverse container lays out boxes from its bottom main-start.',
    width: 180,
    height: 180,
    containerOverrides: { 'flex-direction': 'column-reverse', 'align-items': 'flex-start' },
    items: itemStyles(
      { flex: '0 0 40px', width: '50px' },
      { flex: '0 0 60px', width: '80px' },
      { flex: '0 0 30px', width: '110px' },
    ),
  }),
];

for (const [id, justifyContent] of [
  ['justify-flex-start', 'flex-start'],
  ['justify-flex-end', 'flex-end'],
  ['justify-center', 'center'],
  ['justify-space-between', 'space-between'],
  ['justify-space-around', 'space-around'],
  ['justify-space-evenly', 'space-evenly'],
]) {
  cases.push(
    makeCase({
      id,
      description: `Positive main-axis free space with justify-content: ${justifyContent}.`,
      width: 300,
      containerOverrides: { 'justify-content': justifyContent },
      items: itemStyles(
        { flex: '0 0 50px', height: '24px' },
        { flex: '0 0 50px', height: '24px' },
        { flex: '0 0 50px', height: '24px' },
      ),
    }),
  );
}

for (const [id, justifyContent] of [
  ['justify-overflow-space-between-fallback', 'space-between'],
  ['justify-overflow-space-around-fallback', 'space-around'],
  ['justify-overflow-space-evenly-fallback', 'space-evenly'],
  ['justify-overflow-center', 'center'],
]) {
  cases.push(
    makeCase({
      id,
      description: `Negative main-axis free space with justify-content: ${justifyContent}.`,
      width: 300,
      containerOverrides: { 'justify-content': justifyContent },
      items: itemStyles(
        { flex: '0 0 120px', height: '24px' },
        { flex: '0 0 120px', height: '24px' },
        { flex: '0 0 120px', height: '24px' },
      ),
    }),
  );
}

cases.push(
  makeCase({
    id: 'align-items-center-definite-height',
    description: 'Different item heights are centered in a definite-height row.',
    width: 300,
    height: 120,
    containerOverrides: { 'align-items': 'center' },
    items: itemStyles(
      { flex: '0 0 60px', height: '20px' },
      { flex: '0 0 60px', height: '50px' },
      { flex: '0 0 60px', height: '30px' },
    ),
  }),
  makeCase({
    id: 'align-items-flex-end-definite-height',
    description: 'Different item heights align to the cross-end of a definite-height row.',
    width: 300,
    height: 120,
    containerOverrides: { 'align-items': 'flex-end' },
    items: itemStyles(
      { flex: '0 0 60px', height: '20px' },
      { flex: '0 0 60px', height: '50px' },
      { flex: '0 0 60px', height: '30px' },
    ),
  }),
  makeCase({
    id: 'align-items-stretch-definite-height',
    description: 'Auto-height items stretch to the definite row cross size.',
    width: 300,
    height: 120,
    containerOverrides: { 'align-items': 'stretch' },
    items: itemStyles(
      { flex: '0 0 60px', height: 'auto' },
      { flex: '0 0 60px', height: 'auto' },
      { flex: '0 0 60px', height: 'auto' },
    ),
  }),
  makeCase({
    id: 'align-items-nonstretch-preserves-explicit-height',
    description: 'Center alignment does not stretch items with explicit heights.',
    width: 300,
    height: 120,
    containerOverrides: { 'align-items': 'center' },
    items: itemStyles(
      { flex: '0 0 60px', height: '20px' },
      { flex: '0 0 60px', height: '40px' },
    ),
  }),
  makeCase({
    id: 'align-self-overrides-container',
    description: 'The middle item overrides container stretch with align-self: flex-end.',
    width: 300,
    height: 100,
    items: itemStyles(
      { flex: '0 0 60px', height: 'auto' },
      { flex: '0 0 60px', 'align-self': 'flex-end', height: '25px' },
      { flex: '0 0 60px', height: 'auto' },
    ),
  }),
);

for (const [id, alignContent] of [
  ['align-content-stretch', 'stretch'],
  ['align-content-center', 'center'],
  ['align-content-space-between', 'space-between'],
]) {
  cases.push(
    makeCase({
      id,
      description: `Two flex lines use align-content: ${alignContent} in a definite-height container.`,
      width: 220,
      height: 180,
      containerOverrides: {
        'flex-wrap': 'wrap',
        'column-gap': '10px',
        'align-content': alignContent,
      },
      items: itemStyles(
        { flex: '0 0 100px', height: '30px' },
        { flex: '0 0 100px', height: '30px' },
        { flex: '0 0 100px', height: '30px' },
        { flex: '0 0 100px', height: '30px' },
      ),
    }),
  );
}

cases.push(
  makeCase({
    id: 'gap-shorthand-wrapped-rows',
    description: 'The two-value gap shorthand sets 8px row gaps and 12px column gaps.',
    width: 250,
    containerOverrides: { 'flex-wrap': 'wrap', gap: '8px 12px' },
    items: itemStyles(
      { flex: '0 0 110px', height: '24px' },
      { flex: '0 0 110px', height: '24px' },
      { flex: '0 0 110px', height: '24px' },
      { flex: '0 0 110px', height: '24px' },
    ),
  }),
  makeCase({
    id: 'flex-flow-row-wrap-shorthand',
    description: 'The flex-flow shorthand sets row direction and wrapping together.',
    width: 200,
    containerOverrides: { 'flex-flow': 'row wrap', 'row-gap': '8px', 'column-gap': '12px' },
    items: itemStyles(
      { flex: '0 0 90px', height: '26px' },
      { flex: '0 0 90px', height: '26px' },
      { flex: '0 0 90px', height: '26px' },
    ),
  }),
  makeCase({
    id: 'flex-flow-column-reverse-shorthand',
    description: 'The flex-flow shorthand sets a reversed column main axis.',
    width: 180,
    height: 180,
    containerOverrides: { 'flex-flow': 'column-reverse nowrap', 'align-items': 'flex-start' },
    items: itemStyles(
      { flex: '0 0 40px', width: '50px' },
      { flex: '0 0 60px', width: '80px' },
      { flex: '0 0 30px', width: '110px' },
    ),
  }),
  makeCase({
    id: 'row-fractional-grow-sum-below-one',
    description: 'Grow factors totaling 0.4 consume only 40 percent of positive free space.',
    width: 400,
    items: itemStyles(
      { flex: '0.2 1 0px' },
      { flex: '0.2 1 0px' },
    ),
  }),
  makeCase({
    id: 'row-fractional-shrink-sum-below-one',
    description: 'Shrink factors totaling 0.4 consume only 40 percent of negative free space.',
    width: 300,
    items: itemStyles(
      { flex: '0 0.2 200px' },
      { flex: '0 0.2 200px' },
    ),
  }),
  makeCase({
    id: 'column-wrap-fixed-height',
    description: 'A fixed-height column wraps its fifth item into a third column.',
    width: 300,
    height: 220,
    containerOverrides: {
      'flex-flow': 'column wrap',
      'align-items': 'flex-start',
      'column-gap': '16px',
    },
    items: itemStyles(
      { flex: '0 0 100px', width: '40px' },
      { flex: '0 0 100px', width: '40px' },
      { flex: '0 0 100px', width: '40px' },
      { flex: '0 0 100px', width: '40px' },
      { flex: '0 0 100px', width: '40px' },
    ),
  }),
  makeCase({
    id: 'column-wrap-fixed-height-rtl',
    description: 'RTL direction places column-wrap lines from the cross-end across a fixed-width container.',
    width: 300,
    height: 220,
    direction: 'rtl',
    containerOverrides: {
      'flex-flow': 'column wrap',
      'align-items': 'flex-start',
      'column-gap': '16px',
    },
    items: itemStyles(
      { flex: '0 0 100px', width: '40px' },
      { flex: '0 0 100px', width: '40px' },
      { flex: '0 0 100px', width: '40px' },
      { flex: '0 0 100px', width: '40px' },
      { flex: '0 0 100px', width: '40px' },
    ),
  }),
  makeCase({
    id: 'item-border-box-flex-basis',
    description: 'A 100px flex basis includes item padding and borders under border-box sizing.',
    width: 240,
    containerOverrides: { 'column-gap': '12px' },
    items: itemStyles(
      {
        flex: '0 0 100px',
        height: '24px',
        'box-sizing': 'border-box',
        padding: '5px',
        border: '2px solid transparent',
      },
      {
        flex: '0 0 100px',
        height: '24px',
        'box-sizing': 'border-box',
        padding: '5px',
        border: '2px solid transparent',
      },
    ),
  }),
  makeCase({
    id: 'container-border-box-padding-border',
    description: 'A 320px border-box container includes its padding and border in its declared width.',
    width: 320,
    height: 100,
    containerOverrides: {
      'box-sizing': 'border-box',
      padding: '10px 12px',
      border: '3px solid transparent',
      'column-gap': '10px',
    },
    items: itemStyles(
      { flex: '0 0 80px', height: '30px' },
      { flex: '0 0 80px', height: '30px' },
    ),
  }),
  makeCase({
    id: 'align-stretch-min-max-cross-size',
    description: 'Stretch alignment is clamped by a maximum cross size and a separate minimum cross size.',
    width: 280,
    height: 120,
    containerOverrides: { 'align-items': 'stretch' },
    items: itemStyles(
      { flex: '0 0 80px', height: 'auto', 'max-height': '70px' },
      { flex: '0 0 80px', height: 'auto', 'min-height': '140px' },
    ),
  }),
);

cases.push(
  makeCase({
    id: 'hidden-child-does-not-participate',
    description: 'A display:none box remains in the authored child list but occupies no flex space.',
    width: 300,
    containerOverrides: { 'column-gap': '10px' },
    items: itemStyles(
      { flex: '0 0 80px', height: '24px' },
      { flex: '0 0 80px', height: '24px', display: 'none' },
      { flex: '0 0 80px', height: '24px' },
    ),
  }),
  makeCase({
    id: 'container-content-box-padding-border',
    description: 'The declared container size is content-box and padding and border offset its children.',
    width: 280,
    height: 70,
    containerOverrides: {
      padding: '10px 12px',
      border: '3px solid transparent',
      'column-gap': '10px',
    },
    items: itemStyles(
      { flex: '0 0 80px', height: '30px' },
      { flex: '0 0 80px', height: '30px' },
    ),
  }),
  makeCase({
    id: 'item-content-box-padding-border',
    description: 'Pixel flex bases use content boxes while padding and borders enlarge outer item rects.',
    width: 240,
    containerOverrides: { 'column-gap': '12px' },
    items: itemStyles(
      {
        flex: '0 0 100px',
        height: '24px',
        padding: '5px',
        border: '2px solid transparent',
      },
      {
        flex: '0 0 100px',
        height: '24px',
        padding: '5px',
        border: '2px solid transparent',
      },
    ),
  }),
  makeCase({
    id: 'nested-flex-auto-minimum-preserves-intrinsic-child',
    description: 'A nested flex item keeps its 160px automatic minimum beside a fixed 100px sibling.',
    width: 240,
    items: itemStyles(
      { display: 'flex', flex: '0 1 auto', width: 'auto', height: '20px' },
      { flex: '0 0 100px', height: '20px' },
    ),
    itemContents: [
      '<div style="flex:0 0 160px;height:20px;background-color:#14b8a6"></div>',
      '',
    ],
  }),
  makeCase({
    id: 'nested-row-auto-basis-with-flexible-sibling',
    description: 'A nested 80px and 60px row with a 10px gap takes its auto basis and leaves 150px for a flexible sibling.',
    width: 300,
    items: itemStyles(
      { display: 'flex', 'flex-direction': 'row', 'column-gap': '10px', flex: '0 0 auto', width: 'auto', height: '20px' },
      { flex: '1 1 0px', height: '20px' },
    ),
    itemContents: [
      '<div style="flex:0 0 80px;height:20px;background-color:#14b8a6"></div><div style="flex:0 0 60px;height:20px;background-color:#f59e0b"></div>',
      '',
    ],
  }),
);

const responsiveMediaCss = '@media (min-width: 600px) { #flex-container { flex-direction: row; } }';
for (const [id, viewportWidth, width] of [
  ['responsive-390-column', 390, 358],
  ['responsive-768-row', 768, 736],
]) {
  cases.push(
    makeCase({
      id,
      description: `A 600px media query changes the flex direction at a ${viewportWidth}px viewport.`,
      width,
      direction: 'ltr',
      viewport: { width: viewportWidth, height: 800 },
      containerOverrides: {
        'flex-direction': 'column',
        'flex-wrap': 'wrap',
        'row-gap': '12px',
        'column-gap': '12px',
      },
      items: itemStyles(
        { flex: '0 0 100px' },
        { flex: '0 0 100px' },
        { flex: '0 0 100px' },
        { flex: '0 0 100px' },
      ),
      mediaCss: responsiveMediaCss,
    }),
  );
}

function styleText(style) {
  return Object.entries(style)
    .map(([property, value]) => `${property}:${value}`)
    .join(';');
}

function authoredHTML(input) {
  const items = input.itemStyles
    .map((style, index) => `<div id="item-${index + 1}" data-flex-item="item-${index + 1}" style="${styleText(style)}">${input.itemContents?.[index] ?? ''}</div>`)
    .join('');
  const media = input.mediaCss ? `<style>${input.mediaCss}</style>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}body{background:transparent}#flex-container{${styleText(input.containerStyle)}}</style>${media}</head><body><div id="flex-container">${items}</div></body></html>`;
}

const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ['--no-sandbox'],
});

try {
  const browserVersion = browser.version();
  if (!browserVersion.startsWith('153.')) {
    throw new Error(`Expected the dedicated Chromium 153 test browser, got ${browserVersion}.`);
  }

  const capturedCases = [];
  for (const input of cases) {
    const html = authoredHTML(input);
    const page = await browser.newPage({
      viewport: input.viewport,
      deviceScaleFactor: 1,
    });
    await page.route('**/*', (route) => route.abort());
    await page.setContent(html);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const result = await page.evaluate(() => {
      const container = document.querySelector('#flex-container');
      const containerRect = container.getBoundingClientRect();
      const round = (value) => Math.round(value * 1000) / 1000;
      const computed = (element, properties) => {
        const styles = getComputedStyle(element);
        return Object.fromEntries(properties.map((property) => [property, styles.getPropertyValue(property)]));
      };
      const containerProperties = [
        'display',
        'direction',
        'box-sizing',
        'width',
        'height',
        'flex-direction',
        'flex-wrap',
        'flex-flow',
        'justify-content',
        'align-items',
        'align-content',
        'gap',
        'row-gap',
        'column-gap',
        'margin-top',
        'margin-right',
        'margin-bottom',
        'margin-left',
        'padding-top',
        'padding-right',
        'padding-bottom',
        'padding-left',
        'border-top-width',
        'border-right-width',
        'border-bottom-width',
        'border-left-width',
      ];
      const itemProperties = [
        'display',
        'box-sizing',
        'width',
        'height',
        'flex',
        'flex-basis',
        'flex-grow',
        'flex-shrink',
        'order',
        'align-self',
        'min-width',
        'max-width',
        'min-height',
        'max-height',
        'margin-top',
        'margin-right',
        'margin-bottom',
        'margin-left',
        'padding-top',
        'padding-right',
        'padding-bottom',
        'padding-left',
        'border-top-width',
        'border-right-width',
        'border-bottom-width',
        'border-left-width',
      ];
      return {
        containerRect: {
          x: round(containerRect.x),
          y: round(containerRect.y),
          width: round(containerRect.width),
          height: round(containerRect.height),
        },
        containerComputedStyle: computed(container, containerProperties),
        itemRects: [...container.querySelectorAll(':scope > [data-flex-item]')].map((item) => {
          const rect = item.getBoundingClientRect();
          return {
            id: item.dataset.flexItem,
            x: round(rect.left - containerRect.left),
            y: round(rect.top - containerRect.top),
            width: round(rect.width),
            height: round(rect.height),
            computedStyle: computed(item, itemProperties),
          };
        }),
      };
    });
    await page.close();
    capturedCases.push({ input, authoredHTML: html, result });
  }

  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        corpus: 'supplementary-native-document-flex-geometry',
        fixedWebBaselineCommit,
        oracle: {
          browser: `Chromium Headless Shell ${browserVersion}`,
          purpose: 'Supplementary Chromium 153 CSS layout oracle for common native document Flex geometry.',
          capture: 'Actual local CSS Flex layout; DOMRect geometry is measured in CSS pixels relative to the container border box.',
          deviceScaleFactor: 1,
          network: 'All page requests are blocked; pages use only authored synthetic HTML and CSS.',
          content: 'Empty colored boxes only; no text content or font-dependent measurement.',
          geometry: 'Coordinates and dimensions are rounded to 0.001 CSS pixels; all captured numeric values are finite.',
          fixedWebBaseline: `Reference only: ${fixedWebBaselineCommit}. This supplementary capture does not replace or rewrite the fixed web baseline or earlier Chromium 154/155 observations.`,
        },
        cases: capturedCases,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`Wrote ${capturedCases.length} actual Chromium 153 Flex cases to ${outputPath}\n`);
} finally {
  await browser.close();
}
