export const liveResourceHTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:16px/24px Arial}button,input{display:block;box-sizing:border-box;width:160px;height:32px;padding:0;margin:0;border:0;font:16px/24px Arial}#status{height:24px}#panel{height:24px;width:100%;background:#204060}#panel.loaded{height:48px;background:#206040}#panel.extended{height:72px;background:#602040}
</style></head><body><button id="load">Load data</button><button id="abort">Cancel load</button><button id="extra">Load script</button><input id="draft" value="initial"><div id="status">Idle</div><div id="panel"></div><script>
window.probe={boots:(window.probe?.boots||0)+1,phase:'idle',trace:[],title:'initial',extra:0};
let pending;
document.getElementById('load').addEventListener('click',async()=>{
 pending=new AbortController();probe.phase='loading';probe.trace.push('start');document.getElementById('status').textContent='Loading';
 try{
  const response=await fetch('/payload',{signal:pending.signal});const data=await response.json();
  document.getElementById('draft').value=data.title;document.getElementById('panel').classList.add('loaded');
  probe.title=data.title;probe.phase='loaded';probe.trace.push('loaded');document.getElementById('status').textContent='Loaded';
 }catch(error){probe.phase=error.name==='AbortError'?'cancelled':'error';probe.trace.push(probe.phase);document.getElementById('status').textContent=probe.phase;}
});
document.getElementById('abort').addEventListener('click',()=>pending?.abort());
document.getElementById('extra').addEventListener('click',()=>{const script=document.createElement('script');script.src='/extra.js';script.onload=()=>{probe.phase='extended';probe.trace.push('extra-loaded');document.getElementById('status').textContent='Extended';};document.body.appendChild(script);});
</script></body></html>`;
export const liveResourcePayload = { title: '資料已載入🙂' };
export const readLiveResourceState = () => ({
  background: getComputedStyle(document.getElementById('panel')).backgroundColor,
  probe: window.probe,
  value: document.getElementById('draft').value,
  rect: (() => {
    const r = document.getElementById('panel').getBoundingClientRect();
    return [r.x, r.y, r.width, r.height];
  })(),
});

export const liveResourceExtraScript = `probe.extra++;document.getElementById('panel').classList.add('extended');document.getElementById('draft').value+=' + script';probe.title=document.getElementById('draft').value;`;
