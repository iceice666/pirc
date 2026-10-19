export const dialogFormHTML = `<!doctype html><html><head><style>body{margin:0;font:16px/24px Arial;background:white;color:black}#open{display:block;box-sizing:border-box;width:180px;height:32px;margin:0;padding:0;border:0}dialog{position:static;margin:0;padding:0;border:0;width:180px;height:96px;background:#204060;color:white}button,input{font:16px/24px Arial}#outside{display:none}</style></head><body><button id="open" type="button" onclick="document.getElementById('dialog').open=true">Open</button><dialog id="dialog"><form id="form" method="dialog"><input id="required" name="draft" required value="ready"><button id="yes" value="yes">Accept</button><button id="skip" formnovalidate value="skip">Skip</button></form></dialog><form id="outside" method="dialog"><button id="outsideSubmit">Outside</button></form><button id="external" form="form" value="external">External</button><div id="status">Ready</div><script>
window.events=[]; window.prevent=false; window.closedCount=0;
for(const type of ['submit','formdata','beforetoggle','toggle','close','invalid'])document.addEventListener(type,e=>{if(e.type==='close'){closedCount++;document.getElementById('status').textContent='Closed: '+document.getElementById('dialog').returnValue;}events.push({type:e.type,id:e.target.id,submitter:e.submitter?.id||null,source:e.source?.id||null,old:e.oldState??null,new:e.newState??null,bubbles:e.bubbles,cancelable:e.cancelable,trusted:e.isTrusted});if(e.type==='submit'&&prevent)e.preventDefault();},true);
</script></body></html>`;
export const dialogFormActions = [
  { name: 'initial', script: '' },
  { name: 'open-attribute', script: 'document.getElementById("dialog").open=true' },
  { name: 'accept', script: 'document.getElementById("yes").click()' },
  {
    name: 'cancel-submit',
    script:
      'document.getElementById("dialog").open=true;window.prevent=true;document.getElementById("yes").click();window.prevent=false',
  },
  {
    name: 'invalid',
    script:
      'document.getElementById("required").value="";document.getElementById("form").requestSubmit(document.getElementById("yes"))',
  },
  { name: 'skip-validation', script: 'document.getElementById("skip").click()' },
  {
    name: 'request-no-submitter',
    script:
      'const d=document.getElementById("dialog");d.open=true;d.returnValue="kept";document.getElementById("required").value="ready";document.getElementById("form").requestSubmit()',
  },
  {
    name: 'direct-submit',
    script:
      'document.getElementById("dialog").open=true;document.getElementById("required").value="";document.getElementById("form").submit()',
  },
  { name: 'outside-dialog', script: 'document.getElementById("outside").requestSubmit()' },
  {
    name: 'external-submitter',
    script:
      'document.getElementById("dialog").open=true;document.getElementById("required").value="ready";document.getElementById("external").click()',
  },
  {
    name: 'close-manually',
    script:
      'document.getElementById("dialog").open=true;document.getElementById("dialog").close("manual")',
  },
  { name: 'close-closed', script: 'document.getElementById("dialog").close("ignored")' },
  {
    name: 'close-undefined',
    script:
      'document.getElementById("dialog").open=true;document.getElementById("dialog").close(undefined)',
  },
  {
    name: 'property-handler',
    script:
      'const d=document.getElementById("dialog");d.onclose=()=>window.handler="property";d.open=true;d.close()',
  },
  {
    name: 'empty-return',
    script: 'const d=document.getElementById("dialog");d.open=true;d.close("")',
  },
];
export const readDialogFormState = `(()=>({open:document.getElementById('dialog').open,attribute:document.getElementById('dialog').hasAttribute('open'),value:document.getElementById('dialog').returnValue,draft:document.getElementById('required').value,events:events.splice(0),handler:window.handler||null,instance:document.getElementById('dialog') instanceof HTMLDialogElement}))()`;

export const readDialogFormVisualState = `(()=>{const d=document.getElementById('dialog'),css=getComputedStyle(d),r=d.getBoundingClientRect();return {...${readDialogFormState},display:css.display,background:css.backgroundColor,rect:css.display==='none'?null:[r.x,r.y,r.width,r.height]};})()`;
