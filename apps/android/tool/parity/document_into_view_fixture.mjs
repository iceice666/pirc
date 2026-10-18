export const intoViewModes = [
  'default',
  'false',
  'null',
  'center',
  'end',
  'inline-start',
  'nearest',
  'visible-nearest',
  'oversized-nearest',
  'nearest-container',
  'css-smooth',
  'smooth',
  'padding-margin',
  'percentage-padding',
  'margin-negative',
  'font-insets',
  'scale',
  'rotate',
  'mirror',
  'target-transform',
  'hidden',
  'append-await',
  'replacement',
  'contract',
  'canvas',
  'button',
  'input',
];
export function intoViewArgument(mode) {
  if (mode === 'default') return { kind: 'omitted' };
  if (mode === 'false') return { kind: 'value', value: false };
  if (mode === 'null') return { kind: 'value', value: null };
  let value = {
    behavior: mode === 'smooth' ? 'smooth' : mode === 'css-smooth' ? 'auto' : 'instant',
    block: 'start',
    inline: 'nearest',
  };
  if (['center', 'padding-margin', 'font-insets'].includes(mode))
    Object.assign(value, { block: 'center', inline: 'center' });
  if (mode === 'end' || mode === 'margin-negative')
    Object.assign(value, { block: 'end', inline: 'end' });
  if (mode === 'inline-start' || mode === 'percentage-padding') value.inline = 'start';
  if (['nearest', 'visible-nearest', 'oversized-nearest'].includes(mode))
    Object.assign(value, { block: 'nearest', inline: 'nearest' });
  if (mode === 'nearest-container') value.container = 'nearest';
  return { kind: 'value', value };
}
export function intoViewSetup(mode) {
  return ['visible-nearest', 'oversized-nearest'].includes(mode)
    ? {
        root: 700,
        outer: [240, 180],
        inner: mode === 'oversized-nearest' ? [400, 350] : [360, 320],
      }
    : null;
}
export function intoViewHTML(mode) {
  if (!intoViewModes.includes(mode)) throw Error('Invalid into-view mode');
  const big = mode === 'oversized-nearest';
  let extra = '';
  if (mode === 'css-smooth') extra = 'html,#outer,#inner{scroll-behavior:smooth}';
  if (mode === 'padding-margin')
    extra =
      'html,#outer,#inner{scroll-padding:10px 14px 6px 8px}#target{scroll-margin:12px 16px 8px 4px}';
  if (mode === 'percentage-padding')
    extra =
      'html{scroll-padding:5% 2%}#outer,#inner{scroll-padding:10% 5%}#target{scroll-margin:8px}';
  if (mode === 'margin-negative') extra = '#target{scroll-margin:-4px -6px -2px -8px}';
  if (mode === 'font-insets')
    extra =
      'html{font-size:18px;scroll-padding:.5rem}#outer,#inner{font-size:20px;scroll-padding:.5em 1em}#target{font-size:12px;scroll-margin:1em 2em}';
  if (mode === 'scale') extra = '#outer{transform:scale(1.2);transform-origin:0 0}';
  if (mode === 'rotate') extra = '#outer{transform:rotate(6deg);transform-origin:0 0}';
  if (mode === 'mirror')
    extra = '#outer{transform:translateX(300px) scaleX(-1);transform-origin:0 0}';
  if (mode === 'target-transform')
    extra = '#target{transform:translate(-10%,5px) rotate(8deg);transform-origin:0 0}';
  if (mode === 'hidden') extra = '#target{display:none}';
  const targetMarkup =
    mode === 'input'
      ? '<input id="target">'
      : mode === 'canvas'
        ? '<canvas id="target" width="70" height="40"></canvas>'
        : mode === 'button'
          ? '<button id="target"></button>'
          : '<div id="target"></div>';
  return `<!doctype html><html><head><style>
 html,body{margin:0;padding:0}body{height:4000px;padding:700px 0 0 16px;box-sizing:border-box;background:white}
 #outer{width:260px;height:180px;overflow:auto;border:4px solid #369;padding:6px}
 #space{width:900px;height:1000px;box-sizing:border-box;padding:180px 0 0 240px}
 #inner{width:200px;height:120px;overflow:auto;border:2px solid #963;padding:8px}
 #innerSpace{width:700px;height:800px;box-sizing:border-box;padding:320px 0 0 360px}
 #target{display:block;width:${big ? 340 : 70}px;height:${big ? 260 : 40}px;margin:0;padding:0;border:0;background:#369}
 #run{position:fixed;left:16px;top:600px;width:100px;height:32px;padding:0;border:0;margin:0}
 #probe{position:fixed;left:16px;top:650px;width:300px;height:20px;padding:0;margin:0;overflow:hidden}
 ${extra}</style></head><body><div id="outer"><div id="space"><div id="inner"><div id="innerSpace">${mode === 'append-await' ? '' : targetMarkup}</div></div></div></div><button id="run">Run</button><pre id="probe">WAIT</pre></body></html>`;
}
export function buildIntoViewDriver(mode) {
  const argument = intoViewArgument(mode),
    setup = intoViewSetup(mode),
    call =
      argument.kind === 'omitted'
        ? 'target.scrollIntoView()'
        : `target.scrollIntoView(${JSON.stringify(argument.value)})`;
  const contract = `async function contract(){const target=document.getElementById('target'),descriptor=Object.getOwnPropertyDescriptor(Element.prototype,'scrollIntoView');const result={name:target.scrollIntoView.name,length:target.scrollIntoView.length,descriptor:{enumerable:descriptor.enumerable,writable:descriptor.writable,configurable:descriptor.configurable},arguments:[]};
 for(const [name,arg] of [['undefined',undefined],['null',null],['false',false],['zero',0],['empty',''],['string','false']]){reset();const p=target.scrollIntoView(arg);const value=await p;result.arguments.push({name,promise:!!p&&typeof p.then==='function',value,positions:positions()})}
 result.invalid=[];for(const [name,arg] of [['behavior',{behavior:'bad'}],['block',{block:'bad'}],['container',{container:'bad'}],['inline',{inline:'bad'}]]){try{const p=target.scrollIntoView(arg);result.invalid.push({name,status:'fulfilled',value:await p})}catch(error){result.invalid.push({name,status:'rejected',error:error.name})}}
 const order=[],options={};for(const key of ['behavior','block','container','inline'])Object.defineProperty(options,key,{get(){order.push(key);return undefined}});await target.scrollIntoView(options);result.getterOrder=order;
 try{await Element.prototype.scrollIntoView.call({});result.receiver='fulfilled'}catch(error){result.receiver=error.name}
 result.detached=await document.createElement('div').scrollIntoView();return {contract:result}}
 `;
  return `(()=>{const mode=${JSON.stringify(mode)},setup=${JSON.stringify(setup)};
 const outer=document.getElementById('outer'),inner=document.getElementById('inner');
 function positions(){return {root:{left:scrollX,top:scrollY},outer:{left:outer.scrollLeft,top:outer.scrollTop},inner:{left:inner.scrollLeft,top:inner.scrollTop}}}
 function reset(){window.scrollTo({left:0,top:0,behavior:'instant'});outer.scrollTo({left:0,top:0,behavior:'instant'});inner.scrollTo({left:0,top:0,behavior:'instant'})}
 function read(){const e=document.getElementById('target'),r=e&&e.getBoundingClientRect();return {positions:positions(),rect:r?[r.x,r.y,r.width,r.height].map(v=>+v.toFixed(4)):null}}
 ${mode === 'contract' ? contract : ''}
 document.getElementById('run').addEventListener('click',async()=>{
  ${mode === 'contract' ? "document.getElementById('probe').textContent=JSON.stringify(await contract());return;" : ''}
  async function go(){const before=read();let target=document.getElementById('target');if(mode==='append-await'){target=document.createElement('div');target.id='target';document.getElementById('innerSpace').appendChild(target)}
   const promise=${mode === 'replacement' ? "target.scrollIntoView({behavior:'smooth',block:'start'})" : call};
   ${mode === 'replacement' ? "const replacement=target.scrollIntoView({behavior:'instant',block:'end',inline:'end'});" : ''}
   const immediate=mode==='append-await'?null:read(),value=await promise;
   ${mode === 'replacement' ? 'await replacement;' : ''}
   const awaited=read();let start=null;function finish(time){if(start===null)start=time;if(time-start<${['smooth', 'css-smooth'].includes(mode) ? 650 : 30}){requestAnimationFrame(finish);return}document.getElementById('probe').textContent=JSON.stringify({promise:!!promise&&typeof promise.then==='function',value,before,immediate,awaited,settled:read()})}requestAnimationFrame(finish);
  }
  if(setup){window.scrollTo({top:setup.root,behavior:'instant'});outer.scrollTo({left:setup.outer[0],top:setup.outer[1],behavior:'instant'});inner.scrollTo({left:setup.inner[0],top:setup.inner[1],behavior:'instant'});requestAnimationFrame(go)}else go();
 });})();`;
}
