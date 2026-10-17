// Shared with the real-Chrome oracle; keep these raw strings directly extractable.
const resourceHtml = r'''<!doctype html><html><body>
<h1>Native resources</h1><p id="lifecycle">waiting</p><p id="result">waiting</p>
<button type="button" onclick="loadData()">Load live data</button>
<script>
window.order=['inline'];
window.documentOrigin='@ORIGIN@';
window.crossOrigin='@CROSS@';
document.addEventListener('DOMContentLoaded',function(){
  document.querySelector('#lifecycle').textContent=order.join(',');
});
window.addEventListener('load',function(){
  document.querySelector('#lifecycle').textContent+=';load:'+String(window.asyncReady);
});
</script>
<script src="/library.js"></script>
<script>order.push(formatLabel('blocking'));</script>
<script defer src="/defer.js"></script>
<script async src="/async.js"></script>
<script src="/missing.js" onerror="order.push('missing')"></script>
<script>
async function loadData() {
 try {
  const answer=await (await fetch('/api')).json();
  const post=await fetch(crossOrigin+'/cors',{method:'POST',headers:{'Content-Type':'application/json','X-Pirc-Test':'yes'},body:JSON.stringify({message:answer.message})});
  const echoed=await post.json();
  const missing=await fetch('/not-found');
  const empty=await fetch('/empty');
  const head=await fetch('/head',{method:'HEAD'});
  let denied=false; try { await fetch(crossOrigin+'/denied'); } catch (_) { denied=true; }
  document.querySelector('#result').textContent=answer.message+';'+echoed.message+';'+post.headers.get('x-result')+';'+missing.status+';cors-denied:'+denied+';empty:'+((await empty.text())==='')+';head:'+((await head.text())==='');
  const script=document.createElement('script');
  script.src='/dynamic.js';
  script.onload=function(){document.querySelector('#result').textContent+=';dynamic:'+window.dynamicReady;};
  script.onerror=function(){document.querySelector('#result').textContent+=';dynamic:error';};
  document.head.appendChild(script);
 } catch(error) { document.querySelector('#result').textContent='ERROR:'+error.message; }
}
</script></body></html>''';
const libraryScript =
    r'''window.formatLabel=function(value){return value.toUpperCase();};order.push('library');''';
const deferScript = r'''order.push('defer');''';
const asyncScript = r'''window.asyncReady=true;''';
const dynamicScript =
    r'''window.dynamicReady=document.currentScript.src.endsWith('/dynamic.js');''';
const expectedLifecycle = 'inline,library,BLOCKING,missing,defer;load:true';
const expectedResult =
    '原生資料;原生資料;visible;404;cors-denied:true;empty:true;head:true;dynamic:true';
