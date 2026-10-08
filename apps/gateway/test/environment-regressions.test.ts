import { expect, test } from 'bun:test';
import { SharedNodeLink } from '../src/shared-node-link.js';
import { EnvironmentAdmission } from '../src/environment/admission.js';
import { runEnvironmentHost } from '../src/node/environment-authority.js';
import { ExecutionBudget } from '../src/environment/budget.js';

test('shared link rejects in-flight control/data promises when closed', async () => {
  for (const message of [
    { type: 'heartbeat' },
    { type: 'response', data: 'large'.repeat(10000) },
  ]) {
    const link = new SharedNodeLink({
      send: () => new Promise(() => {}),
      receive: () => {},
      fail: () => {},
    });
    const pending = link.send(JSON.stringify(message));
    link.close();
    await expect(pending).rejects.toThrow('closed');
  }
});

test('shared legacy start/cancel ordering survives asynchronous durable assembly', async () => {
  let a!: SharedNodeLink, b!: SharedNodeLink;
  const messages: string[] = [];
  a = new SharedNodeLink({
    send: async (raw) => {
      queueMicrotask(() => void b.receive(raw));
    },
    receive: () => {},
    fail: () => {},
  });
  b = new SharedNodeLink({
    send: async (raw) => {
      queueMicrotask(() => void a.receive(raw));
    },
    receive: (raw) => messages.push(JSON.parse(raw).type),
    fail: () => {},
  });
  try {
    await a.send(JSON.stringify({ type: 'model_start', requestId: 'r', data: 'x'.repeat(100000) }));
    await a.send(JSON.stringify({ type: 'model_cancel', requestId: 'r' }));
    for (let i = 0; messages.length < 2 && i < 100; i++) await Bun.sleep(5);
    expect(messages).toEqual(['model_start', 'model_cancel']);
  } finally {
    a.close();
    b.close();
  }
});

test('queued tail deadlines expire even behind a busy long-lived session head', async () => {
  const admission = new EnvironmentAdmission();
  const expired: string[] = [];
  const reserve = (id: string, ms: number) =>
    admission.reserve({
      id,
      node: 'n',
      session: 's',
      bytes: 1,
      deadline: performance.now() + ms,
      ready: () => false,
      start: async () => {},
      expire: () => expired.push(id),
    });
  reserve('head', 10_000);
  reserve('tail', 10);
  admission.wake();
  await Bun.sleep(30);
  expect(expired).toEqual(['tail']);
  admission.remove('head');
});

test('duplicate admission ID cannot evict the original session queued work', () => {
  const admission = new EnvironmentAdmission();
  const item = {
    id: 'same',
    node: 'n',
    session: 'a',
    bytes: 1,
    deadline: performance.now() + 1000,
    ready: () => false,
    start: async () => {},
    expire: () => {},
  };
  admission.reserve(item);
  expect(() => admission.reserve({ ...item, session: 'b' })).toThrow('conflict');
  admission.remove(item.id);
});

test('closed budget cannot rearm when a cancelled human wait settles later', async () => {
  const budget = new ExecutionBudget(10, 100);
  budget.beginHumanWait();
  budget.close();
  budget.endHumanWait();
  await Bun.sleep(20);
  expect(budget.controller.signal.aborted).toBe(false);
});

test('host cancellation kills TERM-resistant descendants after shell exits', async () => {
  const controller = new AbortController();
  const pending = runEnvironmentHost(
    '(trap "" TERM; exec sleep 60) >/dev/null 2>&1 & echo $!; wait',
    process.cwd(),
    10000,
    controller.signal,
  );
  setTimeout(() => controller.abort(), 50);
  const result = await pending;
  const pid = Number(String(result.output).trim());
  expect(result.aborted).toBe(true);
  await Bun.sleep(1200);
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  // A Linux zombie cannot perform effects; /proc state is evidence it was killed.
  if (alive && process.platform === 'linux') {
    const stat = await Bun.file(`/proc/${pid}/stat`)
      .text()
      .catch(() => '');
    alive = !stat.includes(') Z');
  }
  expect(alive).toBe(false);
}, 5000);
