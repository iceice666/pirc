import { transformCBModes, transformCBHTML } from './document_transform_cb_fixture.mjs';
export const transformOffsetModes = [
  ...transformCBModes,
  'flow-own-transform',
  'flow-transformed-host',
  'flow-near-relative',
  'singular',
  'abs-initial',
  'absolute-body',
  'fixed-body-transform',
  'inside-fixed',
  'relative-half',
  'absolute-body-transform',
  'abs-html-edges',
];
const extra = {
  'absolute-body-transform':
    'body{margin:8px;border:3px solid;padding:16px;transform:translate(12px,8px) scale(1.1);transform-origin:0 0}#host{transform:none}#target{position:absolute}',
  'abs-html-edges':
    'html{margin:10px;padding:7px;border:3px solid}#host{transform:none}#target{position:absolute}',
  'flow-own-transform':
    '#host{transform:none}#target{position:static;transform:translate(80px,40px) rotate(10deg)}',
  'flow-transformed-host':
    '#host{transform:scale(1.3)}#target{position:static;margin-left:7.5px;margin-top:3.5px}',
  'flow-near-relative':
    '#host{transform:scale(1.2)}#middle{position:relative;left:11px;top:5px}#target{position:static;margin-left:7.5px}',
  singular: '#host{transform:scale(0)}',
  'abs-initial': '#host{transform:none}#target{position:absolute}',
  'absolute-body':
    'body{margin:8px;border:3px solid;padding:16px;position:relative}#host{transform:none}#target{position:absolute;left:10px;top:20px}',
  'fixed-body-transform':
    'body{margin:8px;border:3px solid;padding:16px;transform:translate(12px,8px) scale(1.1);transform-origin:0 0}#host{transform:none}',
  'inside-fixed': '#host{position:fixed;left:80px;top:80px;transform:none}#target{position:static}',
  'relative-half': '#host{transform:scale(1.2)}#target{position:relative;left:-7.5px;top:-.5px}',
};
export function transformOffsetHTML(mode) {
  if (!transformOffsetModes.includes(mode)) throw Error('Invalid transform offset mode');
  const base = transformCBHTML(transformCBModes.includes(mode) ? mode : 'fixed-static');
  return base
    .replace('<html>', '<html id="html">')
    .replace('<body>', '<body id="body">')
    .replace('</style>', `${extra[mode] || ''}</style>`);
}
export function buildTransformOffsetDriver() {
  return `(()=>{const host=document.getElementById('host'),scroller=document.getElementById('scroller');
 function read(){const result={};for(const id of ['host','middle','target','outside']){const e=document.getElementById(id),p=e.offsetParent;result[id]={left:e.offsetLeft,top:e.offsetTop,parentId:p?p.id:null,parentIdentity:p===null||p===document.getElementById(p.id),width:e.offsetWidth,height:e.offsetHeight}}return result}
 document.getElementById('run').addEventListener('click',()=>{const before=read();window.scrollTo({top:40,behavior:'instant'});scroller.scrollTo({top:20,behavior:'instant'});requestAnimationFrame(()=>{const scrolled=read();host.classList.add('changed');requestAnimationFrame(()=>{document.getElementById('probe').textContent=JSON.stringify({before,scrolled,changed:read()})})})});
})();`;
}
