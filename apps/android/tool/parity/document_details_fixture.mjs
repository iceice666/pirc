export const detailsHTML = `<!doctype html><html><body>
<details id="first"><summary id="firstSummary">First <span id="label">section</span><a id="link" href="#other">Link</a><button id="insideButton">Button</button></summary><p>First body</p><details id="nested" open><summary id="nestedSummary">Nested</summary><p>Nested body</p></details><summary id="ordinarySummary">Ordinary body summary</summary><input id="draft" value="server"></details>
<details id="one" name="group" open><summary id="oneSummary">One</summary><p>One body</p></details>
<details id="two" name="group" open><summary id="twoSummary">Two</summary><p>Two body</p></details>
<details id="cancelled"><summary id="cancelledSummary" onclick="event.preventDefault()">Cancelled</summary><p>Cancelled body</p></details>
<div id="slot"></div>
<script>window.events=[]; window.captureToggle=function(e){events.push({id:e.target.id,old:e.oldState,new:e.newState,bubbles:e.bubbles,cancelable:e.cancelable,trusted:e.isTrusted,instance:e instanceof ToggleEvent,source:e.source===null});}; document.addEventListener('toggle',captureToggle,true);</script>
</body></html>`;
export const detailsActions = [
  { name: 'initial', script: '' },
  {
    name: 'summary-focus',
    script: `document.querySelector('#firstSummary').focus();window.summaryFocus=document.activeElement.id`,
  },
  {
    name: 'closed-control-focus',
    script: `document.querySelector('#draft').focus();document.querySelector('#nestedSummary').focus()`,
  },
  {
    name: 'property-open',
    script: `document.querySelector('#first').open=true;document.querySelector('#draft').value='retained draft'`,
  },
  { name: 'property-close', script: `document.querySelector('#first').open=false` },
  { name: 'truthy-boolean', script: `document.querySelector('#first').open='false'` },
  {
    name: 'false-attribute-still-open',
    script: `document.querySelector('#first').setAttribute('open','false')`,
  },
  { name: 'attribute-close', script: `document.querySelector('#first').removeAttribute('open')` },
  { name: 'descendant-click', script: `document.querySelector('#label').click()` },
  { name: 'non-primary-summary', script: `document.querySelector('#ordinarySummary').click()` },
  { name: 'interactive-child', script: `document.querySelector('#insideButton').click()` },
  { name: 'cancelled-click', script: `document.querySelector('#cancelledSummary').click()` },
  { name: 'second-summary', script: `document.querySelector('#twoSummary').click()` },
  { name: 'open-peer-by-property', script: `document.querySelector('#one').open=true` },
  {
    name: 'coalesced',
    script: `const d=document.querySelector('#first');d.open=false;d.open=true;d.open=false`,
  },
  {
    name: 'rename-open-member',
    script: `const d=document.querySelector('#first');d.open=true;d.name='group'`,
  },
  {
    name: 'empty-group-independent',
    script: `const d=document.querySelector('#first');d.name='';d.open=true`,
  },
  {
    name: 'insert-open-peer',
    script: `const d=document.createElement('details');d.id='inserted';d.name='group';d.open=true;d.innerHTML='<summary>Inserted</summary><p>Inserted body</p>';document.querySelector('#slot').append(d)`,
  },
  {
    name: 'toggle-attribute',
    script: `document.querySelector('#two').toggleAttribute('open',true)`,
  },
  {
    name: 'attribute-node-value',
    script: `document.querySelector('#first').getAttributeNode('name').value='group'`,
  },
  {
    name: 'attribute-node-insert',
    script: `const a=document.createAttribute('open');a.value='';document.querySelector('#inserted').setAttributeNode(a)`,
  },
  {
    name: 'fragment-own-group',
    script: `const f=document.createDocumentFragment();const a=document.createElement('details'),b=document.createElement('details');a.id='detachedA';b.id='detachedB';a.name=b.name='separate';f.append(a,b);a.open=true;b.open=true;window.detached=[a.open,b.open]`,
  },
  {
    name: 'parsed-insertion',
    script: `document.querySelector('#slot').innerHTML='<details id="parsedA" name="parsed" open><summary>Parsed A</summary></details><details id="parsedB" name="parsed" open><summary>Parsed B</summary></details>'`,
  },
  {
    name: 'property-toggle-handler',
    script: `const d=document.querySelector('#first');d.ontoggle=function(e){window.lastProperty=[this.id,e.oldState,e.newState]};d.open=true`,
  },
  {
    name: 'replace-inline-handler',
    script: `const d=document.querySelector('#first');d.setAttribute('ontoggle',"window.lastInline=[this.id,event.oldState,event.newState]");d.open=false`,
  },
  {
    name: 'override-inline-handler',
    script: `const d=document.querySelector('#first');d.ontoggle=function(e){window.lastOverride=e.newState};d.open=true`,
  },
  {
    name: 'remove-inline-handler',
    script: `const d=document.querySelector('#first');d.removeAttribute('ontoggle');d.open=false`,
  },
  {
    name: 'reentrant-toggle',
    script: `const d=document.querySelector('#first');d.addEventListener('toggle',function once(e){d.removeEventListener('toggle',once);d.open=false});d.open=true`,
  },
];
export const readDetailsState = `(() => ({details:Array.from(document.querySelectorAll('details'), d=>({id:d.id,open:d.open,attribute:d.hasAttribute('open'),name:d.name,instance:d instanceof HTMLDetailsElement})),events:window.events.splice(0),draft:document.querySelector('#draft').value,detached:window.detached||null,lastProperty:window.lastProperty||null,lastInline:window.lastInline||null,lastOverride:window.lastOverride||null,summaryFocus:window.summaryFocus||null,activeElement:document.activeElement?.id||'',summaries:Array.from(document.querySelectorAll('summary'),s=>({id:s.id,tabIndex:s.tabIndex}))}))()`;
