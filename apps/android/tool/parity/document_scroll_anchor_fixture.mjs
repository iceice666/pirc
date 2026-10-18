export const scrollAnchorModes = [
  'expand',
  'shrink',
  'insert',
  'remove',
  'below',
  'nested_partial',
  'fully_visible',
  'anchor_removed',
  'anchor_height',
  'ancestor_padding',
  'anchor_margin',
  'root_none',
  'subtree_none',
  'at_top',
  'scroll_to',
  'scroll_by',
  'root_padding',
  'clamp_end',
];

export function buildScrollAnchorPage(mode) {
  if (!scrollAnchorModes.includes(mode)) throw Error('Unknown anchoring mode');
  const nested = mode === 'nested_partial' || mode === 'fully_visible' || mode === 'anchor_removed';
  const html = `<!doctype html><html id="root"><head><meta name="color-scheme" content="light dark"><style>
html,body{margin:0;padding:0;font:16px/20px monospace;background:#22c55e}
#above{height:120px;background:#334155}#prefix{height:200px}
#content{${nested ? '' : 'height:1800px;'}background:#3b82f6}
#row{height:${mode === 'fully_visible' ? 40 : 900}px;background:#f97316}
#tail{height:1800px}#below{height:120px}#probe{display:none}
#advance{position:fixed;left:0;bottom:0;width:120px;height:24px;padding:0;border:0;z-index:1000}
${mode === 'root_none' ? 'html{overflow-anchor:none}' : ''}
${mode === 'subtree_none' ? '#content{overflow-anchor:none}' : ''}
</style></head><body id="body"><div id="above"></div><div id="content"><div id="prefix"></div>${nested ? '<div id="row"></div><div id="tail"></div>' : ''}</div><div id="below"></div><button id="advance" type="button">Advance</button><pre id="probe">WAIT</pre></body></html>`;
  const mutations = {
    expand: "above.style.height=phase===2?'240px':'80px';",
    shrink: "above.style.height=phase===2?'40px':'160px';",
    insert:
      "if(phase===2){var n=document.createElement('div');n.id='inserted';n.style.height='95px';above.parentNode.insertBefore(n,above);}else{document.getElementById('inserted').remove();}",
    remove:
      "if(phase===2){above.remove();}else{var n=document.createElement('div');n.id='above';n.style.height='120px';document.body.insertBefore(n,content);}",
    below: "document.getElementById('below').style.height=phase===2?'260px':'70px';",
    nested_partial: "document.getElementById('prefix').style.height=phase===2?'280px':'100px';",
    fully_visible: "document.getElementById('prefix').style.height=phase===2?'280px':'100px';",
    anchor_removed:
      "if(phase===2)document.getElementById('row').remove();else document.getElementById('prefix').style.height='100px';",
    anchor_height:
      "above.style.height=phase===2?'240px':'80px';content.style.height=phase===2?'1900px':'1800px';",
    ancestor_padding:
      "content.style.paddingTop=phase===2?'70px':'0px';document.getElementById('prefix').style.height=phase===2?'280px':'200px';",
    anchor_margin: "content.style.marginTop=phase===2?'70px':'0px';",
    root_none: "above.style.height=phase===2?'240px':'80px';",
    subtree_none: "above.style.height=phase===2?'240px':'80px';",
    at_top: "above.style.height=phase===2?'240px':'80px';",
    scroll_to: "above.style.height=phase===2?'240px':'80px';window.scrollTo(0,phase===2?400:200);",
    scroll_by: "above.style.height=phase===2?'240px':'80px';window.scrollBy(0,phase===2?30:-20);",
    root_padding: "document.documentElement.style.paddingTop=phase===2?'50px':'0px';",
    clamp_end: "above.style.height=phase===2?'40px':'160px';",
  };
  const driverSource = `(function(){var phase=0;function report(){var boxes={};['root','body','above','content','prefix','row','tail','below','inserted'].forEach(function(id){var e=document.getElementById(id);if(e){var r=e.getBoundingClientRect();boxes[id]={x:r.x,y:r.y,width:r.width,height:r.height};}});document.getElementById('probe').textContent=JSON.stringify({phase:phase,scrollY:window.scrollY,scrollHeight:document.documentElement.scrollHeight,boxes:boxes});}
document.getElementById('advance').onclick=function(){phase++;if(phase===1){window.scrollTo(0,${mode === 'at_top' ? 0 : mode === 'clamp_end' ? 99999 : mode === 'fully_visible' ? 320 : nested ? 340 : 240});}else{var above=document.getElementById('above'),content=document.getElementById('content');${mutations[mode]}}requestAnimationFrame(report);};document.addEventListener('DOMContentLoaded',function(){requestAnimationFrame(report);});})();`;
  return { html, driverSource };
}
