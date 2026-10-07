import { expect, test } from 'bun:test';
import { InitialRequest } from './ptc-m1/initial-request.js';
import type { InferenceRequest } from '../src/inference-wire.js';
import type { AttemptSummary } from './ptc-m1/live-provider.js';
const request = (sessionId: string): InferenceRequest => ({
  sessionId,
  providerName: 'evaluation',
  modelId: 'm',
  systemPrompt: '',
  tools: [],
  thinking: 'medium',
  messages: [{ role: 'user', content: 'fixture', timestamp: 1 }],
});
const summary: AttemptSummary = {
  schemaBytes: 1,
  contextBytes: 1,
  requestBytes: 1,
  responseBytes: 1,
  durationMs: 1,
  status: 200,
  usage: null,
  completion: 'cancelled',
  evidence: 'missing_stop',
};
test('initial parent selected by admission not completion order; failed initial never replaced', () => {
  const proof = new InitialRequest();
  proof.arm('parent', 'fixture');
  proof.request('aux', request('parent-title'));
  proof.dispatch('aux', 'aux');
  proof.complete('aux', summary);
  proof.request('first', request('parent'));
  proof.dispatch('first', 'exact body');
  proof.request('retry', request('parent'));
  proof.dispatch('retry', 'different body');
  proof.complete('retry', summary);
  expect(proof.snapshot()).toBeNull();
  proof.complete('first', summary);
  expect(proof.snapshot()?.attempt.completion).toBe('cancelled');
});
test('different body/cwd yields different fingerprint; summary input cannot qualify', () => {
  const hash = (body: string) => {
    const p = new InitialRequest();
    p.arm('parent', 'fixture');
    p.request('a', request('parent'));
    p.dispatch('a', body);
    p.complete('a', summary);
    return p.snapshot()?.bodyHash;
  };
  expect(hash('cwd=/tmp/a')).not.toBe(hash('cwd=/tmp/b'));
  const p = new InitialRequest();
  p.arm('parent', 'fixture');
  const r = request('parent');
  r.toolChoice = 'none';
  p.request('a', r);
  p.dispatch('a', 'body');
  p.complete('a', summary);
  expect(p.snapshot()).toBeNull();
});
