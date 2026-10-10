/**
 * Real ENOSPC on the node journal's filesystem. Opt-in: set
 * PIRC_TEST_ENV_SMALLFS to a writable directory on a small, disposable
 * filesystem (for example a few-MiB tmpfs, loop device or disk image) that the
 * operator mounted beforehand. The test fills it; it never mounts anything.
 * This covers out-of-space, not power loss.
 */
import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';
import { LocalEnvironment } from '../src/environment/service.js';
import { ExecutionJournal } from '../src/environment/journal.js';
import { EnvironmentAdmission } from '../src/environment/admission.js';
import {
  descriptorDigest,
  intentDigest,
  type Descriptor,
  type ExecutionIntent,
} from '../src/environment/protocol.js';
import { waitFor } from './helpers.js';

const smallFs = process.env.PIRC_TEST_ENV_SMALLFS;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** Write until the filesystem refuses; returns the filler path. */
function fill(dir: string): string {
  const file = path.join(dir, 'filler');
  const fd = openSync(file, 'w');
  const block = Buffer.alloc(64 * 1024, 1);
  try {
    for (;;) writeSync(fd, block);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOSPC') throw error;
  } finally {
    closeSync(fd);
  }
  return file;
}

test.skipIf(!smallFs)(
  'a full journal disk faults the node instead of reporting an unjournaled result',
  async () => {
    const dir = mkdtempSync(path.join(smallFs!, 'pirc-env-full-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'journal.sqlite');
    let journal = new ExecutionJournal(file);
    cleanups.push(() => journal.close());
    const binding = {
      nodeId: 'n',
      workspaceId: 'n:w',
      sessionId: randomUUID(),
      writerEpoch: randomUUID(),
      executorEpoch: randomUUID(),
    };
    const content: Omit<Descriptor, 'revision'> = {
      binding,
      version: 1,
      policyRevision: 'a'.repeat(64),
      capabilityCatalog: [
        {
          name: 'bash',
          argumentSchema: {},
          resultSchema: {},
          placement: 'node',
          effects: 'write',
          concurrency: 'write',
          approval: 'policy',
          hookRevision: 'b'.repeat(64),
        },
      ],
      instructions: '',
      skills: [],
      role: 'coding',
      platform: process.platform === 'darwin' ? 'darwin' : 'linux',
      cwdDisplay: '/fixture',
      sandboxStatus: { active: true },
      limits: { maxActive: 1, maxBudgetMs: 10_000 },
    };
    const descriptor = { ...content, revision: descriptorDigest(content) };
    const value = {
      binding,
      executionId: randomUUID(),
      runId: randomUUID(),
      turnId: randomUUID(),
      toolCallId: randomUUID(),
      capability: 'bash',
      arguments: {},
      descriptorRevision: descriptor.revision,
      policyRevision: descriptor.policyRevision,
      budgetMs: 10_000,
    };
    const intent: ExecutionIntent = { ...value, argumentDigest: intentDigest(value) };
    const faults: Error[] = [];
    const delivered: unknown[] = [];
    let filler: string | undefined;
    let effects = 0;
    const local = new LocalEnvironment({
      nodeId: 'n',
      journal,
      authorize: () => undefined,
      unfencedHarness: true,
      admission: new EnvironmentAdmission(),
      fault: (error) => faults.push(error),
      result: (record) => delivered.push(record),
    });
    local.provision(descriptor, {
      healthy: true,
      async execute() {
        // The side effect happens, then the disk fills before the result is journaled.
        effects++;
        filler = fill(dir);
        return {
          state: 'completed',
          effect: 'completed',
          // Large enough that persisting it needs new pages.
          output: 'x'.repeat(256 * 1024),
          artifacts: [],
          truncated: false,
        };
      },
    });
    await local.start(intent);
    await waitFor(() => faults.length > 0, true, 10_000);
    // The terminal write failed for real, and no success left the node.
    expect(String(faults[0])).toMatch(/full|disk|space|SQLITE_FULL|I\/O/i);
    expect(delivered).toEqual([]);
    expect(journal.status(binding, intent.executionId).state).toBe('running');
    // A faulted supervisor admits nothing more until it is recovered.
    const next = { ...value, executionId: randomUUID() };
    await expect(local.start({ ...next, argumentDigest: intentDigest(next) })).rejects.toThrow();
    expect(() => local.reconnect()).toThrow('recovery');

    // The operator frees space; the supervisor restarts from the same file.
    rmSync(filler!);
    journal.close();
    journal = new ExecutionJournal(file);
    const recovered = journal.recover(binding);
    expect(recovered.map((record) => [record.executionId, record.state, record.effect])).toEqual([
      [intent.executionId, 'unknown', 'unknown'],
    ]);
    // The original ID is never admitted again, so the effect cannot replay.
    expect(journal.accept(intent).fresh).toBe(false);
    expect(effects).toBe(1);
  },
  30_000,
);
