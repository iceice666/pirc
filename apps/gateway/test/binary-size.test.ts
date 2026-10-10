import { expect, it } from 'bun:test';
import { overBudget } from '../../../scripts/binary-size.js';

it('fails binaries over budget or missing, and passes those within', () => {
  const budget = { binaries: { a: 100, b: 100, c: 100 } };
  expect(overBudget(budget, { a: 100, b: 101 })).toEqual([
    'b: 0.00 MiB exceeds its budget of 0.00 MiB',
    'c: not built',
  ]);
  expect(overBudget(budget, { a: 1, b: 2, c: 3 })).toEqual([]);
});
