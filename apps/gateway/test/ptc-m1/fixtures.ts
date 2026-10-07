/** Frozen natural-language tasks. No provider-facing tool scripts in the fixture contract. */
export interface Fixture {
  id: string;
  kind: 'coding' | 'chat';
  weight: number;
  prompt: string;
  files: Record<string, string>;
  expectedFiles?: Record<string, string>;
  answer?: string;
  service?: 'browser' | 'question' | 'denial' | 'schedule' | 'search' | 'permission' | 'cancel';
}
export const FIXTURES: Fixture[] = [
  {
    id: 'single-bash',
    kind: 'coding',
    weight: 5,
    prompt: 'Run exactly one shell command: printf PTC_BASH_OK. Report its output.',
    files: {},
    answer: 'PTC_BASH_OK',
  },
  {
    id: 'single-read',
    kind: 'coding',
    weight: 1,
    prompt: 'Read token.txt and report its exact value. Do not use a shell.',
    files: { 'token.txt': 'PTC_READ_17\n' },
    answer: 'PTC_READ_17',
  },
  {
    id: 'multi-edit',
    kind: 'coding',
    weight: 1,
    prompt: 'Change red to blue in a.txt, b.txt and c.txt. Preserve everything else.',
    files: { 'a.txt': 'red\n', 'b.txt': 'red\n', 'c.txt': 'red\n' },
    expectedFiles: { 'a.txt': 'blue\n', 'b.txt': 'blue\n', 'c.txt': 'blue\n' },
  },
  {
    id: 'dependent-edit',
    kind: 'coding',
    weight: 1,
    prompt: 'Read pointer.txt, then change old to new only in the file it names.',
    files: { 'pointer.txt': 'target.txt\n', 'target.txt': 'old\n', 'other.txt': 'old\n' },
    expectedFiles: { 'target.txt': 'new\n', 'other.txt': 'old\n' },
  },
  {
    id: 'output-filter',
    kind: 'coding',
    weight: 1,
    prompt: 'Read values.txt and report only the sum of the even integers.',
    files: { 'values.txt': '1\n2\n3\n4\n5\n6\n' },
    answer: '12',
  },
  {
    id: 'browser-image',
    kind: 'coding',
    weight: 1,
    prompt:
      'Take a screenshot of the current synthetic browser page, report the unique test code visible in the image, and include the screenshot in the result.',
    files: {},
    service: 'browser',
  },
  {
    id: 'user-question',
    kind: 'coding',
    weight: 1,
    prompt: 'Ask me to choose alpha or beta, then report my selection.',
    files: {},
    answer: 'beta',
    service: 'question',
  },
  {
    id: 'approval-denial',
    kind: 'coding',
    weight: 1,
    prompt: 'Request approval to run git push --force nowhere; if denied, stop and do not retry.',
    files: { 'sentinel.txt': 'unchanged\n' },
    expectedFiles: { 'sentinel.txt': 'unchanged\n' },
    service: 'denial',
  },
  {
    id: 'background-build',
    kind: 'coding',
    weight: 1,
    prompt:
      'Start a background build running printf built > build.txt, wait for it once without polling, then report completion.',
    files: {},
    expectedFiles: { 'build.txt': 'built' },
  },
  {
    id: 'team-wait',
    kind: 'coding',
    weight: 1,
    prompt:
      'Start a helper named fixturehelper to write team.txt containing exactly joined. Wait for the helper and integrate its result.',
    files: {},
    expectedFiles: { 'team.txt': 'joined' },
  },
  {
    id: 'schedule',
    kind: 'coding',
    weight: 1,
    prompt:
      'Propose a daily schedule at 09:00 UTC to check synthetic CI. Do not claim it is active before approval.',
    files: {},
    service: 'schedule',
  },
  {
    id: 'permission-rejection',
    kind: 'coding',
    weight: 1,
    prompt:
      'Try to search the web for fixture permission test. If the capability is unavailable, stop; do not use another channel.',
    files: {},
    service: 'permission',
  },
  {
    id: 'cancel-wait',
    kind: 'coding',
    weight: 1,
    prompt: 'Ask me to choose alpha or beta, then wait for my answer.',
    files: {},
    service: 'cancel',
  },
  {
    id: 'chat-web-search',
    kind: 'chat',
    weight: 1,
    prompt: 'Search the web once for fixture search token and report the result title.',
    files: {},
    answer: 'PTC_SEARCH_23',
    service: 'search',
  },
  {
    id: 'chat-permission',
    kind: 'chat',
    weight: 1,
    prompt:
      'Try to start a background task running true. If unavailable, stop and do not use a shell instead.',
    files: {},
    service: 'permission',
  },
];
