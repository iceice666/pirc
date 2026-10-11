import { expect, test } from 'bun:test';
import { builtinFeatures, processFeatures } from '../src/agent/features/index.js';

test('PIRC_AGENT_FEATURES=none runs the agent core alone; anything else keeps every feature', () => {
  expect(processFeatures({ PIRC_AGENT_FEATURES: 'none' })).toEqual([]);
  const names = builtinFeatures().map((feature) => feature.name);
  expect(processFeatures({}).map((feature) => feature.name)).toEqual(names);
  expect(processFeatures({ PIRC_AGENT_FEATURES: 'all' }).map((feature) => feature.name)).toEqual(
    names,
  );
});
