export const relativeUnitCases = [
  { id: 'em', insets: 'top:1.5em;left:2em' },
  { id: 'rem', insets: 'top:2rem;left:3rem' },
  { id: 'viewport', insets: 'top:5vh;left:10vw' },
  { id: 'right-bottom', insets: 'top:auto;left:auto;right:-2rem;bottom:-1em' },
  { id: 'mixed-shorthand', insets: 'inset:1em 2rem 3vh 4vw;top:auto;left:25%' },
  { id: 'flex', insets: 'top:1rem;left:2em', parent: 'display:flex;align-items:flex-start' },
  {
    id: 'grid',
    insets: 'top:1em;left:3vw',
    parent: 'display:grid;grid-template-columns:80px 80px;grid-template-rows:40px',
  },
  { id: 'nested', insets: 'top:1rem;left:2em', parent: 'position:relative;top:1em;left:1rem' },
];
export const relativeUnitHTML =
  '<!doctype html><html id="html"><head><meta charset="utf-8"></head><body id="body"><div id="spacer"></div><div id="parent"><a id="subject" href="/next">Go</a><div id="after"></div></div><input name="draft" value="initial"></body></html>';
export function relativeUnitCSS(spec, phase = 0) {
  return `html,body{margin:0;padding:0;background:#fff;color:#000;scrollbar-width:none}html{font-size:${phase === 0 ? 24 : 32}px}body{font:16px/20px sans-serif}#spacer{height:100px}#parent{font-size:${phase === 0 ? 20 : 26}px;width:240px;height:180px;padding:10px;border:1px solid #111;${spec.parent || ''}}#subject{display:block;position:relative;width:60px;height:32px;margin:0;padding:0;border:0;font:inherit;text-decoration:none;color:#fff;background:#225588;${spec.insets}}#after{width:70px;height:24px}input{display:block;width:120px;height:40px;margin:0;padding:0;border:0;font:16px/20px sans-serif}`;
}
