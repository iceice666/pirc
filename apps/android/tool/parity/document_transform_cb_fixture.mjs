export const transformCBModes = [
  'abs-static',
  'abs-relative',
  'fixed-static',
  'fixed-relative',
  'nearest-position',
  'skip-relative',
  'nested-transform',
  'identity',
  'rotate',
  'percentage',
  'own-transform',
  'canvas',
  'button',
  'external-scroll',
  'add-transform',
  'remove-transform',
  'opacity',
];
export function transformCBHTML(mode) {
  if (!transformCBModes.includes(mode)) throw Error('Invalid transformed containing-block mode');
  const absolute = ['abs-static', 'abs-relative', 'nearest-position', 'canvas', 'button'].includes(
    mode,
  );
  const relative = ['abs-relative', 'fixed-relative'].includes(mode);
  const middleRelative = ['nearest-position', 'skip-relative'].includes(mode);
  const hostTransform =
    mode === 'add-transform'
      ? 'none'
      : mode === 'identity'
        ? 'scale(1)'
        : mode === 'rotate'
          ? 'rotate(10deg)'
          : relative
            ? 'scale(1.2)'
            : mode === 'nested-transform'
              ? 'scale(1.1)'
              : 'translate(20px, 10px)';
  const tag = mode === 'canvas' ? 'canvas' : mode === 'button' ? 'button' : 'div';
  return `<!doctype html><html><head><style>
html,body{margin:0}body{height:2000px;box-sizing:border-box;padding:40px 0 0 32px;background:#fff}
#scroller{${mode === 'external-scroll' ? 'width:320px;height:260px;overflow:auto;' : ''}}
#scrollSpace{${mode === 'external-scroll' ? 'height:800px;padding:20px 0 0 16px;' : ''}}
#host{position:${relative ? 'relative' : 'static'};width:220px;height:180px;padding:8px;border:4px solid #16a34a;background:#22c55e;transform:${hostTransform};${mode === 'opacity' ? 'opacity:.5;' : ''}}
#host.changed{transform:${mode === 'remove-transform' ? 'none' : 'translate(24px, 16px) scale(.9)'}}
#middle{position:${middleRelative ? 'relative' : 'static'};width:160px;height:100px;margin:16px 0 0 20px;border:2px solid #166534;${mode === 'nested-transform' ? 'transform:translate(8px, 4px) rotate(10deg);' : ''}}
#target{display:block;position:${absolute ? 'absolute' : 'fixed'};left:${mode === 'percentage' ? '25%' : '28px'};top:${mode === 'percentage' ? '20%' : '24px'};width:${mode === 'percentage' ? '25%' : '64px'};height:${mode === 'percentage' ? '25%' : '32px'};margin:0;padding:0;border:0;background:#369;${mode === 'own-transform' ? 'transform:translate(-50%, -50%) rotate(5deg);' : ''}}
#outside{position:fixed;left:300px;top:20px;width:50px;height:24px;background:#f97316}
#run{position:fixed;left:16px;top:310px;width:100px;height:32px;margin:0;padding:0;border:0}
#probe{position:fixed;left:16px;top:360px;width:200px;height:20px;margin:0;overflow:hidden}
</style></head><body><div id="scroller"><div id="scrollSpace"><div id="host"><div id="middle"><${tag} id="target"${tag === 'canvas' ? ' width="64" height="32"' : ''}></${tag}></div></div></div></div><div id="outside"></div><button id="run">Run</button><pre id="probe">WAIT</pre></body></html>`;
}
export function buildTransformCBDriver() {
  return `(()=>{const target=document.getElementById('target'),host=document.getElementById('host'),scroller=document.getElementById('scroller');let clicks=0;
 if(target.tagName==='CANVAS'){const c=target.getContext('2d');c.fillStyle='#369';c.fillRect(0,0,64,32)}
 target.addEventListener('click',()=>{clicks++});
 function read(){const boxes={};for(const id of ['host','middle','target','outside']){const r=document.getElementById(id).getBoundingClientRect();boxes[id]=[r.x,r.y,r.width,r.height].map(v=>+v.toFixed(4))}return {scrollY,inner:scroller.scrollTop,position:getComputedStyle(target).position,boxes}}
 document.getElementById('run').addEventListener('click',()=>{const before=read();window.scrollTo({top:40,behavior:'instant'});scroller.scrollTo({top:20,behavior:'instant'});requestAnimationFrame(()=>{const scrolled=read();host.classList.add('changed');requestAnimationFrame(()=>{document.getElementById('probe').textContent=JSON.stringify({clicks,before,scrolled,changed:read()})})})});
})();`;
}
