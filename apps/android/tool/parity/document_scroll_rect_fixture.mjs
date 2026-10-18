export const scrollRectModes = [
  'root',
  'outer',
  'inner',
  'combined',
  'clamped',
  'affine',
  'instant-smooth',
  'canvas',
  'translate',
  'origin',
  'rotate',
  'matrix',
  'compound',
  'self-fixed',
  'self-absolute',
  'self-canvas',
];
export const scrollRectTransforms = {
  affine: ['scale(1.5)', '0 0'],
  translate: ['translate(10px, 20px)', '50% 50%'],
  origin: ['scale(1.25)', '50% 50%'],
  rotate: ['rotate(10deg)', '0 0'],
  matrix: ['matrix(1.2, 0.1, 0.2, 0.8, 10, 5)', '50% 50%'],
  compound: ['translate(10%, 5px) scale(1.2, 0.8)', '50% 50%'],
};
export function scrollRectHTML(mode) {
  if (!scrollRectModes.includes(mode)) throw Error('Invalid scroll rectangle mode');
  return `<!doctype html><html><head><style>
html,body{margin:0}body{height:2400px;padding:20px 0 0 16px;box-sizing:border-box}
#outer{width:220px;height:160px;overflow:auto;${scrollRectTransforms[mode] ? `transform:${scrollRectTransforms[mode][0]};transform-origin:${scrollRectTransforms[mode][1]};` : ''}}
#space{width:800px;height:1000px;padding:30px 0 0 40px;box-sizing:border-box;position:relative}
#inner{width:180px;height:120px;overflow:auto}
#innerSpace{width:600px;height:700px;padding:80px 0 0 60px;box-sizing:border-box;position:relative}
#target{display:block;position:relative;width:80px;height:40px;background:#369;${mode === 'self-absolute' ? 'position:absolute;left:60px;top:80px;transform:translate(-50%, -50%);' : mode === 'self-canvas' ? 'transform:scale(.75);' : ''}}
#fixed{position:fixed;left:280px;top:20px;width:60px;height:30px;${scrollRectTransforms[mode] ? 'display:none;' : mode === 'self-fixed' ? 'transform:scale(1.2);' : ''}}
#outside{width:80px;height:40px;margin-top:60px}
#run{position:fixed;left:16px;top:310px;width:100px;height:32px;margin:0;padding:0;border:0}
#probe{position:fixed;left:16px;top:360px;width:200px;height:20px;margin:0;overflow:hidden}
</style></head><body><div id="outer"><div id="space"><div id="inner"><div id="innerSpace">${['canvas', 'self-canvas'].includes(mode) ? '<canvas id="target" width="80" height="40"></canvas>' : '<div id="target"></div>'}<div id="fixed"></div></div></div></div></div><div id="outside"></div><button id="run">Run</button><pre id="probe">WAIT</pre></body></html>`;
}
export function buildScrollRectDriver(mode) {
  if (!scrollRectModes.includes(mode)) throw Error('Invalid scroll rectangle mode');
  return `(()=>{const mode=${JSON.stringify(mode)},ids=['outer','inner','target','outside'].concat(${JSON.stringify(Object.keys({ affine: 1, translate: 1, origin: 1, rotate: 1, matrix: 1, compound: 1 }))}.includes(mode)?[]:['fixed']);
 const outer=document.getElementById('outer'),inner=document.getElementById('inner'),target=document.getElementById('target');
 if(['canvas','self-canvas'].includes(mode)){const ctx=target.getContext('2d');ctx.fillStyle='#369';ctx.fillRect(0,0,80,40)}
 const n=v=>+v.toFixed(4),rect=r=>[r.x,r.y,r.width,r.height].map(n);
 function read(){const boxes={};for(const id of ids){const e=document.getElementById(id),list=e.getClientRects();boxes[id]={rect:rect(e.getBoundingClientRect()),clients:Array.from(list).map(rect)}}return {root:[n(scrollX),n(scrollY)],outer:[n(outer.scrollLeft),n(outer.scrollTop)],inner:[n(inner.scrollLeft),n(inner.scrollTop)],boxes}}
 (['canvas','self-canvas'].includes(mode)?target:document.getElementById('run')).addEventListener('click',()=>{
  const before=read(),trace=[],record=()=>trace.push(read());
  if(mode==='root'){window.scrollBy({top:40,behavior:'instant'});record()}
  if(mode==='outer'){outer.scrollBy({left:20,top:30,behavior:'instant'});record()}
  if(mode==='inner'){inner.scrollBy({left:10,top:15,behavior:'instant'});record()}
  if(['combined','affine','canvas','translate','origin','rotate','matrix','compound','self-fixed','self-absolute','self-canvas'].includes(mode)){window.scrollBy({top:40,behavior:'instant'});record();outer.scrollBy({left:20,top:30,behavior:'instant'});record();inner.scrollBy({left:10,top:15,behavior:'instant'});record()}
  if(mode==='clamped'){outer.scrollTo({left:99999,top:99999,behavior:'instant'});record();outer.scrollBy({left:-20,top:-30,behavior:'instant'});record();inner.scrollTo({left:99999,top:99999,behavior:'instant'});record();inner.scrollBy({left:-10,top:-15,behavior:'instant'});record();window.scrollTo({top:99999,behavior:'instant'});record();window.scrollBy({top:-25,behavior:'instant'});record()}
  if(mode==='instant-smooth'){window.scrollTo({top:40,behavior:'instant'});record();window.scrollTo({top:80,behavior:'smooth'});record()}
  const immediate=read();window.scrollRectReport={before,trace,immediate};let start=null;
  function frame(time){if(start===null)start=time;if(time-start<600){requestAnimationFrame(frame);return}document.getElementById('probe').textContent=JSON.stringify({before,trace,immediate,settled:read()})}requestAnimationFrame(frame);
 });})();`;
}
