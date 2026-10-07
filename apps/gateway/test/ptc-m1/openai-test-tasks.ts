/** Scripted smoke replies only, never live fixture reasoning evidence. */
import { IMAGE_ANSWER } from './image.js';
type Step = { name: string; input: unknown };
export const OPENAI_TEST_TASKS: Record<
  string,
  { name: string; input: unknown; answer: string; steps?: Step[] }
> = {
  'multi-edit': {
    name: '',
    input: {},
    answer: 'Changed three files.',
    steps: ['a.txt', 'b.txt', 'c.txt'].map((path) => ({
      name: 'edit',
      input: { path, oldText: 'red', newText: 'blue' },
    })),
  },
  'dependent-edit': {
    name: '',
    input: {},
    answer: 'Updated target only.',
    steps: [
      { name: 'read', input: { path: 'pointer.txt' } },
      { name: 'edit', input: { path: 'target.txt', oldText: 'old', newText: 'new' } },
    ],
  },
  'output-filter': { name: 'read', input: { path: 'values.txt' }, answer: '12' },
  'background-build': {
    name: '',
    input: {},
    answer: 'Build completed.',
    steps: [
      { name: 'background_task', input: { action: 'start', command: 'printf built > build.txt' } },
      { name: 'background_task', input: { action: 'wait', id: 'dynamic' } },
    ],
  },
  'team-wait': {
    name: '',
    input: {},
    answer: 'Helper wrote joined; integrated.',
    steps: [
      {
        name: 'agent_spawn',
        input: { name: 'fixturehelper', task: 'Write team.txt containing exactly joined' },
      },
      { name: 'agent_wait', input: { agent: 'fixturehelper', timeout: 10 } },
    ],
  },
  'single-read': { name: 'read', input: { path: 'token.txt' }, answer: 'PTC_READ_17' },
  'single-bash': { name: 'bash', input: { command: 'printf PTC_BASH_OK' }, answer: 'PTC_BASH_OK' },
  'approval-denial': {
    name: 'bash',
    input: { command: 'git push --force nowhere' },
    answer: 'Denied; stopped without retry.',
  },
  'permission-rejection': {
    name: 'web_search',
    input: { query: 'fixture permission test' },
    answer: 'Unavailable; stopped.',
  },
  'chat-permission': {
    name: 'background_task',
    input: { action: 'start', command: 'true' },
    answer: 'Unavailable; stopped.',
  },
  'user-question': {
    name: 'ask_user_question',
    input: {
      questions: [{ question: 'alpha or beta?', options: [{ label: 'alpha' }, { label: 'beta' }] }],
    },
    answer: 'beta',
  },
  'cancel-wait': {
    name: 'ask_user_question',
    input: {
      questions: [{ question: 'alpha or beta?', options: [{ label: 'alpha' }, { label: 'beta' }] }],
    },
    answer: '',
  },
  schedule: {
    name: 'schedule',
    input: {
      action: 'create',
      prompt: 'Check synthetic CI',
      title: 'Synthetic CI',
      cron: '0 9 * * *',
      timezone: 'UTC',
    },
    answer: 'Pending approval, not active.',
  },
  'browser-image': {
    name: 'browser_screenshot',
    input: {},
    answer: `Attached screenshot: ${IMAGE_ANSWER}`,
  },
  'chat-web-search': {
    name: 'web_search',
    input: { query: 'fixture search token' },
    answer: 'PTC_SEARCH_23',
  },
};
