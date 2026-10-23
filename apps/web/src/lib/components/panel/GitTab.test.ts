// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import GitTab from './GitTab.svelte';

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;
let calls: string[];

const status = {
  repo: true,
  root: '/repo',
  branch: 'fix-lint',
  upstream: null,
  ahead: 1,
  behind: 0,
  files: [
    { path: 'kernel/sched.rs', index: ' ', worktree: 'M' },
    { path: 'notes.md', index: '?', worktree: '?' },
  ],
  truncated: false,
};

const commitOne = {
  sha: '4f2a9c1deadbeef',
  short: '4f2a9c1',
  author: 'lint',
  email: 'lint@example',
  time: Date.now() - 600_000,
  refs: ['HEAD -> fix-lint'],
  subject: 'fix clippy lints in scheduler',
};
const commitTwo = {
  sha: 'b2c3d4e5f60718',
  short: 'b2c3d4e',
  author: 'me',
  email: 'me@example',
  time: Date.now() - 3_600_000,
  refs: ['origin/fix-lint'],
  subject: 'start the scheduler refactor',
};

const detail = (item: typeof commitOne, diff: string) => ({
  sha: item.sha,
  author: item.author,
  email: item.email,
  time: item.time,
  refs: item.refs,
  message: `${item.subject}\n\nA longer body.`,
  diff,
  truncated: false,
});

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost');
      calls.push(url.pathname + url.search);
      const reply = (value: unknown) => new Response(JSON.stringify(value));
      if (url.pathname === '/api/sessions/s/git/status') return reply(status);
      if (url.pathname === '/api/sessions/s/git/log')
        return reply({ commits: [commitOne, commitTwo], more: false });
      if (url.pathname === '/api/sessions/s/git/commits/4f2a9c1deadbeef')
        return reply(
          detail(
            commitOne,
            '@@ -212,9 +212,7 @@ impl Scheduler {\n- let ready = self.ready.clone();\n+ self.ready.iter().copied()\n',
          ),
        );
      if (url.pathname === '/api/sessions/s/git/commits/b2c3d4e5f60718')
        return reply(detail(commitTwo, '@@ -1,2 +1,3 @@\n use std::sync;\n+use std::time;\n'));
      if (url.pathname === '/api/sessions/s/git/diff')
        return reply({ diff: '@@ -2,3 +2,3 @@\n-old line\n+new line\n', truncated: false });
      return reply({});
    }),
  );
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(() => {
  if (component) unmount(component);
  component = undefined;
  target.remove();
  vi.unstubAllGlobals();
});

const flush = async () => {
  for (let index = 0; index < 8; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
  }
  flushSync();
};

function render() {
  component = mount(GitTab, { target, props: { sessionId: 's' } });
  return flush();
}

it('shows the branch and its history beside the newest commit’s diff', async () => {
  await render();
  const side = target.querySelector<HTMLElement>('.side')!;
  const main = target.querySelector<HTMLElement>('.main')!;
  expect(side).not.toBeNull();
  expect(main).not.toBeNull();

  // The branch card: what the branch is and that nothing is pushed.
  expect(side.querySelector('.branch')?.textContent).toBe('fix-lint');
  expect(side.querySelector('.chip.warn')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    '1 ahead · not pushed',
  );
  expect(side.querySelector('.tree')?.textContent).toContain('2 uncommitted');

  // Uncommitted changes and history have their home on the left.
  expect(side.querySelectorAll('.file-row')).toHaveLength(2);
  const rows = [...side.querySelectorAll<HTMLButtonElement>('.commit-row')];
  expect(rows).toHaveLength(2);
  expect(rows[0]!.getAttribute('aria-pressed')).toBe('true');
  expect(rows[0]!.textContent).toContain('4f2a9c1');
  expect(rows[0]!.textContent).toContain('HEAD');

  // The newest commit's diff is the right column's pane.
  expect(calls).toContain('/api/sessions/s/git/commits/4f2a9c1deadbeef');
  expect(main.textContent).toContain('fix clippy lints in scheduler');
  expect(main.textContent).toContain('self.ready.iter().copied()');
  expect(main.querySelector('.count.add')?.textContent).toBe('+1');
  expect(main.querySelector('.count.del')?.textContent).toBe('−1');

  // Selecting another commit swaps the diff, not the history.
  rows[1]!.click();
  await flush();
  expect(calls).toContain('/api/sessions/s/git/commits/b2c3d4e5f60718');
  expect(target.querySelectorAll('.commit-row')[1]!.getAttribute('aria-pressed')).toBe('true');
  expect(target.querySelector('.main')!.textContent).toContain('use std::time;');
});

it('shows a changed file’s own diff when it is selected, staged or not', async () => {
  await render();
  const file = target.querySelector<HTMLButtonElement>('.file-row')!;
  file.click();
  await flush();
  expect(calls.some((call) => call.startsWith('/api/sessions/s/git/diff?path=kernel'))).toBe(true);
  const main = target.querySelector('.main')!;
  expect(main.textContent).toContain('kernel/sched.rs');
  expect(main.textContent).toContain('new line');
  expect(target.querySelectorAll('.file-row')[0]!.getAttribute('aria-pressed')).toBe('true');
  // The commit no longer holds the pane.
  expect(target.querySelector('.commit-row')!.getAttribute('aria-pressed')).toBe('false');
});
