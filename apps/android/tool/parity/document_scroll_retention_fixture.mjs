export const scrollRetentionHTML = `<!doctype html><html><head><style>
html,body{margin:0;padding:0}body{height:2200px}
#outer{margin-top:220px;width:220px;height:140px;overflow:auto}
#content{width:800px;height:900px;padding-top:140px;box-sizing:border-box;background:#ddd}
#inner{width:180px;height:110px;overflow:auto}
#target{width:650px;height:800px;padding-top:120px;padding-left:180px;box-sizing:border-box;background:#369}
#link{display:block;box-sizing:border-box;width:80px;height:32px;margin:0;padding:0;border:0;background:#f90;color:#000}
</style></head><body><div id="outer"><div id="content"><div id="inner"><div id="target"><a id="link" href="/clicked">Tap target</a></div></div></div></div></body></html>`;

export function setScrollRetentionOffsets(multiplier) {
  window.scrollTo(0, 100 * multiplier);
  document.getElementById('outer').scrollTo(30 * multiplier, 120 * multiplier);
  document.getElementById('inner').scrollTo(50 * multiplier, 90 * multiplier);
}

export function readScrollRetentionState() {
  const scroll = {};
  for (const id of ['outer', 'inner']) {
    const e = document.getElementById(id);
    scroll[id] = {
      left: e.scrollLeft,
      top: e.scrollTop,
      width: e.scrollWidth,
      height: e.scrollHeight,
      clientWidth: e.clientWidth,
      clientHeight: e.clientHeight,
    };
  }
  return { root: window.scrollY, mode: history.scrollRestoration, scroll };
}

// The same synthetic driver is injected in Chromium and the Android sandbox.
export const scrollRetentionDriver = `(() => {
const setOffsets = ${setScrollRetentionOffsets.toString()};
const readState = ${readScrollRetentionState.toString()};
let sequence = 0, step = 0;
const probe = document.createElement('pre');
probe.id = 'retention-probe';
probe.style.cssText = 'position:fixed;top:56px;left:16px;width:180px;height:20px;overflow:hidden;margin:0;padding:0;';
document.body.appendChild(probe);
function record() {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    probe.textContent = JSON.stringify({...readState(),sequence:++sequence,step});
  }));
}
for(const [name,left,handler] of [
  ['Step','16px',() => {setOffsets(++step);record()}],
  ['Read','112px',record],
]) {
  const button = document.createElement('button');
  button.textContent = name;
  button.style.cssText = 'position:fixed;top:12px;left:'+left+';width:80px;height:32px;margin:0;padding:0;border:0;';
  button.addEventListener('click',handler);
  document.body.appendChild(button);
}
record();
})();`;
