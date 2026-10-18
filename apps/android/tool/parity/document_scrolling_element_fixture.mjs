import { scrollCommandsHTML } from './document_scroll_commands_fixture.mjs';
const strict =
  '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">';
const transitional =
  '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">';
export const scrollingElementCases = [
  { mode: 'standards', doctype: '<!doctype html>', root: 'visible', body: 'visible' },
  { mode: 'standards-root-hidden', doctype: '<!doctype html>', root: 'hidden', body: 'auto' },
  { mode: 'quirks-default', doctype: '', root: 'visible', body: 'visible' },
  { mode: 'quirks-body-auto', doctype: '', root: 'visible', body: 'auto' },
  { mode: 'quirks-root-hidden', doctype: '', root: 'hidden', body: 'auto' },
  { mode: 'quirks-root-clip', doctype: '', root: 'clip', body: 'auto' },
  { mode: 'quirks-body-clip', doctype: '', root: 'hidden', body: 'clip' },
  { mode: 'quirks-body-hidden', doctype: '', root: 'hidden', body: 'hidden' },
  { mode: 'legacy-strict', doctype: strict, root: 'visible', body: 'visible' },
  { mode: 'legacy-limited', doctype: transitional, root: 'visible', body: 'visible' },
  {
    mode: 'legacy-quirks',
    doctype: '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">',
    root: 'visible',
    body: 'visible',
  },
];
export function scrollingElementHTML(mode) {
  const c = scrollingElementCases.find((c) => c.mode === mode);
  if (!c) throw Error('Invalid scrolling element case');
  return scrollCommandsHTML
    .replace('<!doctype html>', c.doctype)
    .replace('<style>', `<style>html{overflow:${c.root}}body{overflow:${c.body}}`);
}
export function buildScrollingElementDriver() {
  return `(()=>{
 function read(){const e=document.scrollingElement;return {owner:e?e.tagName:null,compatMode:document.compatMode,root:{left:scrollX,top:scrollY},ownerMetrics:e?{left:e.scrollLeft,top:e.scrollTop,width:e.scrollWidth,height:e.scrollHeight,clientWidth:e.clientWidth,clientHeight:e.clientHeight}:null}}
 document.getElementById('run').addEventListener('click',()=>{const trace=[read()],e=document.scrollingElement;
 if(e){e.scrollTop+=20;trace.push(read());e.scrollTop+=20;trace.push(read());e.scrollTo({top:90,behavior:'instant'});trace.push(read());e.scrollBy({top:20,behavior:'instant'});trace.push(read())}else{window.scrollTo({top:40,behavior:'instant'});trace.push(read())}
 const immediate=read();window.scrollingElementTrace=trace;window.scrollingElementImmediate=immediate;
 let start=null;function frame(time){if(start===null)start=time;if(time-start<200){requestAnimationFrame(frame);return}document.getElementById('probe').textContent=JSON.stringify({trace,immediate,settled:read()})}requestAnimationFrame(frame);
 });})();`;
}
