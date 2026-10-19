export const initialHistoryCases = [];
for (const phase of ['inline', 'dom-ready', 'load'])
  for (const method of ['pushState', 'replaceState'])
    for (const [name, next] of [
      ['same', '#one'],
      ['other', '#two'],
      ['route', '?route=changed#two'],
      ['clear', '?route=changed'],
    ]) {
      initialHistoryCases.push({
        id: `${phase}-${method}-${name}`,
        phase,
        method,
        next,
        initialHash: '#one',
      });
    }
for (const method of ['pushState', 'replaceState']) {
  initialHistoryCases.push({
    id: `nohash-${method}-other`,
    phase: 'inline',
    method,
    next: '#two',
    initialHash: '',
  });
  initialHistoryCases.push({
    id: `nohash-${method}-keep`,
    phase: 'inline',
    method,
    next: '?route=changed',
    initialHash: '',
    scrollBefore: 240,
  });
}
initialHistoryCases.push({
  id: 'inline-multiple',
  phase: 'inline',
  initialHash: '#one',
  sequence: [
    ['pushState', '#two'],
    ['replaceState', '?route=final#one'],
  ],
});
initialHistoryCases.push({
  id: 'dom-ready-multiple',
  phase: 'dom-ready',
  initialHash: '#one',
  sequence: [
    ['pushState', '#two'],
    ['pushState', '#one'],
  ],
});
for (const method of ['pushState', 'replaceState']) {
  initialHistoryCases.push({
    id: `load-${method}-absolute`,
    phase: 'load',
    method,
    next: '?route=changed#two',
    initialHash: '#one',
    scrollBefore: 240,
  });
  initialHistoryCases.push({
    id: `dom-ready-${method}-before-scroll`,
    phase: 'dom-ready',
    method,
    next: '#two',
    initialHash: '#one',
    scrollBefore: 240,
  });
  initialHistoryCases.push({
    id: `load-${method}-absolute-relative`,
    phase: 'load',
    method,
    next: '#two',
    initialHash: '#one',
    scrollBefore: 240,
    scrollByBefore: 60,
  });
}
export function initialHistoryHTML(spec) {
  const mutations = (spec.sequence || [[spec.method, spec.next]])
    .map(
      ([method, next], i) =>
        `history.${method}({stage:'initial',step:${i + 1}},'',${JSON.stringify(next)});`,
    )
    .join('');
  const mutate =
    (spec.scrollBefore ? `scrollTo(0,${spec.scrollBefore});` : '') +
    (spec.scrollByBefore ? `scrollBy(0,${spec.scrollByBefore});` : '') +
    mutations;
  const code =
    spec.phase === 'inline'
      ? mutate
      : spec.phase === 'dom-ready'
        ? `document.addEventListener('DOMContentLoaded',()=>{${mutate}});`
        : `window.addEventListener('load',()=>{${mutate}});`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;font:16px/20px sans-serif;scroll-behavior:auto}.gap{height:600px}.tail{height:2000px}
.item{height:40px;color:#ffffff;background:#112233}:target{height:80px;color:#abcdef;background:#123456}
nav{position:fixed;left:0;top:0;display:flex;z-index:10}button{width:70px;height:24px;margin:0;padding:0;border:0;font:12px sans-serif}
#probe{position:fixed;top:0;left:0;width:1px;height:1px;font-size:0;overflow:hidden;margin:0;padding:0}
</style><script>
window.initialHistoryLength=history.length;window.initialHistoryEvents=[];
for(const type of ['popstate','hashchange'])window.addEventListener(type,()=>initialHistoryEvents.push({type,url:location.href,target:document.querySelector(':target')?.id||null}));
window.readInitialHistory=function(){return {url:location.href,target:document.querySelector(':target')?.id||null,state:history.state,growth:history.length-initialHistoryLength,events:initialHistoryEvents,
items:Array.from(document.querySelectorAll('.item'),e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {id:e.id,color:s.color,background:s.backgroundColor,height:s.height,rect:[r.x,r.y,r.width,r.height]};})};};
</script></head><body><nav><button id="read" onclick="document.getElementById('probe').textContent=JSON.stringify(window.readInitialHistory())">Read</button><button id="rewrite" onclick="history.replaceState({stage:'post'},'','#one')">Rewrite</button></nav><div class="gap"></div><div class="item" id="one">One</div><div class="gap"></div><div class="item" id="two">Two</div><div class="tail"></div><pre id="probe"></pre><script>${code}</script></body></html>`;
}
