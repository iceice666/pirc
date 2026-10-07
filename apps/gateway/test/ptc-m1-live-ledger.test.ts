import { expect, test } from 'bun:test';
import { RequestLedger } from './ptc-m1/request-ledger.js';
test('request ownership reconciliation includes child auxiliary and out-of-order completion', () => {
  const ledger = new RequestLedger();
  ledger.start('title', 'parent-title');
  ledger.start('child', 'child');
  ledger.start('memory', 'child-memory');
  ledger.parentSession('parent');
  ledger.childSession('child');
  for (const id of ['memory', 'title', 'child']) {
    ledger.attempt(id, true);
    ledger.end(id);
  }
  expect(ledger.summary()).toMatchObject({
    verified: true,
    owners: { parent: 0, child: 1, auxiliary: 2, unknown: 0 },
    attempts: 3,
  });
  expect(JSON.stringify(ledger.summary())).not.toContain('parent-title');
});
test('unknown owner, missing attempts, unclosed or partial usage cannot verify', () => {
  for (const failure of ['unknown', 'missing', 'pending', 'partial']) {
    const ledger = new RequestLedger();
    ledger.parentSession('parent');
    ledger.start('a', failure === 'unknown' ? 'stranger' : 'parent');
    if (failure !== 'missing') ledger.attempt('a', failure !== 'partial');
    if (failure !== 'pending') ledger.end('a');
    expect(ledger.summary().verified).toBe(false);
  }
});

test('nonbillable local denial is explicit rather than an unmatched upstream attempt', () => {
  const ledger = new RequestLedger();
  ledger.parentSession('p');
  ledger.start('denied', 'p');
  ledger.deny('denied');
  ledger.end('denied');
  expect(ledger.summary()).toMatchObject({
    verified: false,
    attempts: 0,
    localDeniedRequests: 1,
    unmatchedRequests: 0,
    pending: 0,
  });
});
