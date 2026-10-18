export const fragmentScenes = {
  basic: { hash: '#destination', nodes: [['div', 'id', 'destination']] },
  'top-id': { hash: '#top', nodes: [['div', 'id', 'top']] },
  'top-name': { hash: '#top', nodes: [['a', 'name', 'top']] },
  'top-fallback': { hash: '#ToP', nodes: [['div', 'id', 'destination']] },
  'encoded-top': { hash: '#%74op', nodes: [['div', 'id', 'destination']] },
  empty: { hash: '#', nodes: [['div', 'id', 'destination']] },
  missing: { hash: '#missing', nodes: [['div', 'id', 'destination']] },
  unicode: { hash: '#%E7%AB%A0%E7%AF%80', nodes: [['div', 'id', '章節']] },
  plus: { hash: '#a+b', nodes: [['div', 'id', 'a+b']] },
  'encoded-plus': { hash: '#a%2Bb', nodes: [['div', 'id', 'a+b']] },
  'raw-id': {
    hash: '#a%20b',
    nodes: [
      ['div', 'id', 'a b'],
      ['div', 'id', 'a%20b'],
    ],
  },
  'raw-name': {
    hash: '#a%20b',
    nodes: [
      ['div', 'id', 'a b'],
      ['a', 'name', 'a%20b'],
    ],
  },
  'id-over-name': {
    hash: '#same',
    nodes: [
      ['a', 'name', 'same'],
      ['div', 'id', 'same'],
    ],
  },
  'duplicate-id': {
    hash: '#same',
    nodes: [
      ['div', 'id', 'same'],
      ['div', 'id', 'same'],
    ],
  },
  'duplicate-name': {
    hash: '#same',
    nodes: [
      ['a', 'name', 'same'],
      ['a', 'name', 'same'],
    ],
  },
  'nonanchor-name': { hash: '#same', nodes: [['div', 'name', 'same']] },
  'encoded-invalid': { hash: '#bad%ZZ', nodes: [['div', 'id', 'bad%ZZ']] },
  'malformed-utf8': { hash: '#%FF', nodes: [['div', 'id', '�']] },
  'hidden-top': { hash: '#top', nodes: [['div', 'id', 'top']], hidden: true },
};
const esc = (v) =>
  String(v).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
export function fragmentHTML(mode) {
  const scene = fragmentScenes[mode];
  if (!scene) throw Error(mode);
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}body{height:4000px}#jump{position:fixed;top:20px;left:16px;display:block;width:140px;height:32px;margin:0;padding:0} .target{display:block;height:40px;margin:0;padding:0;border:0}</style></head><body><a id="jump" href="${esc(scene.hash)}">Jump</a><div style="height:1000px"></div>${scene.nodes.map(([tag, attr, value], i) => `${i ? '<div style="height:560px"></div>' : ''}<${tag} ${attr}="${esc(value)}" data-target="target-${i}" class="target"${scene.hidden ? ' style="display:none"' : ''}></${tag}>`).join('')}</body></html>`;
}
