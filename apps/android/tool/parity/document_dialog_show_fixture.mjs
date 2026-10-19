export const dialogShowHTML = `<!doctype html><html><head><style>
body{margin:0;font:16px/24px Arial;background:white;color:black}
button,input{font:16px/24px Arial}button{display:block;width:180px;height:32px;margin:0;padding:0;border:0;box-sizing:border-box}
dialog{position:static;margin:0;padding:0;border:0;width:240px;height:128px;background:#204060;color:white}
</style></head><body><button id="open" onclick="document.getElementById('dialog').show()">Open</button><dialog id="dialog"><form method="dialog"><input id="first" value="first"><input id="draft" autofocus value="ready"><button id="save" value="saved">Save</button></form></dialog><button id="outside">Outside</button><button id="close" onclick="document.getElementById('dialog').close()">Close</button><button id="empty" onclick="const d=document.getElementById('dialog');d.innerHTML='&lt;p&gt;Message&lt;/p&gt;';d.show()">Empty</button><script>
window.events=[];
for(const type of ['beforetoggle','toggle','close','focus','blur','focusin','focusout']) document.addEventListener(type,e=>events.push({type:e.type,id:e.target.id,old:e.oldState??null,new:e.newState??null,source:e.source?.id||null,related:e.relatedTarget?.id||null,bubbles:e.bubbles,cancelable:e.cancelable,trusted:e.isTrusted}),true);
</script></body></html>`;
export const dialogShowCases = [
  { name: 'autofocus', script: 'd.show()' },
  { name: 'first-control', setup: 'draft.removeAttribute("autofocus")', script: 'd.show()' },
  { name: 'dialog-autofocus', setup: 'd.setAttribute("autofocus","")', script: 'd.show()' },
  { name: 'fallback-dialog', setup: 'd.innerHTML="<p>Message</p>"', script: 'd.show()' },
  {
    name: 'negative-tabindex',
    setup: 'draft.removeAttribute("autofocus");first.setAttribute("tabindex","-1")',
    script: 'd.show()',
  },
  { name: 'negative-autofocus', setup: 'draft.setAttribute("tabindex","-1")', script: 'd.show()' },
  { name: 'disabled-autofocus', setup: 'draft.disabled=true', script: 'd.show()' },
  {
    name: 'hidden-first',
    setup: 'draft.removeAttribute("autofocus");first.style.display="none"',
    script: 'd.show()',
  },
  { name: 'inert-autofocus', setup: 'draft.setAttribute("inert","")', script: 'd.show()' },
  {
    name: 'closed-nested-dialog',
    setup: `d.innerHTML='<dialog><input autofocus id="nested"></dialog><button id="last">Last</button>'`,
    script: 'd.show()',
  },
  {
    name: 'cancel-opening',
    setup: 'd.addEventListener("beforetoggle",e=>e.preventDefault())',
    script: 'd.show()',
  },
  {
    name: 'handler-opens',
    setup: 'd.addEventListener("beforetoggle",()=>d.open=true,{once:true})',
    script: 'd.show()',
  },
  {
    name: 'handler-removes',
    setup: 'd.addEventListener("beforetoggle",()=>d.remove(),{once:true})',
    script: 'd.show()',
  },
  { name: 'already-open', setup: 'd.open=true', script: 'd.show()' },
  { name: 'repeat-show', script: 'd.show();outside.focus();d.show()' },
  { name: 'restore-focus', script: 'd.show();d.close("done")' },
  { name: 'keep-outside-focus', script: 'd.show();outside.focus();d.close("done")' },
  { name: 'removed-previous-focus', script: 'd.show();opener.remove();d.close()' },
  { name: 'disabled-previous-focus', script: 'd.show();opener.disabled=true;d.close()' },
  {
    name: 'author-focus-override',
    setup:
      'draft.focus=()=>{throw Error("author focus called")};opener.focus=()=>{throw Error("author restore called")}',
    script: 'd.show();d.close()',
  },
  { name: 'manual-open-no-restore', script: 'd.open=true;draft.focus();d.close()' },
  {
    name: 'focus-handler-redirect',
    setup: 'draft.addEventListener("focus",()=>outside.focus(),{once:true})',
    script: 'd.show();d.close()',
  },
  { name: 'detached-show', setup: 'd.remove()', script: 'd.show()' },
  { name: 'hidden-dialog', setup: 'd.style.display="none"', script: 'd.show()' },
];
export function runDialogShowCase(row) {
  return `(()=>{const d=document.getElementById('dialog'),draft=document.getElementById('draft'),first=document.getElementById('first'),opener=document.getElementById('open'),outside=document.getElementById('outside');opener.focus();${row.setup || ''};window.events=[];window.caseDialog=d;${row.script};})()`;
}
export const readDialogShowState = `(()=>{const d=window.caseDialog||document.getElementById('dialog');return {open:d.open,connected:d.isConnected,value:d.returnValue,active:document.activeElement?.id||document.activeElement?.localName||null,events:events.slice()}})()`;

export const readDialogShowVisualState = `(()=>{const d=document.getElementById('dialog'),css=getComputedStyle(d),r=d.getBoundingClientRect();return {open:d.open,value:d.returnValue,active:document.activeElement?.id||document.activeElement?.localName||null,draft:document.getElementById('draft')?.value||null,display:css.display,background:css.backgroundColor,rect:css.display==='none'?null:[r.x,r.y,r.width,r.height],events:events.splice(0).filter(e=>['beforetoggle','toggle','close'].includes(e.type))}})()`;
