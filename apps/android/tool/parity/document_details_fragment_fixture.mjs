export const detailsFragmentCases = [
  { id: 'nested', target: 'target' },
  { id: 'named-group', target: 'target', group: true },
  { id: 'summary-target', target: 'outerSummary' },
  { id: 'details-target', target: 'inner' },
  { id: 'scrollports', target: 'target', scrollports: true },
  { id: 'focus-target', target: 'target', input: true },
];
export function detailsFragmentHTML(spec, { scripted = false } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;font:16px/24px Arial;}*{box-sizing:border-box;}a.nav{display:block;height:24px;}summary{display:block;height:24px;line-height:24px;list-style:none;}details,summary,div,p,input{margin:0;border:0;padding:0;}#lead{height:700px;}#tail{height:1400px;}#peerBody{height:80px;}#gap{height:80px;}#innerGap{height:160px;}#target{display:block;width:100px;height:40px;font:16px/24px Arial;}#target:target{background:#123456;}#outerBody{${spec.scrollports ? 'height:180px;overflow:auto;' : ''}}#innerBody{${spec.scrollports ? 'height:150px;overflow:auto;' : ''}}#bodyTail{height:420px;}
</style></head><body>
<a class="nav" id="jump" href="#${spec.target}">Jump</a>
<div id="lead"></div>
<details id="peer" name="${spec.group ? 'group' : 'other'}" open><summary id="peerSummary">Peer</summary><div id="peerBody">Peer body</div></details>
<details id="outer" ${spec.group ? 'name="group"' : ''}><summary id="outerSummary">Outer</summary><div id="outerBody"><div id="gap"></div><details id="inner"><summary id="innerSummary">Inner</summary><div id="innerBody"><div id="innerGap"></div>${spec.input ? '<input id="target" value="draft">' : '<div id="target">Target body</div>'}<div id="bodyTail"></div></div></details></div></details>
<div id="tail"></div>${scripted ? '<script>window.toggles=[];document.addEventListener("toggle",e=>toggles.push([e.target.id,e.oldState,e.newState]),true);</script>' : ''}</body></html>`;
}
export const readDetailsFragmentState = `(() => {
 const target=document.getElementById(location.hash.slice(1)),r=target?.getBoundingClientRect();
 return {open:Object.fromEntries(['peer','outer','inner'].map(id=>[id,document.getElementById(id).open])),target:target?.id||null,focus:document.activeElement?.id||'',scrollY,rect:r?[r.x,r.y,r.width,r.height]:null,ports:Object.fromEntries(['outerBody','innerBody'].map(id=>[id,{top:document.getElementById(id).scrollTop,left:document.getElementById(id).scrollLeft}])),toggles:window.toggles?.splice(0)||[]};
})()`;
