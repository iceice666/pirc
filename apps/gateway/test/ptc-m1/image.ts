/** Fixed synthetic image; the answer is supplied only through pixels, never browser metadata. */
import { deflateSync } from 'node:zlib';
export const IMAGE_ANSWER = 'Q7M2';
const glyphs = [
  ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
];
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const payload = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload));
  return Buffer.concat([size, payload, crc]);
}
export function syntheticScreenshot(): string {
  const width = 360,
    height = 150,
    scale = 10;
  const rows = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) {
    rows[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      if (x < 8 || x >= width - 8 || y < 8 || y >= height - 8) {
        rows[offset] = 20;
        rows[offset + 1] = 90;
        rows[offset + 2] = 180;
      }
      const gx = Math.floor((x - 65) / scale),
        gy = Math.floor((y - 40) / scale);
      const letter = Math.floor(gx / 6),
        col = gx % 6;
      if (
        gx >= 0 &&
        gy >= 0 &&
        gy < 7 &&
        letter < 4 &&
        col < 5 &&
        glyphs[letter]![gy]![col] === '1'
      )
        rows.fill(20, offset, offset + 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}
