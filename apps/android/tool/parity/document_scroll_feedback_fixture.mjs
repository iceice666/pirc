import { scrollCommandsHTML } from './document_scroll_commands_fixture.mjs';
export const scrollFeedbackHTML = scrollCommandsHTML;
export const scrollFeedbackModes = [
  'setter-add',
  'setter-clamp',
  'mixed-relative',
  'smooth-then-setter',
  'promise-add',
  'raf-add',
];
export function buildScrollFeedbackDriver(mode, target) {
  if (!scrollFeedbackModes.includes(mode) || !['root', 'element'].includes(target))
    throw Error('Invalid feedback fixture');
  return `(()=>{const mode=${JSON.stringify(mode)},target=${JSON.stringify(target)};
  const port=document.getElementById('port'),root=document.documentElement;
  function read(){return {root:{left:scrollX,top:scrollY},element:{left:port.scrollLeft,top:port.scrollTop},aliases:[pageXOffset,pageYOffset,root.scrollLeft,root.scrollTop]}}
  document.getElementById('run').addEventListener('click',()=>{
    const box=target==='root'?root:port,actor=target==='root'?window:port,trace=[];
    const record=()=>trace.push(read());
    function finish(){const immediate=read();window.feedbackTrace=trace;window.feedbackImmediate=immediate;let start=null;function frame(time){if(start===null)start=time;if(time-start<500){requestAnimationFrame(frame);return}document.getElementById('probe').textContent=JSON.stringify({trace,immediate,settled:read()})}requestAnimationFrame(frame)}
    if(mode==='setter-add'){box.scrollTop+=20;box.scrollLeft+=17;record();box.scrollTop+=20;box.scrollLeft+=17;record()}
    if(mode==='setter-clamp'){box.scrollTop=99999;box.scrollLeft=99999;record();box.scrollTop-=20;box.scrollLeft-=20;record()}
    if(mode==='mixed-relative'){actor.scrollTo({left:40,top:60,behavior:'instant'});record();actor.scrollBy({left:20,top:10,behavior:'instant'});record();box.scrollTop+=7;box.scrollLeft+=5;record()}
    if(mode==='smooth-then-setter'){actor.scrollTo({top:180,behavior:'smooth'});record();box.scrollTop+=20;record();box.scrollTop+=20;record()}
    if(mode==='promise-add'||mode==='raf-add'){box.scrollTop+=20;record();const next=()=>{box.scrollTop+=20;record();finish()};if(mode==='promise-add')Promise.resolve().then(next);else requestAnimationFrame(next);return}
    finish();
  });})();`;
}
