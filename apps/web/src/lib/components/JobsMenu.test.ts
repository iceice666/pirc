// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../app.svelte';
import { panelApi, type PanelState } from '../panel-api';
import { seedApp } from '../testing/app-state';
import JobsMenu from './JobsMenu.svelte';

const started = new Date(Date.now() - 60_000).toISOString();
const panelState = (tasks: PanelState['backgroundTasks']): PanelState => ({
  agentRunning: true,
  memory: null,
  memoryRuntime: null,
  backgroundTasks: tasks,
  team: { agents: [{ name: 'reviewer', mode: 'subagent', status: 'working' }] },
});

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;

beforeEach(() => {
  const state = seedApp();
  vi.spyOn(panelApi, 'state').mockImplementation(async () => app.panel.value!);
  app.panel.reset(state.session.id);
  app.panel.value = panelState([
    {
      id: 'done',
      command: 'bun test',
      cwd: '.',
      status: 'completed',
      exitCode: 0,
      startedAt: started,
    },
    { id: 'dev', command: 'bun run dev', cwd: '.', status: 'running', startedAt: started },
  ]);
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target.remove();
  vi.restoreAllMocks();
});

async function openMenu() {
  component = mount(JobsMenu, { target });
  flushSync();
  const trigger = target.querySelector<HTMLButtonElement>('.jobs-trigger')!;
  trigger.click();
  await tick();
  flushSync();
  return trigger;
}

describe('JobsMenu', () => {
  it('counts running tasks and agents and lists them', async () => {
    const trigger = await openMenu();
    expect(trigger.textContent).toContain('2 running');
    const text = target.textContent ?? '';
    expect(text).toContain('bun run dev');
    expect(text).toContain('reviewer');
  });

  it('stops a running task only on the second press', async () => {
    const stop = vi.spyOn(panelApi, 'stopBackground').mockResolvedValue({
      task: { id: 'dev', command: 'bun run dev', cwd: '.', status: 'stopping', startedAt: started },
    });
    await openMenu();
    const button = () => target.querySelector<HTMLButtonElement>('.job-stop')!;
    button().click();
    flushSync();
    expect(stop).not.toHaveBeenCalled();
    expect(button().getAttribute('aria-label')).toBe('Confirm stop');
    button().click();
    expect(stop).toHaveBeenCalledWith(app.activeSessionId, 'dev', 1);
    await tick();
    flushSync();
    expect(target.querySelector('[aria-label="Stopping"]')).not.toBeNull();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const trigger = await openMenu();
    expect(target.querySelector('.jobs-menu')).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    flushSync();
    expect(document.activeElement).toBe(trigger);
  });

  it('hides while the session has no background work', () => {
    app.panel.value = { ...panelState([]), team: { agents: [] } };
    component = mount(JobsMenu, { target });
    flushSync();
    expect(target.querySelector('.jobs-trigger')).toBeNull();
  });
});
