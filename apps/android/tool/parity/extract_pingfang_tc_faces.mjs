// Extract the two host PingFang TC faces identified by Chrome CDP into
// ignored test artifacts. The font tables are copied unchanged; only the
// standalone SFNT directory offsets and head.checkSumAdjustment are rebuilt.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const appRoot = resolve(root, 'apps/android');
const sourcePath =
  '/System/Library/AssetsV2/com_apple_MobileAsset_Font7/' +
  '3419f2a427639ad8c8e139149a287865a90fa17e.asset/AssetData/PingFang.ttc';
const sourceSha256 =
  '6bccdb1a967b2ae7e856927eb559591b2ce05656b0d4ad2764b9c9429f12c0b7';
const sourceFaceCount = 24;
const expectedFaces = [
  {
    index: 2,
    offset: 720,
    family: 'PingFang TC',
    subfamily: 'Regular',
    postScriptName: 'PingFangTC-Regular',
    output: 'PingFangTC-Regular.otf',
  },
  {
    index: 10,
    offset: 3120,
    family: 'PingFang TC',
    subfamily: 'Semibold',
    postScriptName: 'PingFangTC-Semibold',
    output: 'PingFangTC-Semibold.otf',
  },
];
const outputDir = resolve(appRoot, 'build/parity/font-fixtures');
const fontChecksumMagic = 0xb1b0afba;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function inBounds(offset, length, limit) {
  return Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    offset >= 0 &&
    length >= 0 &&
    offset + length <= limit;
}

function align4(value) {
  return (value + 3) & ~3;
}

function checksum(bytes) {
  let sum = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    let word = 0;
    for (let index = 0; index < 4; index += 1) {
      word = ((word << 8) | (bytes[offset + index] ?? 0)) >>> 0;
    }
    sum = (sum + word) >>> 0;
  }
  return sum;
}

function readFaceDirectory(collection, expected) {
  const base = collection.readUInt32BE(12 + expected.index * 4);
  check(base === expected.offset, `TTC face ${expected.index} offset changed`);
  check(inBounds(base, 12, collection.length), `Face ${expected.index} header is out of bounds`);
  const scaler = collection.toString('ascii', base, base + 4);
  check(scaler === 'OTTO', `Face ${expected.index} has unexpected scaler ${scaler}`);
  const numTables = collection.readUInt16BE(base + 4);
  check(numTables === 18, `Face ${expected.index} table count changed: ${numTables}`);
  const directoryLength = 12 + numTables * 16;
  check(inBounds(base, directoryLength, collection.length), `Face ${expected.index} directory is out of bounds`);
  const tables = [];
  const seen = new Set();
  for (let index = 0; index < numTables; index += 1) {
    const record = base + 12 + index * 16;
    const tag = collection.toString('ascii', record, record + 4);
    const storedChecksum = collection.readUInt32BE(record + 4);
    const offset = collection.readUInt32BE(record + 8);
    const length = collection.readUInt32BE(record + 12);
    check(!seen.has(tag), `Face ${expected.index} duplicates ${tag}`);
    seen.add(tag);
    check(inBounds(offset, length, collection.length), `${tag} table is out of TTC bounds`);
    const bytes = Buffer.from(collection.subarray(offset, offset + length));
    const actualChecksum = checksum(bytes);
    // Apple's TTC head directory checksum includes the face's adjustment field.
    check(actualChecksum === storedChecksum, `${tag} checksum mismatch in TTC face ${expected.index}`);
    tables.push({ tag, storedChecksum, offset, length, bytes });
  }
  check(seen.has('head') && seen.has('name') && seen.has('CFF '), `Face ${expected.index} lacks required tables`);
  return { base, scaler, tables };
}

function decodeUtf16be(bytes) {
  check(bytes.length % 2 === 0, 'Malformed UTF-16BE name record');
  return Buffer.from(bytes).swap16().toString('utf16le');
}

function nameRecords(table) {
  check(table.bytes.length >= 6, 'Truncated name table');
  const format = table.bytes.readUInt16BE(0);
  check(format === 0 || format === 1, `Unsupported name table format ${format}`);
  const count = table.bytes.readUInt16BE(2);
  const stringOffset = table.bytes.readUInt16BE(4);
  check(6 + count * 12 <= table.bytes.length, 'Name records exceed table bounds');
  check(stringOffset <= table.bytes.length, 'Name string storage exceeds table bounds');
  const records = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 12;
    const platform = table.bytes.readUInt16BE(offset);
    const encoding = table.bytes.readUInt16BE(offset + 2);
    const language = table.bytes.readUInt16BE(offset + 4);
    const nameId = table.bytes.readUInt16BE(offset + 6);
    const length = table.bytes.readUInt16BE(offset + 8);
    const stringIndex = table.bytes.readUInt16BE(offset + 10);
    check(inBounds(stringOffset + stringIndex, length, table.bytes.length), 'Name string exceeds table bounds');
    if (platform === 3 && encoding === 1 && language === 1033) {
      records.push({
        nameId,
        value: decodeUtf16be(
          table.bytes.subarray(stringOffset + stringIndex, stringOffset + stringIndex + length),
        ),
      });
    }
  }
  return records;
}

function englishName(records, ids) {
  for (const id of ids) {
    const record = records.find((candidate) => candidate.nameId === id);
    if (record) return record.value;
  }
  return null;
}

function standaloneSfnt(face, expected) {
  const tables = face.tables
    .filter((table) => table.tag !== 'DSIG')
    .map((table) => ({ ...table, bytes: Buffer.from(table.bytes) }))
    .sort((left, right) => (left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0));
  const head = tables.find((table) => table.tag === 'head');
  check(head && head.bytes.length >= 12, 'Truncated head table');
  head.bytes.writeUInt32BE(0, 8);

  const numTables = tables.length;
  let power = 1;
  let entrySelector = 0;
  while (power * 2 <= numTables) {
    power *= 2;
    entrySelector += 1;
  }
  const headerLength = 12 + numTables * 16;
  let totalLength = headerLength;
  for (const table of tables) totalLength = align4(totalLength) + align4(table.bytes.length);
  const sfnt = Buffer.alloc(totalLength);
  sfnt.write(face.scaler, 0, 4, 'ascii');
  sfnt.writeUInt16BE(numTables, 4);
  sfnt.writeUInt16BE(power * 16, 6);
  sfnt.writeUInt16BE(entrySelector, 8);
  sfnt.writeUInt16BE(numTables * 16 - power * 16, 10);

  let dataOffset = headerLength;
  let headOutputOffset = -1;
  for (let index = 0; index < tables.length; index += 1) {
    const table = tables[index];
    dataOffset = align4(dataOffset);
    const record = 12 + index * 16;
    sfnt.write(table.tag, record, 4, 'ascii');
    sfnt.writeUInt32BE(checksum(table.bytes), record + 4);
    sfnt.writeUInt32BE(dataOffset, record + 8);
    sfnt.writeUInt32BE(table.bytes.length, record + 12);
    table.bytes.copy(sfnt, dataOffset);
    if (table.tag === 'head') headOutputOffset = dataOffset;
    dataOffset += align4(table.bytes.length);
  }
  check(headOutputOffset >= 0, 'Missing output head table');
  const adjustment = (fontChecksumMagic - checksum(sfnt)) >>> 0;
  sfnt.writeUInt32BE(adjustment, headOutputOffset + 8);
  check(checksum(sfnt) === fontChecksumMagic, 'Standalone SFNT checksum adjustment failed');
  return sfnt;
}

function verifyStandalone(bytes, expected, sourceFace) {
  check(bytes.toString('ascii', 0, 4) === 'OTTO', 'Output lost its OTTO scaler');
  const count = bytes.readUInt16BE(4);
  const headLength = 12 + count * 16;
  check(inBounds(0, headLength, bytes.length), 'Output directory is out of bounds');
  const tags = new Set();
  let headBytes;
  let headAdjustment = 0;
  for (let index = 0; index < count; index += 1) {
    const record = 12 + index * 16;
    const tag = bytes.toString('ascii', record, record + 4);
    const stored = bytes.readUInt32BE(record + 4);
    const offset = bytes.readUInt32BE(record + 8);
    const length = bytes.readUInt32BE(record + 12);
    check(!tags.has(tag), `Output duplicates ${tag}`);
    tags.add(tag);
    check(inBounds(offset, length, bytes.length), `Output ${tag} table is out of bounds`);
    const content = Buffer.from(bytes.subarray(offset, offset + length));
    if (tag === 'head') {
      headAdjustment = content.readUInt32BE(8);
      headBytes = content;
      content.writeUInt32BE(0, 8);
    }
    check(checksum(content) === stored, `Output ${tag} checksum mismatch`);
    const source = sourceFace.tables.find((table) => table.tag === tag);
    check(source, `Output has unexpected table ${tag}`);
    const sourceBytes = Buffer.from(source.bytes);
    const outputBytes = Buffer.from(bytes.subarray(offset, offset + length));
    if (tag === 'head') {
      sourceBytes.writeUInt32BE(0, 8);
      outputBytes.writeUInt32BE(0, 8);
    }
    check(sha256(sourceBytes) === sha256(outputBytes), `${tag} table bytes changed during extraction`);
  }
  check(tags.size === sourceFace.tables.length, 'Output table set changed');
  check(headBytes && headAdjustment !== 0, 'Output head adjustment was not set');
  check(checksum(bytes) === fontChecksumMagic, 'Output font checksum is invalid');
  return { tableCount: count, checksumAdjustment: headAdjustment };
}

const collection = await readFile(sourcePath);
check(sha256(collection) === sourceSha256, 'Host PingFang TTC checksum changed');
check(collection.toString('ascii', 0, 4) === 'ttcf', 'Source is not a TTC collection');
const version = collection.readUInt32BE(4);
check(version === 0x00010000 || version === 0x00020000, `Unsupported TTC version ${version}`);
const faceCount = collection.readUInt32BE(8);
check(faceCount === sourceFaceCount, `TTC face count changed: ${faceCount}`);
check(inBounds(0, 12 + faceCount * 4, collection.length), 'TTC offset array is out of bounds');
if (version === 0x00020000) {
  check(inBounds(12 + faceCount * 4, 12, collection.length), 'TTC version 2 DSIG header is out of bounds');
}
await mkdir(outputDir, { recursive: true });
const outputFaces = [];
for (const expected of expectedFaces) {
  const face = readFaceDirectory(collection, expected);
  const records = nameRecords(face.tables.find((table) => table.tag === 'name'));
  const actual = {
    family: englishName(records, [16, 1]),
    subfamily: englishName(records, [17, 2]),
    postScriptName: englishName(records, [6]),
  };
  check(actual.family === expected.family, `TTC face ${expected.index} family mismatch: ${actual.family}`);
  check(actual.subfamily === expected.subfamily, `TTC face ${expected.index} subfamily mismatch: ${actual.subfamily}`);
  check(actual.postScriptName === expected.postScriptName, `TTC face ${expected.index} PostScript name mismatch: ${actual.postScriptName}`);
  const bytes = standaloneSfnt(face, expected);
  const validation = verifyStandalone(bytes, expected, face);
  const outputPath = resolve(outputDir, expected.output);
  await writeFile(outputPath, bytes);
  outputFaces.push({
    ...expected,
    ...actual,
    output: expected.output,
    outputBytes: bytes.length,
    outputSha256: sha256(bytes),
    tableCount: validation.tableCount,
    checksumAdjustment: validation.checksumAdjustment,
    glyphTablesUnchanged: true,
  });
}
const manifest = {
  sourcePath,
  sourceSha256,
  sourceBytes: collection.length,
  collectionVersion: `0x${version.toString(16)}`,
  faceCount,
  selection: 'name-table match for English family PingFang TC and Regular/Semibold; face indices are checksum-pinned',
  outputFaces,
  appBundled: false,
};
await writeFile(resolve(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
