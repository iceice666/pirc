export const elementAnchorModes = [
  'expand',
  'shrink',
  'insert',
  'remove',
  'below',
  'owner_none',
  'ancestor_none',
  'subtree_none',
  'padding_border',
  'hidden_scroll',
  'clip_scroll',
  'at_top',
  'scroll_to',
  'scroll_by',
  'owner_resize',
  'replace_owner',
  'hide_show',
  'deep_inner',
  'deep_outer',
  'deep_both',
  'clamp_end',
];
export function buildElementAnchorPage(mode) {
  if (!elementAnchorModes.includes(mode)) throw Error('Unknown element anchor mode');
  const deep = mode.startsWith('deep_');
  const content =
    '<div id="above"></div><div id="content"><div id="prefix"></div></div><div id="below"></div>';
  const html = `<!doctype html><html id="root"><head><meta name="color-scheme" content="light dark"><style>
html,body{margin:0;padding:0;font:16px/20px monospace;background:#22c55e}
#outer{width:${mode === 'padding_border' ? '50%' : '240px'};height:240px;overflow:${mode === 'hidden_scroll' ? 'hidden' : mode === 'clip_scroll' ? 'clip' : 'auto'};margin:40px 0 0 20px;${mode === 'padding_border' ? 'padding:2%;border:2px solid #111;' : ''}}
#inner{width:200px;height:180px;overflow:auto}#above{height:120px;background:#334155}
#content{height:1800px;background:#3b82f6}#prefix{height:200px}#below{height:120px}
#outsideAbove{height:160px;background:#64748b}#outsideTail,#rootTail{height:1800px}#probe{display:none}
#advance{position:fixed;left:0;bottom:0;width:120px;height:24px;padding:0;border:0;z-index:1000}
${mode === 'owner_none' ? '#outer{overflow-anchor:none}' : ''}
${mode === 'ancestor_none' ? 'html{overflow-anchor:none}' : ''}
${mode === 'subtree_none' ? '#content{overflow-anchor:none}' : ''}
</style></head><body id="body"><div id="outer" data-generation="1">${deep ? '<div id="outsideAbove"></div><div id="inner">' + content + '</div><div id="outsideTail"></div>' : content}</div><div id="rootTail"></div><button id="advance" type="button">Advance</button><pre id="probe">WAIT</pre></body></html>`;
  const mutations = {
    expand: "above.style.height=phase===2?'240px':'80px';",
    shrink: "above.style.height=phase===2?'40px':'160px';",
    insert:
      "if(phase===2){var n=document.createElement('div');n.id='inserted';n.style.height='95px';above.parentNode.insertBefore(n,above);}else{document.getElementById('inserted').remove();}",
    remove:
      "if(phase===2)above.remove();else{var n=document.createElement('div');n.id='above';n.style.height='120px';outer.insertBefore(n,document.getElementById('content'));}",
    below: "document.getElementById('below').style.height=phase===2?'260px':'70px';",
    owner_resize:
      "outer.style.height=phase===2?'320px':'240px';above.style.height=phase===2?'240px':'80px';",
    replace_owner:
      "if(phase===2){var n=document.createElement('div');n.id='outer';n.dataset.generation='2';n.innerHTML=outer.innerHTML;outer.parentNode.replaceChild(n,outer);}else above.style.height='240px';",
    hide_show:
      "if(phase===2){outer.style.display='none';above.style.height='240px';}else outer.style.display='block';",
    deep_inner: "above.style.height=phase===2?'240px':'80px';",
    deep_outer: "document.getElementById('outsideAbove').style.height=phase===2?'280px':'80px';",
    deep_both:
      "above.style.height=phase===2?'240px':'80px';document.getElementById('outsideAbove').style.height=phase===2?'280px':'80px';",
    scroll_to: "above.style.height=phase===2?'240px':'80px';outer.scrollTo(0,phase===2?400:200);",
    scroll_by: "above.style.height=phase===2?'240px':'80px';outer.scrollBy(0,phase===2?30:-20);",
  };
  const mutation = mutations[mode] ?? "above.style.height=phase===2?'240px':'80px';";
  const driverSource = `(function(){var phase=0;function report(){var boxes={},scroll={};['root','body','outer','inner','above','content','prefix','below','inserted','outsideAbove','outsideTail','rootTail'].forEach(function(id){var e=document.getElementById(id);if(!e)return;var r=e.getBoundingClientRect();boxes[id]={x:r.x,y:r.y,width:r.width,height:r.height};if(id==='outer'||id==='inner')scroll[id]={top:e.scrollTop,left:e.scrollLeft,height:e.scrollHeight,width:e.scrollWidth,clientHeight:e.clientHeight,clientWidth:e.clientWidth,generation:e.dataset.generation||null};});document.getElementById('probe').textContent=JSON.stringify({phase:phase,scrollY:window.scrollY,scrollHeight:document.documentElement.scrollHeight,boxes:boxes,scroll:scroll});}
document.getElementById('advance').onclick=function(){phase++;var outer=document.getElementById('outer'),above=document.getElementById('above');if(phase===1){window.scrollTo(0,80);outer.scrollTo(0,${deep ? 200 : mode === 'at_top' ? 0 : mode === 'clamp_end' ? 99999 : 240});${deep ? "document.getElementById('inner').scrollTo(0,240);" : ''}}else{${mutation}}requestAnimationFrame(report);};document.addEventListener('DOMContentLoaded',function(){requestAnimationFrame(report);});})();`;
  return { html, driverSource };
}
