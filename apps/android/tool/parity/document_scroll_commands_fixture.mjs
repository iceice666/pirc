const to = (y, behavior = 'instant', x = null) => ({ kind: 'to', x, y, behavior });
const by = (y, behavior = 'instant', x = 0) => ({ kind: 'by', x, y, behavior });
export const scrollCommandModes = {
  'instant-smooth': [to(100), to(180, 'smooth')],
  'smooth-instant-by': [to(180, 'smooth'), by(20)],
  'smooth-smooth-by': [to(180, 'smooth'), by(20, 'smooth')],
  'smooth-same-position': [to(180, 'smooth'), to(0)],
  'smooth-other-axis': [to(180, 'smooth'), to(null, 'instant', 0)],
  'smooth-zero-by': [to(180, 'smooth'), by(0)],
  'smooth-empty-to': [to(180, 'smooth'), to(null)],
  'instant-smooth-reverse': [to(100), to(180, 'smooth'), by(-20)],
  'two-axes': [to(60, 'instant', 40), to(180, 'smooth', 120)],
  'clamp-relative': [to(99999, 'instant', 99999), by(-20, 'instant', -20)],
};
export const scrollCommandsHTML = `<!doctype html><html><head><style>
html,body{margin:0;padding:0}body{height:2200px}
#port{width:180px;height:100px;overflow:auto}
#content{width:600px;height:800px;background:#369}
#run{position:fixed;top:130px;left:16px;width:100px;height:32px;margin:0;padding:0;border:0}
#probe{position:fixed;top:180px;left:16px;width:200px;height:20px;overflow:hidden;margin:0;padding:0}
</style></head><body><div id="port"><div id="content"></div></div><button id="run">Run</button><pre id="probe">WAIT</pre></body></html>`;
export function buildScrollCommandDriver(mode, target) {
  if (!Object.hasOwn(scrollCommandModes, mode) || !['root', 'element'].includes(target))
    throw Error('Invalid scroll command fixture');
  return `(()=>{const commands=${JSON.stringify(scrollCommandModes[mode])};const target=${JSON.stringify(target)};
 function read(){const e=document.getElementById('port');return {root:{left:scrollX,top:scrollY},element:{left:e.scrollLeft,top:e.scrollTop}}}
 document.getElementById('run').addEventListener('click',()=>{
  const e=target==='root'?window:document.getElementById('port');
  for(const c of commands){const o={behavior:c.behavior};if(c.x!==null)o.left=c.x;if(c.y!==null)o.top=c.y;e[c.kind==='by'?'scrollBy':'scrollTo'](o)}
  const immediate=read();let start=null;
  function capture(time){if(start===null)start=time;if(time-start<500){requestAnimationFrame(capture);return}document.getElementById('probe').textContent=JSON.stringify({immediate,settled:read()})}
  requestAnimationFrame(capture);
 });})();`;
}
