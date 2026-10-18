import { scrollCommandsHTML } from './document_scroll_commands_fixture.mjs';
export const scrollBehaviorModes = [
  'default',
  'auto',
  'instant',
  'numeric',
  'setter',
  'css-auto',
  'non-inherited',
  'inherit',
  'unset',
  'invalid',
  'dynamic-frame',
  'alias',
  'variable',
  'invalid-variable',
];
export function scrollBehaviorHTML(mode) {
  if (!scrollBehaviorModes.includes(mode)) throw Error('Invalid scroll behavior mode');
  let css = 'html,#port{scroll-behavior:smooth}';
  if (mode === 'css-auto') css = 'html,#port{scroll-behavior:auto}';
  if (mode === 'non-inherited') css = 'body{scroll-behavior:smooth}';
  if (mode === 'inherit') css = 'body{scroll-behavior:smooth}html,#port{scroll-behavior:inherit}';
  if (mode === 'unset') css = 'body{scroll-behavior:smooth}html,#port{scroll-behavior:unset}';
  if (mode === 'invalid') css = 'html,#port{scroll-behavior:smooth;scroll-behavior:instant}';
  if (mode === 'dynamic-frame')
    css = 'html,#port{scroll-behavior:auto}html.changed,#port.changed{scroll-behavior:smooth}';
  if (mode === 'variable') css = 'html,#port{--behavior:smooth;scroll-behavior:var(--behavior)}';
  if (mode === 'invalid-variable')
    css = 'html,#port{--behavior:instant;scroll-behavior:var(--behavior)}';
  return scrollCommandsHTML.replace('</style>', css + '</style>');
}
export function buildScrollBehaviorDriver(mode, target) {
  if (!scrollBehaviorModes.includes(mode) || !['root', 'element'].includes(target))
    throw Error('Invalid scroll behavior driver');
  const command =
    mode === 'numeric'
      ? 'actor.scrollTo(0,180)'
      : mode === 'setter'
        ? 'box.scrollTop=180'
        : `actor.scrollTo({top:180${mode === 'auto' ? ",behavior:'auto'" : mode === 'instant' ? ",behavior:'instant'" : ''}})`;
  return `(()=>{function read(){const e=document.getElementById('port');return {root:{left:scrollX,top:scrollY},element:{left:e.scrollLeft,top:e.scrollTop}}}
 const root=document.documentElement,port=document.getElementById('port');
 document.getElementById('run').addEventListener('click',()=>{
  function go(){const css={root:getComputedStyle(root).getPropertyValue('scroll-behavior'),element:getComputedStyle(port).getPropertyValue('scroll-behavior')};const box=${target === 'root' ? 'root' : 'port'},actor=${target === 'root' ? (mode === 'alias' ? 'root' : 'window') : 'port'};${command};const immediate=read();let start=null;function capture(time){if(start===null)start=time;if(time-start<600){requestAnimationFrame(capture);return}document.getElementById('probe').textContent=JSON.stringify({css,immediate,settled:read()})}requestAnimationFrame(capture)}
  ${mode === 'dynamic-frame' ? "root.classList.add('changed');port.classList.add('changed');requestAnimationFrame(go)" : 'go()'}
 });})();`;
}
