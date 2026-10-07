import { expect, test } from 'bun:test';
import { ProviderActivity } from './ptc-m1/activity.js';

test('quiescence waits for delayed chained auxiliary work without model polling', async () => {
  const activity = new ProviderActivity();
  const first = activity.begin();
  let finished = false;
  const waiting = activity.waitForQuiet({ quietMs: 25, timeoutMs: 1000 }).then((value) => {
    finished = true;
    return value;
  });
  await Bun.sleep(30);
  expect(finished).toBe(false);
  first();
  first(); // duplicate completion must not underflow the count
  const second = activity.begin();
  await Bun.sleep(30);
  expect(finished).toBe(false);
  second();
  const result = await waiting;
  expect(result.waitMs).toBeGreaterThanOrEqual(60);
  expect(result.observedChanges).toBe(3);
});

test('quiescence timeout, cancellation, shutdown and invalid settings fail explicitly', async () => {
  const activity = new ProviderActivity();
  const end = activity.begin();
  await expect(activity.waitForQuiet({ quietMs: 5, timeoutMs: 15 })).rejects.toThrow('timeout');
  const abort = new AbortController();
  const cancelled = activity.waitForQuiet({ quietMs: 5, timeoutMs: 100, signal: abort.signal });
  abort.abort();
  await expect(cancelled).rejects.toThrow('cancelled');
  const closing = activity.waitForQuiet({ quietMs: 5, timeoutMs: 100 });
  activity.close();
  await expect(closing).rejects.toThrow('closed');
  end();
  expect(() => activity.begin()).toThrow('closed');
  await expect(activity.waitForQuiet({ quietMs: 0, timeoutMs: 100 })).rejects.toThrow('Invalid');
  await expect(activity.waitForQuiet({ quietMs: 10, timeoutMs: 10 })).rejects.toThrow('Invalid');
});
