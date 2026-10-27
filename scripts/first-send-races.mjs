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
