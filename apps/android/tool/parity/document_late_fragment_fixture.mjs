export const lateFragmentModes = [
  'inline',
  'dom-ready',
  'parser',
  'defer',
  'module',
  'load',
  'async',
  'load-rename',
  'load-duplicate',
  'parser-scroll',
  'parser-remount',
];
export const heldLateFragmentModes = new Set([
  'parser',
  'defer',
  'module',
  'async',
  'parser-scroll',
  'parser-remount',
]);
export function lateFragmentResource() {
  return 'window.createLateTarget();';
}
export function lateFragmentHTML(mode) {
  if (!lateFragmentModes.includes(mode)) throw Error(mode);
  const initial = ['load-rename', 'load-duplicate'].includes(mode);
  const create =
    "document.getElementById('slot').innerHTML='<div id=target data-key=target class=item>Target</div>'";
  const code = {
    inline: 'window.createLateTarget();',
    'dom-ready': "document.addEventListener('DOMContentLoaded',()=>window.createLateTarget());",
    load: "window.addEventListener('load',()=>window.createLateTarget());",
    'load-rename':
      "window.addEventListener('load',()=>document.getElementById('target').id='renamed');",
    'load-duplicate':
      "window.addEventListener('load',()=>{const e=document.createElement('div');e.id='target';e.className='item';e.dataset.key='duplicate';e.textContent='Duplicate';document.getElementById('slot').prepend(e);});",
  };
  const resource = heldLateFragmentModes.has(mode)
    ? `<script ${mode === 'defer' ? 'defer' : mode === 'module' ? 'type="module"' : mode === 'async' ? 'async' : ''} src="/late.js"></script>`
    : `<script>${code[mode]}</script>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;font:16px/20px sans-serif;scroll-behavior:auto}
.spacer{height:600px}.tail{height:2000px}.item{height:40px;background-color:#112233;color:#ffffff}
:target{height:80px;background-color:#123456;color:#abcdef}
nav{position:fixed;left:0;top:0;display:flex;z-index:10}button{width:70px;height:24px;padding:0;margin:0;border:0;font:12px sans-serif}
#probe{position:fixed;top:0;left:0;width:1px;height:1px;overflow:hidden;font-size:0;margin:0;padding:0}
</style><script>
window.createLateTarget=function(){${create};};
window.readLateTarget=function(){return {ready:document.readyState,target:document.querySelector(':target')?.dataset.key||null,
 items:Array.from(document.querySelectorAll('.item'),e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {key:e.dataset.key,color:s.color,background:s.backgroundColor,height:s.height,rect:[r.x,r.y,r.width,r.height]};})};};
</script></head><body><nav><button id="read" onclick="document.getElementById('probe').textContent=JSON.stringify(window.readLateTarget())">Read</button><button id="shift" onclick="document.querySelector('.spacer').style.height='720px'">Shift</button></nav>
<div class="spacer"></div><main id="slot">${initial ? '<div id="target" data-key="target" class="item">Target</div>' : ''}</main><div class="tail"></div><pre id="probe"></pre>${resource}</body></html>`;
}
