#!/usr/bin/env node
// Generate a deterministic PNG camera fixture from the same `uqr` encoder
// used by the web device-pairing QR. This URI has a reserved .invalid host and
// a fake token; it cannot pair to a real gateway.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const FIXTURE_URI =
  'pirc://pair?url=https%3A%2F%2Ffixture.invalid&token=scanner-fixture-not-a-token';
const requireWebPackage = createRequire(new URL('../../../web/package.json', import.meta.url));
const { encode } = requireWebPackage('uqr');

const qr = encode(FIXTURE_URI, { ecc: 'M', border: 4 });
const modules = qr.data;
if (
  modules.length === 0 ||
  modules.some((row) => row.length !== modules.length)
) {
  throw new Error('uqr returned a non-square module matrix');
}

// Match the emulator's actual 1280x960 camera stream. A portrait-only fixture
// is cropped by imagefile camera input and can lose a QR finder corner.
const width = 1280;
const height = 960;
const qrPixels = 360;
const pixelsPerModule = qrPixels / modules.length;
if (!Number.isInteger(pixelsPerModule)) {
  throw new Error(`${qrPixels}px QR area does not divide into ${modules.length} modules`);
}
// The current emulator imagefile projection shifts the visible crop right;
// place the complete code in the observed camera field, with ample white border.
const left = 160;
const top = Math.floor((height - qrPixels) / 2);
const rowBytes = width * 4;
const stride = rowBytes + 1;
const raw = Buffer.alloc(stride * height);

for (let y = 0; y < height; y++) {
  const rowStart = y * stride;
  raw[rowStart] = 0; // PNG filter: None.
  raw.fill(255, rowStart + 1, rowStart + stride);
  const qrY = y - top;
  if (qrY < 0 || qrY >= qrPixels) continue;
  const moduleY = Math.floor(qrY / pixelsPerModule);
  for (let x = left; x < left + qrPixels; x++) {
    const moduleX = Math.floor((x - left) / pixelsPerModule);
    if (!modules[moduleY][moduleX]) continue;
    const pixel = rowStart + 1 + x * 4;
    raw[pixel] = 0;
    raw[pixel + 1] = 0;
    raw[pixel + 2] = 0;
    raw[pixel + 3] = 255;
  }
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(name, data) {
  const type = Buffer.from(name, 'ascii');
  const payload = Buffer.concat([type, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(payload), 0);
  return Buffer.concat([length, payload, checksum]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(width, 0);
header.writeUInt32BE(height, 4);
header[8] = 8; // Bit depth.
header[9] = 6; // RGBA.
header[10] = 0; // Compression.
header[11] = 0; // Filter.
header[12] = 0; // Interlace.

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk('IHDR', header),
  pngChunk('IDAT', deflateSync(raw, { level: 9 })),
  pngChunk('IEND', Buffer.alloc(0)),
]);

const defaultOutput = fileURLToPath(
  new URL('../../build/parity/scanner-qr-fixture.png', import.meta.url),
);
const output = resolve(process.argv[2] ?? defaultOutput);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, png);

console.log(
  JSON.stringify({
    path: output,
    image: `${width}x${height}`,
    qrSquare: `${qrPixels}x${qrPixels}`,
    modules: modules.length,
    pixelsPerModule,
    pngBytes: png.length,
    sha256: createHash('sha256').update(png).digest('hex'),
    payloadSha256: createHash('sha256').update(FIXTURE_URI).digest('hex'),
  }),
);
