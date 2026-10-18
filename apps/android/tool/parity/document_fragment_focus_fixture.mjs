import { fragmentScrollHTML } from './document_fragment_scroll_fixture.mjs';
export const fragmentFocusModes = [
  'button',
  'input',
  'textarea',
  'select',
  'checkbox',
  'link',
  'tabindex',
  'negative-tabindex',
  'disabled',
  'nonfocusable',
  'hidden',
  'button-padding',
  'input-rotate',
  'button-smooth',
  'button-root-smooth',
  'button-inner-smooth',
  'visible-button',
  'top',
  'missing',
  'onfocus-margin',
];
export function fragmentFocusHTML(mode, scripted) {
  if (!fragmentFocusModes.includes(mode) || (mode === 'onfocus-margin' && !scripted))
    throw Error(mode);
  const base =
    mode === 'button-padding'
      ? 'padding-margin'
      : mode === 'input-rotate'
        ? 'rotate'
        : mode === 'button-smooth'
          ? 'css-smooth'
          : 'default';
  let source = fragmentScrollHTML(base, false);
  const target =
    mode.startsWith('button') || ['visible-button', 'disabled', 'onfocus-margin'].includes(mode)
      ? '<button id="target"' +
        (mode === 'disabled' ? ' disabled' : '') +
        (mode === 'onfocus-margin'
          ? ` onfocus="this.style.scrollMarginTop='20px';document.documentElement.style.scrollPaddingTop='30px'"`
          : '') +
        '></button>'
      : mode === 'input' || mode === 'input-rotate'
        ? '<input id="target">'
        : mode === 'checkbox'
          ? '<input id="target" type="checkbox">'
          : mode === 'textarea'
            ? '<textarea id="target"></textarea>'
            : mode === 'select'
              ? '<select id="target"><option>One</option><option>Two</option></select>'
              : mode === 'link'
                ? '<a id="target" href="#other">Target</a>'
                : mode === 'tabindex' || mode === 'negative-tabindex'
                  ? '<div id="target" tabindex="' + (mode === 'tabindex' ? '0' : '-1') + '"></div>'
                  : '<div id="target"></div>';
  source = source.replace('<div id="target"></div>', target);
  if (mode === 'button-root-smooth')
    source = source.replace('</style>', 'html{scroll-behavior:smooth}</style>');
  if (mode === 'button-inner-smooth')
    source = source.replace('</style>', '#inner{scroll-behavior:smooth}</style>');
  if (mode === 'hidden') source = source.replace('</style>', '#target{display:none}</style>');
  if (mode === 'visible-button')
    source = source.replace('</style>', '#space{padding:8px}#innerSpace{padding:12px}</style>');
  if (mode === 'top' || mode === 'missing')
    source = source.replace(
      'href="#target"',
      'href="' + (mode === 'top' ? '#top' : '#absent') + '"',
    );
  if (scripted) {
    source = source.replace(
      'id="jump"',
      `id="jump" onclick="window.__fragmentFocusEvents=[];document.getElementById('focusprobe').textContent='[]'"`,
    );
    source = source.replace(
      '</body>',
      `<pre id="focusprobe" style="position:fixed;left:0;top:700px;width:1px;height:1px;overflow:hidden;margin:0;padding:0">[]</pre><script>
      window.__fragmentFocusEvents=[];
      ['focus','blur','focusin','focusout'].forEach(function(type){document.addEventListener(type,function(e){
        window.__fragmentFocusEvents.push({type:e.type,target:e.target.id||e.target.localName,related:e.relatedTarget?(e.relatedTarget.id||e.relatedTarget.localName):null,active:document.activeElement.id||document.activeElement.localName,trusted:e.isTrusted});
        document.getElementById('focusprobe').textContent=JSON.stringify(window.__fragmentFocusEvents);
      },true)});
      window.fragmentReady=true;
    </script></body>`,
    );
  }
  return source;
}
