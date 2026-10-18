export const transformScrollModes = [
  'abs-auto',
  'fixed-auto',
  'relative-hidden',
  'fixed-hidden',
  'fixed-clip',
  'abs-scroll',
  'percentage',
  'bottom-right',
  'abs-overflow',
  'fixed-overflow',
  'scale',
  'rotate',
  'dynamic-size',
  'dynamic-overflow',
  'auto-height',
  'border-box',
];
export function transformScrollHTML(mode) {
  if (!transformScrollModes.includes(mode)) throw Error('Invalid transform scroll mode');
  const relative = mode === 'relative-hidden';
  const overflow = mode.includes('hidden')
    ? 'hidden'
    : mode === 'fixed-clip'
      ? 'clip'
      : mode === 'abs-scroll'
        ? 'scroll'
        : 'auto';
  const position = mode.startsWith('abs') || relative ? 'absolute' : 'fixed';
  const over = mode.endsWith('overflow');
  const target =
    mode === 'percentage'
      ? 'left:25%;top:20%;width:25%;height:25%'
      : mode === 'bottom-right'
        ? 'right:12px;bottom:10px;width:64px;height:32px'
        : `left:${over ? '210' : '28'}px;top:${over ? '220' : '24'}px;width:64px;height:32px`;
  return `<!doctype html><html id="html"><head><style>
 html,body{margin:0}body{height:2000px;padding:40px 0 0 32px;box-sizing:border-box;background:#fff}
 #host{position:${relative ? 'relative' : 'static'};width:220px;height:${mode === 'auto-height' ? 'auto' : '180px'};padding:8px;border:4px solid #16a34a;background:#22c55e;overflow:${overflow};transform:${relative ? 'none' : mode === 'scale' ? 'scale(1.2)' : mode === 'rotate' ? 'rotate(10deg)' : 'translate(20px,10px)'};${mode === 'border-box' ? 'box-sizing:border-box;' : ''}}
 #host.changed{${mode === 'dynamic-size' ? 'width:240px;height:200px' : mode === 'dynamic-overflow' ? 'overflow:hidden' : 'transform:translate(24px,16px) scale(.9)'}}
 #middle{width:160px;height:${mode === 'auto-height' ? '100' : '360'}px;border:2px solid #166534;margin:16px 0 0 20px}
 #target{display:block;position:${position};${target};margin:0;padding:0;border:0;background:#369}
 #outside{position:fixed;left:300px;top:20px;width:50px;height:24px;background:#f97316}
 #run{position:fixed;left:16px;top:510px;width:100px;height:32px;padding:0;margin:0;border:0}
 #probe{position:fixed;left:16px;top:560px;width:200px;height:20px;margin:0;overflow:hidden}
 </style></head><body id="body"><div id="host"><div id="middle"><div id="target"></div></div></div><div id="outside"></div><button id="run">Run</button><pre id="probe">WAIT</pre></body></html>`;
}
export function buildTransformScrollDriver() {
  return `(()=>{const host=document.getElementById('host');
 function read(){const boxes={};for(const id of ['host','middle','target','outside']){const e=document.getElementById(id),r=e.getBoundingClientRect(),p=e.offsetParent;boxes[id]={rect:[r.x,r.y,r.width,r.height].map(v=>+v.toFixed(4)),offset:{left:e.offsetLeft,top:e.offsetTop,parentId:p?p.id:null}}}return {scrollY,left:host.scrollLeft,top:host.scrollTop,width:host.scrollWidth,height:host.scrollHeight,clientWidth:host.clientWidth,clientHeight:host.clientHeight,boxes}}
 document.getElementById('run').addEventListener('click',()=>{const before=read();window.scrollTo({top:40,behavior:'instant'});host.scrollTo({left:16,top:20,behavior:'instant'});requestAnimationFrame(()=>{const scrolled=read();host.classList.add('changed');requestAnimationFrame(()=>{document.getElementById('probe').textContent=JSON.stringify({before,scrolled,changed:read()})})})});})();`;
}
