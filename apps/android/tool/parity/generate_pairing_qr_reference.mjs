import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { encode } from '../../../web/node_modules/uqr/dist/index.mjs';

const packageInfo = JSON.parse(await readFile(new URL('../../../web/node_modules/uqr/package.json', import.meta.url), 'utf8'));
assert.equal(packageInfo.version, '0.1.3', 'Pairing QR reference requires the pinned uqr version');

const fakeToken = `pirc_dev_${'a'.repeat(43)}`;
const cases = [
  {
    id: 'short-pair-link',
    data: 'pirc://pair?url=https%3A%2F%2Fpirc.example&token=pirc_dev_demo',
  },
  {
    id: 'realistic-pair-link',
    data: `pirc://pair?url=https%3A%2F%2Fpirc.example%3A8443&token=${fakeToken}`,
  },
  {
    id: 'utf8-payload',
    data: 'pirc://pair?name=台北📱&token=pirc_dev_synthetic',
  },
  {
    id: 'long-pair-link',
    data: `pirc://pair?url=https%3A%2F%2Fmobile.example%2Fgateway%3Fregion%3Dap-northeast-1&token=${fakeToken}`,
  },
];

const output = {
  generator: 'uqr@0.1.3',
  errorCorrection: 'M',
  quietZone: 4,
  cases: cases.map(({ id, data }) => {
    const result = encode(data, { ecc: 'M', border: 4 });
    return {
      id,
      data,
      version: result.version,
      maskPattern: result.maskPattern,
      size: result.size,
      rows: result.data.map((row) => row.map((dark) => dark ? '1' : '0').join('')),
    };
  }),
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
