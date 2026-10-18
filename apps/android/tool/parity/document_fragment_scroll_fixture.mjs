import { intoViewHTML } from './document_into_view_fixture.mjs';
export const fragmentScrollModes = [
  'default',
  'padding-margin',
  'percentage-padding',
  'margin-negative',
  'font-insets',
  'scale',
  'rotate',
  'mirror',
  'target-transform',
  'hidden',
  'oversized',
  'css-smooth',
  'canvas',
  'button',
  'input',
  'zero-range',
  'root-padding',
  'dynamic-margin',
];
export function fragmentScrollHTML(mode, scripted) {
  if (!fragmentScrollModes.includes(mode) || (mode === 'dynamic-margin' && !scripted))
    throw Error(mode);
  let source = intoViewHTML(
    mode === 'oversized'
      ? 'oversized-nearest'
      : ['zero-range', 'root-padding', 'dynamic-margin'].includes(mode)
        ? 'default'
        : mode,
  );
  source = source
    .replace(
      '<button id="run">Run</button>',
      '<a id="jump" href="#target"' +
        (mode === 'dynamic-margin'
          ? " onclick=\"document.getElementById('target').style.scrollMarginTop='20px';document.documentElement.style.scrollPaddingTop='30px'\""
          : '') +
        '>Jump</a>',
    )
    .replace(
      '</style>',
      '#jump{position:fixed;left:16px;top:20px;display:block;width:100px;height:32px;margin:0;padding:0;border:0}' +
        (mode === 'zero-range'
          ? '#inner{width:800px;height:900px}'
          : mode === 'root-padding'
            ? 'html{scroll-padding:80px}#target{scroll-margin:18px}'
            : '') +
        '</style>',
    );
  if (scripted)
    source = source.replace('</body>', '<script>window.fragmentReady=true;</script></body>');
  return source;
}
