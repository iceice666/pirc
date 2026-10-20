export const dialogRequestHTML = `<!doctype html><html><head><style>
body{margin:0;font:16px/24px Arial;background:white;color:black}
button,input{font:16px/24px Arial}button{display:block;width:180px;height:32px;margin:0;padding:0;border:0;box-sizing:border-box}
dialog{position:static;margin:0;padding:0;border:0;width:240px;height:160px;background:#204060;color:white}
</style></head><body><button id="open" onclick="document.getElementById('dialog').show()">Open</button><dialog id="dialog"><input id="draft" autofocus value="ready"><button type="button" id="request" onclick="document.getElementById('dialog').requestClose('discarded')">Request close</button><button type="button" id="allow" onclick="document.getElementById('dialog').oncancel=()=>{window.notes.push('allowed')}">Allow close</button><button type="button" id="force" onclick="document.getElementById('dialog').close('forced')">Force close</button></dialog><script>
window.events=[];window.notes=[];
const dialog=document.getElementById('dialog');
dialog.oncancel=()=>{notes.push('blocked');return false};
for(const type of ['beforetoggle','toggle','cancel','close']) document.addEventListener(type,e=>events.push({type:e.type,id:e.target.id,old:e.oldState??null,new:e.newState??null,source:e.source?.id||null,bubbles:e.bubbles,cancelable:e.cancelable,trusted:e.isTrusted}),true);
</script></body></html>`;
export const dialogRequestCases = [
  { name: 'close-with-value', script: 'd.requestClose("saved")' },
  { name: 'preserve-value', setup: 'd.returnValue="keep"', script: 'd.requestClose()' },
  { name: 'undefined-value', setup: 'd.returnValue="keep"', script: 'd.requestClose(undefined)' },
  { name: 'null-value', script: 'd.requestClose(null)' },
  { name: 'numeric-value', script: 'd.requestClose(42)' },
  { name: 'empty-value', setup: 'd.returnValue="keep"', script: 'd.requestClose("")' },
  { name: 'closed-noop', closed: true, script: 'd.requestClose("ignored")' },
  { name: 'manual-open', closed: true, setup: 'd.open=true', script: 'd.requestClose("manual")' },
  { name: 'detached-noop', setup: 'd.remove()', script: 'd.requestClose("ignored")' },
  {
    name: 'detached-initial-open',
    closed: true,
    setup: 'd.remove();d.open=true',
    script: 'd.requestClose("ignored")',
  },
  {
    name: 'removed-and-reinserted',
    setup: 'd.remove();document.body.appendChild(d)',
    script: 'd.requestClose("reinserted")',
  },
  {
    name: 'cancel-listener',
    setup: 'd.addEventListener("cancel",e=>e.preventDefault())',
    script: 'd.requestClose("ignored")',
  },
  {
    name: 'cancel-property-false',
    setup: 'd.oncancel=()=>{notes.push("property");return false}',
    script: 'd.requestClose("ignored")',
  },
  {
    name: 'cancel-attribute-false',
    setup: 'd.setAttribute("oncancel","notes.push(\\"attribute\\");return false")',
    script: 'd.requestClose("ignored")',
  },
  {
    name: 'attribute-then-property',
    setup:
      'd.setAttribute("oncancel","notes.push(\\"attribute\\");return false");d.oncancel=()=>notes.push("property")',
    script: 'd.requestClose("property")',
  },
  {
    name: 'property-then-attribute',
    setup:
      'd.oncancel=()=>notes.push("property");d.setAttribute("oncancel","notes.push(\\"attribute\\");return false")',
    script: 'd.requestClose("ignored")',
  },
  {
    name: 'remove-present-attribute',
    setup:
      'd.setAttribute("oncancel","notes.push(\\"attribute\\");return false");d.oncancel=()=>{notes.push("property");return false};d.removeAttribute("oncancel")',
    script: 'd.requestClose("removed")',
  },
  {
    name: 'remove-absent-attribute',
    setup: 'd.oncancel=()=>{notes.push("property");return false};d.removeAttribute("oncancel")',
    script: 'd.requestClose("ignored")',
  },
  {
    name: 'same-attribute-after-property',
    setup:
      'd.setAttribute("oncancel","notes.push(\\"attribute\\");return false");d.oncancel=()=>notes.push("property");d.setAttribute("oncancel","notes.push(\\"attribute\\");return false")',
    script: 'd.requestClose("ignored")',
  },
  {
    name: 'attribute-node-replaces-property',
    setup:
      'd.oncancel=()=>notes.push("property");const a=document.createAttribute("oncancel");a.value="return false";d.setAttributeNode(a)',
    script: 'd.requestClose("ignored")',
  },
  {
    name: 'attribute-value-replaces-property',
    setup:
      'd.setAttribute("oncancel","return false");d.oncancel=()=>notes.push("property");d.getAttributeNode("oncancel").value="return false"',
    script: 'd.requestClose("ignored")',
  },
  {
    name: 'remove-attribute-node',
    setup:
      'd.setAttribute("oncancel","return false");d.oncancel=()=>false;d.removeAttributeNode(d.getAttributeNode("oncancel"))',
    script: 'd.requestClose("removed")',
  },
  {
    name: 'toggle-attribute-removal',
    setup:
      'd.setAttribute("oncancel","return false");d.oncancel=()=>false;d.toggleAttribute("oncancel",false)',
    script: 'd.requestClose("removed")',
  },
  {
    name: 'handler-slot-order',
    setup:
      'd.addEventListener("cancel",()=>notes.push("before"));d.oncancel=()=>notes.push("old");d.addEventListener("cancel",()=>notes.push("after"));d.oncancel=()=>notes.push("new")',
    script: 'd.requestClose("ordered")',
  },
  {
    name: 'handler-null-new-slot',
    setup:
      'd.oncancel=()=>notes.push("old");d.addEventListener("cancel",()=>notes.push("before"));d.oncancel=null;d.oncancel=()=>notes.push("new")',
    script: 'd.requestClose("ordered")',
  },
  {
    name: 'handler-replacement-in-dispatch',
    setup:
      'd.addEventListener("cancel",()=>{d.oncancel=()=>{notes.push("replacement");return false}});d.oncancel=()=>notes.push("old")',
    script: 'd.requestClose("ignored")',
  },
  {
    name: 'handler-close',
    setup: 'd.addEventListener("cancel",()=>d.close("handler"))',
    script: 'd.requestClose("outer")',
  },
  {
    name: 'handler-removes-open',
    setup: 'd.addEventListener("cancel",()=>d.open=false)',
    script: 'd.requestClose("ignored")',
  },
  {
    name: 'handler-removes-and-reinserts',
    setup: 'd.addEventListener("cancel",()=>{d.remove();document.body.appendChild(d)})',
    script: 'd.requestClose("ignored")',
  },
  {
    name: 'handler-removes-dialog',
    setup: 'd.addEventListener("cancel",()=>d.remove())',
    script: 'd.requestClose("outer")',
  },
  {
    name: 'recursive-request',
    setup: 'd.addEventListener("cancel",()=>{notes.push("cancel");d.requestClose("inner")})',
    script: 'd.requestClose("outer")',
  },
  {
    name: 'recursive-request-canceled',
    setup:
      'd.addEventListener("cancel",e=>{notes.push("cancel");d.requestClose("inner");e.preventDefault()})',
    script: 'd.requestClose("outer")',
  },
  {
    name: 'recursive-request-closedby-any',
    setup:
      'd.setAttribute("closedby","any");d.addEventListener("cancel",()=>{notes.push("cancel");d.requestClose("inner")})',
    script: 'd.requestClose("outer")',
  },
  {
    name: 'recursive-request-closedby-closerequest',
    setup:
      'd.setAttribute("closedby","closerequest");d.addEventListener("cancel",()=>{notes.push("cancel");d.requestClose("inner")})',
    script: 'd.requestClose("outer")',
  },
  {
    name: 'author-close-override',
    setup: 'd.close=()=>{throw Error("authored close called")}',
    script: 'd.requestClose("internal")',
  },
  {
    name: 'closedby-none-forced',
    setup: 'd.setAttribute("closedby","none")',
    script: 'd.requestClose("forced")',
  },
  {
    name: 'close-handler-attribute-property',
    setup:
      'd.setAttribute("onclose","notes.push(\\"attribute\\")");d.onclose=()=>notes.push("property")',
    script: 'd.requestClose()',
  },
  {
    name: 'beforetoggle-return-false',
    closed: true,
    setup: 'd.onbeforetoggle=()=>false',
    script: 'd.show()',
  },
  {
    name: 'beforetoggle-property-replaces-attribute',
    closed: true,
    setup:
      'd.setAttribute("onbeforetoggle","return false");d.onbeforetoggle=()=>notes.push("property")',
    script: 'd.show()',
  },
  {
    name: 'beforetoggle-attribute-replaces-property',
    closed: true,
    setup:
      'd.onbeforetoggle=()=>notes.push("property");d.setAttribute("onbeforetoggle","return false")',
    script: 'd.show()',
  },
  {
    name: 'toggle-handler-order',
    setup:
      'd.addEventListener("toggle",()=>notes.push("before"));d.ontoggle=()=>notes.push("old");d.addEventListener("toggle",()=>notes.push("after"));d.ontoggle=()=>notes.push("new")',
    script: 'd.requestClose()',
  },
  {
    name: 'throwing-value-conversion',
    script: 'd.requestClose({toString(){throw Error("conversion")}})',
  },
  { name: 'symbol-value-closed', closed: true, script: 'd.requestClose(Symbol("bad"))' },
  {
    name: 'value-conversion-before-state',
    script: 'd.requestClose({toString(){d.close("conversion");return "outer"}})',
  },
];
export function runDialogRequestCase(row) {
  return `(()=>{const d=document.getElementById('dialog'),opener=document.getElementById('open');window.caseDialog=d;d.oncancel=null;opener.focus();${row.closed ? '' : 'd.show();'};${row.setup || ''};window.events=[];window.notes=[];window.failure=null;try{${row.script}}catch(e){window.failure={name:e.name}}})()`;
}
export const readDialogRequestState = `(()=>{const d=window.caseDialog||document.getElementById('dialog');return {open:d.open,connected:d.isConnected,value:d.returnValue,active:document.activeElement?.id||document.activeElement?.localName||null,notes:notes.slice(),events:events.slice(),failure:window.failure??null}})()`;
export const readDialogRequestVisualState = `(()=>{const d=document.getElementById('dialog');return {open:d.open,value:d.returnValue,draft:document.getElementById('draft').value,active:document.activeElement?.id||document.activeElement?.localName||null,notes:notes.splice(0),events:events.splice(0)}})()`;
