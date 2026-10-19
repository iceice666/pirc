export const scriptPickerLifetimeHTML = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px/24px Arial}</style></head><body><form id="form"><input type="file" id="upload" name="upload" multiple><button type="button" id="choose">Choose files</button><button type="reset">Reset</button></form><script>
window.boots=(window.boots||0)+1; window.events=[];
const upload=document.getElementById('upload');
document.getElementById('choose').addEventListener('click',()=>upload.click());
for(const type of ['input','change','cancel']) upload.addEventListener(type,e=>events.push({type:e.type,trusted:e.isTrusted}));
</script></body></html>`;
export const pickedFiles = [
  { name: 'picked-雪.txt', type: 'text/plain', bytes: [80, 73, 67, 75, 69, 68] },
  { name: 'binary.png', type: 'image/png', bytes: [0, 127, 128, 255] },
];
export const readScriptPickerState = async () => {
  const upload = document.getElementById('upload');
  const files = await Promise.all(
    Array.from(upload.files, async (f) => ({
      name: f.name,
      type: f.type,
      bytes: Array.from(new Uint8Array(await f.arrayBuffer())),
    })),
  );
  return {
    boots: window.boots,
    events: window.events,
    files,
    formNames: Array.from(new FormData(document.getElementById('form')).values(), (f) => f.name),
  };
};
