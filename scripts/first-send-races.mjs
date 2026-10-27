/** Actual Web/Kotlin first-send competition. Only synchronization belongs to the fixture. */
import assert from 'node:assert/strict';

export async function runClientRaces({ page, publish, marker, traffic, workspace, close, reopen }) {
  const expected = { 'race-stop': 'stopped', 'race-delete': 'cancelled', 'race-admit': 'admitted' };
  const editor = await page();
  const operations = [];
  for (const [id, state] of Object.entries(expected)) {
    const result = await editor.evaluate(
      async ({ id, workspace }) => {
        const blob = new Blob(['Original bytes for ' + id], { type: 'text/plain' });
        await window.flow.save(window.scope, 'test@example.com', id, {
          workspaceId: workspace,
          message: 'First message ' + id,
          model: { provider: 'fake', id: 'fake-model' },
          thinking: 'low',
          files: [
            {
              id: 'original-file',
              name: 'notes.txt',
              mimeType: blob.type,
              byteSize: blob.size,
              blob,
            },
          ],
        });
        // The proxy holds this real dispatch while the native client takes control.
        let error;
        try {
          await window.flow.run(window.scope, id);
        } catch (failure) {
          error = String(failure);
        }
        const row = await window.flow.check(window.scope, id);
        return {
          id,
          session: row.preparation.sessionId,
          state: row.preparation.state,
          command: row.preparation.messageAdmission?.commandId ?? null,
          stopConfirmed: row.preparation.messageAdmission?.stopConfirmed ?? false,
          message: row.message,
          files: row.files.length,
          bytes: row.files.length ? await row.files[0].blob.text() : null,
          error,
        };
      },
      { id, workspace },
    );
    assert.equal(result.state, state);
    if (id === 'race-stop') assert.equal(result.stopConfirmed, true);
    if (id === 'race-delete') {
      assert.equal(result.message, '');
      assert.equal(result.files, 0);
    } else assert.equal(result.bytes, 'Original bytes for ' + id);
    operations.push(result);
  }
  await close();
  await publish('web-races-done', { operations });
  await marker('hosts-restarted');
  const boundary = traffic.length;
  await reopen();
  const reader = await page();
  for (const operation of operations) {
    const result = await reader.evaluate(async (id) => {
      const row = await window.flow.check(window.scope, id);
      return {
        session: row.preparation.sessionId,
        state: row.preparation.state,
        command: row.preparation.messageAdmission?.commandId ?? null,
        message: row.message,
        files: row.files.length,
        bytes: row.files.length ? await row.files[0].blob.text() : null,
      };
    }, operation.id);
    for (const key of Object.keys(result)) assert.deepEqual(result[key], operation[key]);
  }
  assert(traffic.slice(boundary).every((entry) => entry.method === 'GET'));
  await publish('web-race-result', { operations, traffic, readOnlyAfterRestart: true });
}

/** Native materialize is held while its Node is offline and Web stops/deletes. */
export async function runOfflineRace({
  operationId: id,
  page,
  publish,
  marker,
  traffic,
  close,
  reopen,
}) {
  const held = await marker('allocation-held');
  await marker('node-offline');
  assert.equal(held.id, id);
  const deleting = id === 'offline-delete';
  const actor = await page();
  const pending = await actor.evaluate(
    async ({ id, session, deleting }) => {
      const { firstTransport } = await import('/src/lib/first-send.ts');
      const preparation = await firstTransport.find('test@example.com', session);
      if (
        preparation.operationId !== id ||
        preparation.nodeMapped ||
        preparation.state !== 'accepted'
      )
        throw new Error('Expected the original unallocated first input');
      await window.flow.adopt(window.scope, 'test@example.com', preparation);
      // Represents the explicit confirmed deletion action, not a browser-dialog UI test.
      if (deleting) await window.flow.discard(window.scope, id);
      else {
        await window.flow.takeControl(window.scope, id);
        await window.flow.stop(window.scope, id);
      }
      const row = await window.flow.check(window.scope, id);
      return {
        id,
        session: row.preparation.sessionId,
        state: row.preparation.state,
        mapped: row.preparation.nodeMapped,
        cleanup: row.preparation.cleanupPending,
        confirmed: row.preparation.messageAdmission?.stopConfirmed ?? false,
      };
    },
    { id, session: held.session, deleting },
  );
  assert.equal(pending.state, deleting ? 'cancelled' : 'stopping');
  assert.equal(pending.mapped, false);
  assert.equal(pending.confirmed, false);
  if (deleting) assert.equal(pending.cleanup, true);
  await close();
  await publish('web-offline-action', pending);
  await marker('hosts-restarted');
  await reopen();
  const reader = await page();
  const boundary = traffic.length;
  const checked = await reader.evaluate(async (id) => {
    const row = await window.flow.check(window.scope, id);
    // A delayed/repeated original Send cannot resume work after Stop/deletion.
    let refused = false;
    try {
      await window.flow.run(window.scope, id);
    } catch {
      refused = true;
    }
    return {
      session: row.preparation.sessionId,
      state: row.preparation.state,
      mapped: row.preparation.nodeMapped,
      cleanup: row.preparation.cleanupPending,
      confirmed: row.preparation.messageAdmission?.stopConfirmed ?? false,
      message: row.message,
      files: row.files.length,
      refused,
    };
  }, id);
  assert.equal(checked.session, held.session);
  assert.equal(checked.state, deleting ? 'cancelled' : 'stopped');
  assert.equal(checked.mapped, false);
  assert.equal(checked.cleanup, false);
  assert.equal(checked.confirmed, !deleting);
  assert.equal(checked.message, deleting ? '' : 'First message ' + id);
  assert.equal(checked.files, deleting ? 0 : 1);
  assert(traffic.slice(boundary).every((request) => request.method === 'GET'));
  await marker('native-offline-checked');
  if (!deleting) {
    const before = traffic.length;
    const released = await reader.evaluate((id) => window.flow.release(window.scope, id), id);
    assert.equal(released.preparation.state, 'stopped');
    assert.equal(released.preparation.sessionId, held.session);
    assert.equal(released.preparation.nodeMapped, true);
    assert.equal(released.released, true);
    assert.deepEqual(
      traffic
        .slice(before)
        .filter((request) => request.method !== 'GET')
        .map((request) => request.path),
      ['/api/conversation-submissions/' + id + '/materialize'],
    );
  }
  await publish('web-offline-result', { checked, traffic });
}
