export const targetStateSteps = [
  ['initial'],
  ['link', 'one-link'],
  ['link', 'one-link'],
  ['link', 'two-link'],
  ['link', 'named-link'],
  ['link', 'encoded-link'],
  ['link', 'hidden-link'],
  ['link', 'missing-link'],
  ['link', 'top-link'],
  ['link', 'clear-link'],
];
export const scriptedTargetStateSteps = [
  ...targetStateSteps,
  ['link', 'one-link'],
  ['button', 'rename'],
  ['button', 'push'],
  ['button', 'replace'],
  ['back'],
  ['forward'],
  ['button', 'remove'],
  ['button', 'reinsert'],
  ['link', 'one-link'],
  ['link', 'two-link'],
  ['button', 'duplicate'],
  ['link', 'two-link'],
];
export function targetStateHTML(scripted) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;font-family:sans-serif;font-size:16px;line-height:20px}
html{scroll-behavior:auto}*{box-sizing:border-box}
nav{position:fixed;top:0;left:0;width:100%;height:100px;display:flex;flex-wrap:wrap;background:#fff;z-index:5}
nav a,nav button{display:block;width:70px;height:24px;margin:0;padding:0;border:0;font:12px sans-serif;color:#111;background:#eee;text-decoration:none}
.spacer{height:400px}.tail{height:2000px}
.item{display:block;height:40px;margin:0;padding:0;border:0;background:#112233;color:#ffffff}
:target{background-color:#123456;color:#abcdef;height:60px}
.item:not(:target){border-top-width:0px}
:root :target + .item{color:#aabbcc}
.item:nth-child(3):target{border-left:4px solid #334455}
#hidden{display:none}#hidden:target{display:block}
#report{position:fixed;left:0;top:0;width:1px;height:1px;font-size:0;overflow:hidden;margin:0;padding:0}
</style></head><body><nav>
${[
  ['one-link', '#one', 'One'],
  ['two-link', '#two', 'Two'],
  ['named-link', '#legacy', 'Named'],
  ['encoded-link', '#%E9%9B%AA', 'Encoded'],
  ['hidden-link', '#hidden', 'Hidden'],
  ['missing-link', '#absent', 'Missing'],
  ['top-link', '#top', 'Top'],
  ['clear-link', '#', 'Clear'],
]
  .map(([id, href, text]) => `<a id="${id}" href="${href}">${text}</a>`)
  .join('')}
${
  scripted
    ? `<button id="rename" onclick="document.querySelector('[data-key=one]').id='renamed'">Rename</button>
<button id="push" onclick="history.pushState({n:1},'', '#two')">Push</button>
<button id="replace" onclick="history.replaceState({n:2},'', '#legacy')">Replace</button>
<button id="remove" onclick="window.savedTarget=document.querySelector('[data-key=one]');savedTarget.remove()">Remove</button>
<button id="reinsert" onclick="document.querySelector('main').appendChild(savedTarget)">Reinsert</button>
<button id="duplicate" onclick="const e=document.createElement('div');e.id='two';e.className='item';e.dataset.key='duplicate';e.textContent='Duplicate';document.querySelector('main').prepend(e)">Duplicate</button>
<button id="read" onclick="document.getElementById('report').textContent=JSON.stringify(window.readTargetState())">Read</button>`
    : ''
}
</nav><main><div class="spacer"></div><div id="one" data-key="one" class="item">One target</div><div id="two" data-key="two" class="item">Two target</div><a name="legacy" data-key="named" class="item">Named target</a><div id="雪" data-key="encoded" class="item">Encoded target</div><div id="hidden" data-key="hidden" class="item">Hidden target</div></main><div class="tail"></div><pre id="report"></pre>
${
  scripted
    ? `<script>
window.targetLifecycle=[['script',Array.from(document.querySelectorAll(':target'),e=>e.dataset.key)]];
for(const type of ['DOMContentLoaded','load'])(type==='load'?window:document).addEventListener(type,()=>targetLifecycle.push([type,Array.from(document.querySelectorAll(':target'),e=>e.dataset.key)]));
window.readTargetState=function(){return {
 target:Array.from(document.querySelectorAll(':target'),e=>e.dataset.key),
 matches:Array.from(document.querySelectorAll('.item'),e=>[e.dataset.key,e.matches(':target'),e.closest(':target')===e]),
 negated:Array.from(document.querySelectorAll('.item:not(:target)'),e=>e.dataset.key),
 styles:Array.from(document.querySelectorAll('.item'),e=>{const s=getComputedStyle(e);return [e.dataset.key,s.display,s.color,s.backgroundColor,s.height,s.borderLeftWidth]}),
 lifecycle:targetLifecycle
};};
</script>`
    : ''
}</body></html>`;
}
