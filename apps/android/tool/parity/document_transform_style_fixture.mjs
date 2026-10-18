export const transformStyleModes = [
  'none',
  'identity',
  'translate',
  'scale',
  'rotate',
  'skew',
  'matrix',
  'compound',
  'canvas',
  'hidden',
  'origin',
  'empty',
  'units',
  'border-box',
  'hidden-matrix',
  'hidden-origin',
];
const transforms = {
  identity: 'scale(1)',
  translate: 'translate(25%, -50%)',
  scale: 'scale(1.25, .8)',
  rotate: 'rotate(10deg)',
  skew: 'skew(10deg, -5deg)',
  matrix: 'matrix(1.23456789, .1, .2, .8, 10.123456789, -5.123456789)',
  compound: 'translate(10%, 5px) scale(1.2, .8)',
  canvas: 'translate(25%, -50%) rotate(5deg)',
  hidden: 'translate(25%, -50%)',
  origin: 'scale(2)',
  empty: 'translate(25%, -50%)',
  units: 'translate(1em, 2vh) scale(1.2)',
  'border-box': 'translate(25%, -50%)',
  'hidden-matrix': 'matrix(1.2, .1, .2, .8, 10, -5)',
  'hidden-origin': 'translate(1em, 2vh)',
};
export function transformStyleHTML(mode) {
  if (!transformStyleModes.includes(mode)) throw Error('Invalid transform style mode');
  return `<!doctype html><html><head><style>
html,body{margin:0}body{padding:40px 0 0 80px;font-size:16px}
#target{display:block;position:relative;width:80px;height:40px;padding:4px;border:2px solid #369;${transforms[mode] ? `transform:${transforms[mode]};` : ''}${mode === 'origin' ? 'transform-origin:right bottom;' : mode === 'hidden-origin' ? 'transform-origin:10px 20px;' : ''}${mode.startsWith('hidden') ? 'display:none;' : ''}${mode === 'empty' ? 'width:0;height:0;padding:0;border:0;' : ''}${mode === 'border-box' ? 'box-sizing:border-box;' : ''}}
#target.changed{display:block;width:120px;height:60px;transform:translate(12.5%, -25%) rotate(30deg);transform-origin:right bottom}
#run{position:fixed;left:16px;top:310px;width:100px;height:32px;margin:0;padding:0;border:0}
#probe{position:fixed;left:16px;top:360px;width:200px;height:20px;margin:0;overflow:hidden}
</style></head><body>${mode === 'canvas' ? '<canvas id="target" width="80" height="40"></canvas>' : '<div id="target"></div>'}<button id="run">Run</button><pre id="probe">WAIT</pre></body></html>`;
}
export function buildTransformStyleDriver() {
  return `(()=>{const target=document.getElementById('target');
 document.getElementById('run').addEventListener('click',()=>{
  const retained=getComputedStyle(target),n=v=>+v.toFixed(4);
  function read(){const r=target.getBoundingClientRect();return {transform:retained.transform,transformValue:retained.getPropertyValue('transform'),origin:retained.transformOrigin,originValue:retained.getPropertyValue('transform-origin'),width:retained.width,height:retained.height,offset:[target.offsetWidth,target.offsetHeight],rect:[r.x,r.y,r.width,r.height].map(n)}}
  const before=read();target.classList.add('changed');
  requestAnimationFrame(()=>{document.getElementById('probe').textContent=JSON.stringify({before,after:read()})});
 });})();`;
}
