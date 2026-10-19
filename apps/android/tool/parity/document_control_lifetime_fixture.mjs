export const controlLifetimeHTML = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px/24px Arial;}input,textarea,select{display:block;margin:4px 0;}input[type=checkbox],input[type=radio]{display:inline-block;}</style></head><body><form id="form">
<input id="text" name="text" value="initial"><input id="off" name="off" autocomplete="off" value="original"><input id="password" name="password" type="password" value="server" autocomplete="off"><textarea id="notes" name="notes">initial notes</textarea>
<input id="check" name="check" type="checkbox" autocomplete="off"><input id="radioA" type="radio" name="choice" value="a" checked autocomplete="off"><input id="radioB" type="radio" name="choice" value="b" autocomplete="off">
<select id="select" name="select" autocomplete="off"><option value="a">A</option><option value="b">B</option></select><input id="range" name="range" type="range" value="10" autocomplete="off"><input id="date" name="date" type="date" value="2024-06-15" autocomplete="off"><input id="file" name="file" type="file" multiple><button type="reset">Reset</button></form></body></html>`;
export const editedControlValues = {
  text: '草稿🙂還在',
  off: 'private off value',
  password: 'synthetic password',
  notes: '第一行\n第二行',
  check: true,
  choice: 'b',
  select: 'b',
  range: '73',
  date: '2025-10-30',
};
export const readControlLifetimeState = async () => {
  const q = (id) => document.getElementById(id),
    values = Object.fromEntries(
      ['text', 'off', 'password', 'notes', 'select', 'range', 'date'].map((id) => [
        id,
        q(id).value,
      ]),
    );
  values.check = q('check').checked;
  values.choice = q('radioB').checked ? 'b' : q('radioA').checked ? 'a' : '';
  return {
    values,
    selection: [q('text').selectionStart, q('text').selectionEnd],
    files: await Promise.all(
      Array.from(q('file').files, async (f) => ({
        name: f.name,
        type: f.type,
        bytes: Array.from(new Uint8Array(await f.arrayBuffer())),
      })),
    ),
  };
};
