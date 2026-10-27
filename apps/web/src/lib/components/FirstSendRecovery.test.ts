// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import { app } from '../app.svelte';
import FirstSendRecovery from './FirstSendRecovery.svelte';
let component: ReturnType<typeof mount> | undefined;
afterEach(() => {
  if (component) unmount(component);
  app.firstCapabilities = undefined;
  app.firstDraft = undefined;
  app.firstRecoveries = [];
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});
function show(state: string) {
  const row = {
    scope: 'scope',
    ownerUser: 'alice',
    operationId: 'op',
    revision: 1,
    workspaceId: 'node:repo',
    message: 'Original private text',
    files: [],
    frozen: true,
    updatedAt: 1,
    preparation: {
      operationId: 'op',
      sessionId: 'session',
      workspaceId: 'node:repo',
      state,
      accepted: true,
      cleanupPending: false,
    },
  };
  app.firstDraft = row;
  app.firstRecoveries = [row];
  component = mount(FirstSendRecovery, { target: document.body });
}
it('an uncertain send exposes read-only checking and keeps its details collapsed', async () => {
  const check = vi.spyOn(app, 'checkFirst').mockResolvedValue();
  show('outcome_unknown');
  const buttons = [...document.querySelectorAll('button')];
  expect(buttons.some((b) => b.textContent?.trim() === 'Continue sending')).toBe(false);
  expect([...document.querySelectorAll('details')].every((d) => !d.open)).toBe(true);
  buttons.find((b) => b.textContent?.trim() === 'Check result')!.click();
  await Promise.resolve();
  expect(check).toHaveBeenCalledOnce();
});
it('known admission offers Open conversation, never another Send action', () => {
  show('admitted');
  const labels = [...document.querySelectorAll('button')].map((b) => b.textContent?.trim());
  expect(labels).toContain('Open conversation');
  expect(labels).not.toContain('Continue sending');
});

it('unmapped accepted input exposes only supported Stop, and stopping leaves query controls', async () => {
  app.firstCapabilities = {
    version: 1,
    ownerUser: 'alice',
    canSubmit: false,
    canStopBeforeAllocation: true,
  };
  const stop = vi.spyOn(app, 'stopFirst').mockResolvedValue();
  show('accepted');
  expect(
    [...document.querySelectorAll('button')].some(
      (b) => b.textContent?.trim() === 'Stop pending message',
    ),
  ).toBe(true);
  [...document.querySelectorAll('button')]
    .find((b) => b.textContent?.trim() === 'Stop pending message')!
    .click();
  await Promise.resolve();
  expect(stop).toHaveBeenCalledOnce();
});
it('confirmed unmapped Stop offers explicit Open and keeps originals collapsed', async () => {
  show('stopped');
  app.firstDraft = {
    ...app.firstDraft!,
    preparation: {
      ...app.firstDraft!.preparation!,
      nodeMapped: false,
      messageAdmission: { outcome: 'not_admitted', stopRequested: true, stopConfirmed: true },
    },
  };
  await new Promise((r) => setTimeout(r, 0));
  const labels = [...document.querySelectorAll('button')].map((b) => b.textContent?.trim());
  expect(labels).toContain('Open conversation');
  expect(labels).not.toContain('Take control');
  expect([...document.querySelectorAll('details')].every((d) => !d.open)).toBe(true);
});

it('a deleted operation with an earlier Stop never offers Open conversation', async () => {
  show('cancelled');
  app.firstDraft = {
    ...app.firstDraft!,
    preparation: {
      ...app.firstDraft!.preparation!,
      messageAdmission: { outcome: 'not_admitted', stopRequested: true, stopConfirmed: true },
    },
  };
  await new Promise((r) => setTimeout(r, 0));
  expect(
    [...document.querySelectorAll('button')].some(
      (b) => b.textContent?.trim() === 'Open conversation',
    ),
  ).toBe(false);
});
