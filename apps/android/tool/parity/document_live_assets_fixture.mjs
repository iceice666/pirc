export const assetHTML = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px/24px Arial}button,input{display:block;box-sizing:border-box;width:180px;height:32px;margin:0;border:0;padding:0;font:16px/24px Arial}#status{height:24px}#panel{height:24px;background:#204060}#panel.module{height:72px}#photo,canvas{display:block;width:32px;height:32px;image-rendering:pixelated}</style></head><body><button id="style">Load style</button><button id="image">Load image</button><button id="module">Load module</button><input id="draft" value="initial"><div id="status">Idle</div><div id="panel"></div><img id="photo" alt="Picture"><canvas id="canvas" width="32" height="32"></canvas><script>
window.probe={boots:(window.probe?.boots||0)+1,style:0,image:0,entry:0,dep:0,runs:0,trace:[]};
const status=document.getElementById('status'),panel=document.getElementById('panel'),photo=document.getElementById('photo');
document.getElementById('style').onclick=()=>{const link=document.createElement('link');link.rel='stylesheet';link.href='/theme.css';link.onload=()=>{probe.style++;probe.trace.push('style');status.textContent='Style loaded';};document.head.appendChild(link);};
photo.onload=()=>{probe.image++;probe.trace.push('image');const ctx=document.getElementById('canvas').getContext('2d');ctx.imageSmoothingEnabled=false;ctx.drawImage(photo,0,0,32,32);status.textContent='Image loaded';};
document.getElementById('image').onclick=()=>{photo.src='/photo.png';};
document.getElementById('module').onclick=async()=>{const ns=await import('/entry.js');ns.run();status.textContent='Module loaded';};
</script></body></html>`;
export const assetCSS = '#panel{height:48px;background:rgb(96,48,32)}';
export const assetEntry =
  "import {value} from './dep.js';probe.entry++;probe.trace.push('entry');export function run(){probe.runs++;probe.trace.push('run');document.getElementById('panel').classList.add('module');document.getElementById('draft').value=value;}";
export const assetDep = "probe.dep++;probe.trace.push('dep');export const value='模組已載入🙂';";
export const assetPng =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8DwHwyBNBAw/AcAR8oI+ItOQ4UAAAAASUVORK5CYII=';
export const secondFetchPng =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEElEQVR4nGNgYGD4D8UQBgAd9AP9yOH2qAAAAABJRU5ErkJggg==';
export const readAssetState = () => {
  const rect = (id) => {
    const r = document.getElementById(id).getBoundingClientRect();
    return [r.x, r.y, r.width, r.height];
  };
  const photo = document.getElementById('photo');
  return {
    probe: window.probe,
    value: document.getElementById('draft').value,
    background: getComputedStyle(document.getElementById('panel')).backgroundColor,
    panel: rect('panel'),
    photo: rect('photo'),
    canvas: rect('canvas'),
    natural: [photo.naturalWidth, photo.naturalHeight],
  };
};

export const startupAssetHTML = assetHTML.replace(
  '<img id="photo"',
  '<img src="/photo.png" id="photo"',
);
