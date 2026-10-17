import { requireTestBrowserExecutable } from './test_browser.mjs';
import { fixtureMemorySources } from './fixture_memory_sources.mjs';
/** Isolated Rust gateway/chat integration host. The model and sandbox wrapper are test fixtures.
 * Run with Bun from the repo root, then follow the mobile README instructions.
 * Core fixtures also run on Node with TypeScript stripping; --browser uses Bun.serve.
 * Uses .pirc/flutter-parity-integration (private, ignored); never production state.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  accessSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer as createTcpServer, type Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { svelte } from '../../../web/node_modules/@sveltejs/vite-plugin-svelte/src/index.js';
import { cleanGitFixture } from './git_fixture_cleanup.ts';
import { startFakeLlm, type FakeLlm, type Reply } from './fake_llm.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const historyMode = process.argv.includes('--history-stopped');
if (process.argv.includes('--history')) {
  throw new Error(
    'The public Rust session API cannot leave a user-only final message idle. Use --history-stopped for the real 146-message stopped transcript; the pinned 145-message idle fixture is unsupported.',
  );
}
const observationalMemoryMode = process.argv.includes('--observational-memory');
const historyFixtureMessages: Array<{ id: string; role: string; content: string }> = historyMode
  ? JSON.parse(
      readFileSync(path.join(repo, 'fixtures/mobile-parity/conversation-history.json'), 'utf8'),
    ).messages
  : [];
const fixtureModeConflicts = [
  '--history',
  '--history-stopped',
  '--observational-memory',
  '--git',
  '--project-trust',
  '--terminal',
  '--browser',
  '--files',
  '--answer-recovery',
  '--html-media',
  '--documents',
];
if (
  (historyMode || observationalMemoryMode) &&
  fixtureModeConflicts.some(
    (argument) =>
      process.argv.includes(argument) &&
      argument !==
        (historyMode ? '--history-stopped' : '--observational-memory'),
  )
) {
  throw new Error('Use one fixture mode per run.');
}
const binDir = path.resolve(
  process.env.PIRC_CONFORMANCE_BIN_DIR ?? path.join(repo, 'target/debug'),
);
const gatewayBin = path.join(binDir, 'pirc-gateway');
const nodeBin = path.join(binDir, 'pirc-node');
for (const executable of [gatewayBin, nodeBin]) {
  try {
    accessSync(executable, 0o1);
  } catch {
    throw new Error(
      'Rust helper binary is missing or not executable: ' +
        executable +
        '. Set PIRC_CONFORMANCE_BIN_DIR to its directory.',
    );
  }
}
// Refuse to overlap an existing gateway before changing helper state files.
for (const port of [18894, 18895, ...(process.argv.includes('--browser') ? [18896] : [])]) {
  await new Promise<void>((resolve, reject) => {
    const probe = createTcpServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
  });
}
// Dart tooling expects stable paths; all service state and logs use a short
// private path so Rust's Unix sockets stay below macOS's sockaddr limit.
const publicRoot = path.join(repo, '.pirc/flutter-parity-integration');
rmSync(publicRoot, { recursive: true, force: true });
mkdirSync(publicRoot, { recursive: true, mode: 0o700 });
chmodSync(publicRoot, 0o700);
// Ledger fixtures must live outside /tmp, which the sandbox always permits.
// Keep Unix socket paths short and retain the existing Git fixture root guard.
const stateParent = historyMode || observationalMemoryMode ? '/private/var/tmp' : '/private/tmp';
const root = mkdtempSync(path.join(stateParent, 'pirc-rust-'));
chmodSync(root, 0o700);
const origin = 'http://127.0.0.1:18894';
const gateway = 'http://127.0.0.1:18895';
const runIdentity = randomBytes(8).toString('hex');
const user = `flutter-parity-${runIdentity}@example.invalid`;
const deviceName = `Flutter parity integration ${runIdentity}`;
const secret = randomBytes(32).toString('hex');
const token = randomBytes(32).toString('hex');
const browserMode = process.argv.includes('--browser');
const managementMode = process.argv.includes('--management');
const managementObservation = path.join(publicRoot, 'management-observation.json');
if (managementMode)
  writeFileSync(managementObservation, JSON.stringify({ requests: [] }), { mode: 0o600 });
const managementRequests: Array<{ id: string; capabilities: string[] }> = [];
const htmlMediaMode = process.argv.includes('--html-media');
const htmlMediaFixtureDir = htmlMediaMode
  ? mkdtempSync(path.join(root, 'html-media-fixture-'))
  : undefined;
const htmlMediaFiles = htmlMediaFixtureDir
  ? {
      video: path.join(htmlMediaFixtureDir, 'red-blue.mp4'),
      audio: path.join(htmlMediaFixtureDir, 'tone.wav'),
    }
  : undefined;
const htmlMediaRequests: Array<{ path: string; accept: string }> = [];
if (htmlMediaFiles) {
  const ffmpeg = process.env.PIRC_FFMPEG ?? '/opt/homebrew/bin/ffmpeg';
  execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=160x90:r=10:d=4',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=160x90:r=10:d=4',
    '-filter_complex',
    '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p',
    '-an',
    '-c:v',
    'libx264',
    '-profile:v',
    'baseline',
    '-level',
    '3.0',
    '-g',
    '1',
    '-keyint_min',
    '1',
    '-sc_threshold',
    '0',
    '-t',
    '8',
    '-movflags',
    '+faststart',
    '-y',
    htmlMediaFiles.video,
  ]);
  execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=44100:duration=8',
    '-c:a',
    'pcm_s16le',
    '-ar',
    '44100',
    '-ac',
    '1',
    '-y',
    htmlMediaFiles.audio,
  ]);
}
let browserPage: ReturnType<typeof Bun.serve> | undefined;
const documentMode = process.argv.includes('--documents');
const documentBackgroundImages = documentMode
  ? JSON.parse(readFileSync(path.join(repo, 'fixtures/mobile-parity/animated-images.json'), 'utf8'))
      .cases
  : [];
const documentBackgroundSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10" viewBox="0 0 20 10"><rect width="10" height="10" fill="red"/><rect x="10" width="10" height="10" fill="blue"/></svg>';
const documentBackgroundSvgDataUri = `data:image/svg+xml,${encodeURIComponent(documentBackgroundSvg)}`;
const documentBackgroundLayersFixture = documentMode
  ? JSON.parse(
      readFileSync(
        path.join(repo, 'fixtures/mobile-parity/background-layers-expected.json'),
        'utf8',
      ),
    )
  : undefined;
const documentRasterBackgroundSizesFixture = documentMode
  ? JSON.parse(
      readFileSync(
        path.join(repo, 'fixtures/mobile-parity/raster-background-sizes-expected.json'),
        'utf8',
      ),
    )
  : undefined;
const documentBackgroundLayerAssets: Record<string, any> = Object.fromEntries(
  (documentBackgroundLayersFixture?.assets ?? []).map((asset: any) => [asset.id, asset]),
);
function documentBackgroundLayerAsset(dataUri: string) {
  const comma = dataUri.indexOf(',');
  if (!dataUri.startsWith('data:') || comma < 0) {
    throw new Error('Invalid background layer fixture data URI.');
  }
  const metadata = dataUri.slice(5, comma);
  const payload = dataUri.slice(comma + 1);
  const mimeType = metadata.split(';')[0];
  const bytes = metadata.split(';').includes('base64')
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');
  return { mimeType, bytes };
}
function documentBackgroundLayerHtml(caseId: string, remoteSvg = false) {
  const fixtureCase = documentBackgroundLayersFixture?.cases?.find(
    (item: any) => item.id === caseId,
  );
  if (!fixtureCase) return null;
  const declarations = Object.entries(fixtureCase.authoredCss as Record<string, string>).map(
    ([property, authoredValue]) => {
      const name = property.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
      const value = authoredValue.replace(/<asset:([^>]+)>/g, (_token: string, assetId: string) => {
        if (remoteSvg && assetId === 'svg-red-blue') {
          return '/parity-documents/assets/background-layers/svg-red-blue.svg';
        }
        const asset = documentBackgroundLayerAssets[assetId];
        if (!asset?.dataUri) throw new Error(`Unknown background fixture asset: ${assetId}`);
        return asset.dataUri;
      });
      return `${name}:${value}`;
    },
  );
  const style = ['width:120px', 'height:80px', ...declarations]
    .join(';')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return (
    '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}</style></head><body>' +
    `<div id="background-layer" style="${style}"></div>` +
    '</body></html>'
  );
}
function documentRasterBackgroundSizesHtml(caseId: string, remotePng = false) {
  const fixtureCase = documentRasterBackgroundSizesFixture?.cases?.find(
    (item: any) => item.id === caseId,
  );
  const rasterAsset = documentRasterBackgroundSizesFixture?.assets?.find(
    (item: any) => item.id === 'png-red-blue-40x20',
  );
  if (!fixtureCase || !rasterAsset?.dataUri) return null;
  const authoredCss = { ...fixtureCase.authoredCss };
  if (remotePng) {
    if (
      typeof authoredCss.backgroundImage !== 'string' ||
      !authoredCss.backgroundImage.includes(rasterAsset.dataUri)
    ) {
      return null;
    }
    authoredCss.backgroundImage = authoredCss.backgroundImage.replace(
      rasterAsset.dataUri,
      '/parity-documents/assets/raster-background-size.png',
    );
  }
  const declarations = Object.entries(authoredCss).map(([property, authoredValue]) => {
    const name = property.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
    return `${name}:${authoredValue}`;
  });
  const style = [
    'box-sizing:border-box',
    'width:120px',
    'height:80px',
    'margin:0',
    'border:0',
    'padding:0',
    ...declarations,
  ]
    .join(';')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return (
    '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden}</style></head><body>' +
    `<div id="raster-background-size" style="${style}"></div>` +
    '</body></html>'
  );
}

const documentStyleFixture = documentMode
  ? JSON.parse(
      readFileSync(path.join(repo, 'fixtures/mobile-parity/html-document-styles.json'), 'utf8'),
    )
  : undefined;
const documentControlFixture = documentMode
  ? JSON.parse(
      readFileSync(path.join(repo, 'fixtures/mobile-parity/html-control-styles.json'), 'utf8'),
    )
  : undefined;
const documentNamedHistoryFixture = documentMode
  ? JSON.parse(
      readFileSync(
        path.join(repo, 'fixtures/mobile-parity/app-document-target-context.json'),
        'utf8',
      ),
    ).namedHistoryDocument
  : undefined;
let namedHistoryReads = 0;
const documentAppShell = documentMode
  ? readFileSync(path.join(repo, 'apps/web/index.html'), 'utf8')
  : undefined;
const documentRequests: Array<{
  method: string;
  path: string;
  body: string;
  bodyBase64: string;
  contentType: string;
  accept: string;
  cacheControl: string;
  pragma: string;
  ifNoneMatch: string;
  ifModifiedSince: string;
  authenticated?: boolean;
  responseStatus?: number;
}> = [];
const answerRecoveryMode = process.argv.includes('--answer-recovery');
const runControlMode = process.argv.includes('--run-control');
const pushRaceMode = process.argv.includes('--push-race');
let pushGateArmed = false;
let pushGateRelease: (() => void) | undefined;
let pushGateForwarded = false;
let invalidPushKey = false;
const projectTrustMode = process.argv.includes('--project-trust');
let testDeviceToken: string | undefined;
let answerFault: 'before-forward' | 'after-accept' | undefined;
let answerForwards = 0,
  answerFaults = 0;
const terminalMode = process.argv.includes('--terminal');
const gitMode = process.argv.includes('--git') || projectTrustMode || terminalMode || browserMode;
const gitToken = randomBytes(32).toString('hex');
let gitDirectory: string | undefined;
let projectTrustConfigPath: string | undefined;
let projectTrustVersion: 'v1' | 'v2' = 'v1';
let projectTrustPosts = 0;
let projectTrustConflicts = 0;
const projectTrustConfig = (version: 'v1' | 'v2') => ({
  env: { PIRC_PARITY_TRUST_FIXTURE: version },
  allowedPaths: [`./parity-${version}`],
  hooks: { sessionStart: [{ command: `printf project-trust-${version}` }] },
});
function writeProjectTrustConfig(version: 'v1' | 'v2') {
  if (!projectTrustConfigPath) throw new Error('Project trust fixture is not ready.');
  projectTrustVersion = version;
  writeFileSync(projectTrustConfigPath, JSON.stringify(projectTrustConfig(version), null, 2), {
    mode: 0o600,
  });
}
const isProjectTrustRequest = (value: string | undefined) => {
  if (!value) return false;
  try {
    return /^\/api\/workspaces\/[^/]+\/project-trust$/.test(new URL(value, origin).pathname);
  } catch {
    return false;
  }
};
if (historyMode && observationalMemoryMode) throw new Error('Use one fixture mode per run.');
if ((historyMode || observationalMemoryMode) && gitMode)
  throw new Error('Use one fixture mode per run.');
if ((historyMode || observationalMemoryMode) && process.argv.includes('--files'))
  throw new Error('Use one fixture mode per run.');
if (gitMode && process.argv.includes('--files'))
  throw new Error('Use one fixture mode per run.');
if (
  htmlMediaMode &&
  (documentMode || browserMode || gitMode || answerRecoveryMode || process.argv.includes('--files'))
)
  throw new Error('Use one fixture mode per run.');
if (
  [
    gitMode,
    answerRecoveryMode,
    process.argv.includes('--files'),
    historyMode,
    observationalMemoryMode,
  ].filter(Boolean).length > 1
)
  throw new Error('Use one fixture mode per run.');
type ManagedChild = {
  name: string;
  executable: string;
  args: string[];
  pid: number;
  process: ChildProcess;
  exited: Promise<number | null>;
  spawnError?: Error;
};
const children: ManagedChild[] = [];
const fixtureTemp = path.join(root, 'scratch');
mkdirSync(fixtureTemp, { recursive: true, mode: 0o700 });
const base = { ...Object.fromEntries(
  ['HOME', 'USER', 'LANG', 'TMPDIR', 'PATH', 'NODE_EXTRA_CA_CERTS'].flatMap((k) =>
    process.env[k] ? [[k, process.env[k]!]] : [],
  ),
), TMPDIR: fixtureTemp };
const llm: FakeLlm = await startFakeLlm();
const longObservationContent =
  'Keep this observation as **plain text**. Keep it as an ordinary ledger string without Markdown formatting. When the user opens it, the complete content should remain available in the native panel. ' +
  'The native memory fixture preserves stable details across this observation. '.repeat(10).trim();
const droppedObservationContent =
  'An earlier assumption was dropped after the user corrected it.';
const activeObservationContent =
  'Use Flutter for the content and preserve the original native interactions.';
const reflectionContents = [
  'Keep the long observation available as plain text in the native memory panel.',
  'Preserve the original Flutter interactions while reviewing the active observation.',
];
const memoryId = (content: string) =>
  createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 12);
const longObservationId = memoryId(longObservationContent);
const droppedObservationId = memoryId(droppedObservationContent);
const activeObservationId = memoryId(activeObservationContent);
const reflectionIds = reflectionContents.map(memoryId);
const memoryWorkerCalls = { observer: 0, reflector: 0, dropper: 0 };
let memoryFixtureError: string | undefined;
function memoryWorkerRequestSummary() {
  return {
    requests: llm.requests.map(({ path: requestPath, body }) => {
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const tools = Array.isArray(body?.tools) ? body.tools : [];
      const sourceEntryMarkerCount = new Set(
        [...JSON.stringify(messages).matchAll(/\[Source entry id:\s*([^\]\s]+)\]/g)].map(
          (match) => match[1],
        ),
      ).size;
      return {
        path: new URL(requestPath, 'http://localhost').pathname,
        model: typeof body?.model === 'string' ? body.model.slice(0, 80) : null,
        toolNames: tools
          .map((tool: any) => tool?.function?.name ?? tool?.name)
          .filter((name: unknown): name is string => typeof name === 'string')
          .map((name: string) => name.slice(0, 80)),
        messageRoles: messages.map((message: any) =>
          typeof message?.role === 'string' ? message.role.slice(0, 32) : '<unknown>',
        ),
        sourceEntryMarkerCount,
      };
    }),
    memoryWorkerCalls: { ...memoryWorkerCalls },
  };
}
function ptcReply(code: string): Reply {
  return {
    tool: {
      id: 'ptc-' + Date.now(),
      name: 'ptc',
      args: { code },
    },
  };
}
const toolCallCode = (name: string, args: unknown) =>
  'return await tools.call(' + JSON.stringify(name) + ', ' + JSON.stringify(args) + ');';
llm.route = (body) => {
  const messages = body.messages ?? [];
  const last = messages.at(-1);
  const lastUser = [...messages].reverse().find((message: any) => message?.role === 'user');
  const content =
    typeof lastUser?.content === 'string'
      ? lastUser.content
      : (lastUser?.content ?? [])
          .filter((part: any) => part.type === 'text')
          .map((part: any) => part.text)
          .join('\n');
  if (last?.role === 'tool') {
    if (content === '/parity-ptc') return { text: 'PTC_VERIFIED' };
    if (content === '/parity-question') return { text: '已收到你的回答，謝謝。' };
    return { text: '已呼叫記憶工具。請核對記憶提案。' };
  }
  if (historyMode) {
    const index = historyFixtureMessages.findIndex(
      (message) => message.role === 'user' && message.content === content,
    );
    if (index >= 0) {
      return index === 144
        ? { hang: true }
        : { text: historyFixtureMessages[index + 1]?.content ?? '' };
    }
  }
  if (observationalMemoryMode) {
    const workerTool = (body.tools ?? [])
      .map((tool: any) => tool?.function?.name ?? tool?.name)
      .find((name: string) =>
        ['record_observations', 'record_reflections', 'drop_observations'].includes(name),
      );
    const sourceEntryIds = fixtureMemorySources(content);
    if (workerTool === 'record_observations') {
      memoryWorkerCalls.observer++;
      if (sourceEntryIds.length === 0) {
        memoryFixtureError = 'observer worker request had no source entry ids';
        return { text: 'Fixture worker could not identify source entries.' };
      }
      const sourceEntryId = sourceEntryIds[0];
      return {
        tool: {
          id: `memory-observer-${memoryWorkerCalls.observer}`,
          name: workerTool,
          args: {
            observations: [
              {
                timestamp: '2026-10-16 12:00',
                content: longObservationContent,
                relevance: 'critical',
                sourceEntryIds: [sourceEntryId],
              },
              {
                timestamp: '2026-10-16 12:01',
                content: droppedObservationContent,
                relevance: 'low',
                sourceEntryIds: [sourceEntryId],
              },
              {
                timestamp: '2026-10-16 12:02',
                content: activeObservationContent,
                relevance: 'medium',
                sourceEntryIds: [sourceEntryId],
              },
            ],
          },
        },
      };
    }
    if (workerTool === 'record_reflections') {
      memoryWorkerCalls.reflector++;
      return {
        tool: {
          id: `memory-reflector-${memoryWorkerCalls.reflector}`,
          name: workerTool,
          args: {
            reflections: reflectionContents.map((reflection, index) => ({
              content: reflection,
              supportingObservationIds: [
                index === 0 ? longObservationId : activeObservationId,
              ],
            })),
          },
        },
      };
    }
    if (workerTool === 'drop_observations') {
      memoryWorkerCalls.dropper++;
      return {
        tool: {
          id: `memory-dropper-${memoryWorkerCalls.dropper}`,
          name: workerTool,
          args: {
            ids: [droppedObservationId],
            reason: 'The earlier assumption was corrected.',
          },
        },
      };
    }
  }
  if (runControlMode) {
    if (content.includes('/parity-hold'))
      return { hang: true, text: 'RUN_CONTROL_HOLD_MARKER' };
    if (content.includes('/parity-steered')) return { text: 'RUN_CONTROL_STEERED_REPLY' };
    if (content.includes('/parity-after-stop'))
      return { text: 'RUN_CONTROL_POST_STOP_REPLY' };
  }
  if (content === '/parity-ptc') {
    const ask = {
      questions: [
        {
          question: 'PTC verification?',
          options: [{ label: 'Continue' }, { label: 'Cancel' }],
        },
      ],
    };
    const code =
      'await tools.write({path:"README.md",content:"PTC acceptance fixture"});\n' +
      'await tools.read({path:"README.md",limit:1});\n' +
      'await tools.call(' + JSON.stringify('ask_user_question') + ', ' + JSON.stringify(ask) + ');' +
      '\nreturn "PTC_VERIFIED";';
    return ptcReply(code);
  }
  if (content === '/parity-question') {
    return ptcReply(
      toolCallCode('ask_user_question', {
        questions: [
          {
            question: 'Choose the native test target',
            options: [
              { label: 'Phone', description: 'One conversation at a time.' },
              { label: 'Tablet', description: 'Keep the workspace panel visible.' },
            ],
          },
          { question: 'Enter a short verification note' },
        ],
      }),
    );
  }
  const remove = /^\/parity-remove (\S+)$/.exec(content);
  if (remove) {
    return ptcReply(
      'return await tools.memory_propose_user(' +
        JSON.stringify({ action: 'remove', id: remove[1], quote: content }) +
        ');',
    );
  }
  const replace = /^\/parity-replace (\S+) (.+)$/s.exec(content);
  if (replace) {
    return ptcReply(
      'return await tools.memory_propose_user(' +
        JSON.stringify({
          action: 'replace',
          id: replace[1],
          content: replace[2],
          quote: content,
        }) +
        ');',
    );
  }
  const ganttMatch = /^\/parity-gantt (\S+)$/.exec(content);
  if (ganttMatch) {
    const fixture = JSON.parse(
      readFileSync(path.join(repo, 'fixtures/mobile-parity/mermaid-gantt.json'), 'utf8'),
    );
    const chart = fixture.cases.find((item: { id: string }) => item.id === ganttMatch[1]);
    if (!chart) throw new Error('Unknown Gantt fixture');
    return { text: chart.source };
  }
  if (content.includes('記住')) {
    const proposal = { action: 'add', content, quote: content };
    const note = { action: 'add', content: '原生驗收筆記：' + content };
    return ptcReply(
      'await tools.memory_propose_user(' +
        JSON.stringify(proposal) +
        ');\nreturn await tools.memory_note(' +
        JSON.stringify(note) +
        ');',
    );
  }
  return { text: '本地固定回覆。此測試使用真實 gateway、聊天節點與沙箱，沒有外部模型呼叫。' };
};
const modelsFile = path.join(root, 'models.json');
writeFileSync(
  modelsFile,
  JSON.stringify({
    providers: {
      local: {
        api: 'openai-completions',
        baseUrl: `${llm.url}/v1`,
        apiKey: 'local-test-only',
        models: [
          {
            id: 'native-test',
            name: 'Native integration (scripted)',
            contextWindow: 100000,
            maxTokens: 1000,
          },
          ...(runControlMode
            ? [
                {
                  id: 'native-test-run-control',
                  name: 'Native run control (scripted)',
                  contextWindow: 100000,
                  maxTokens: 1000,
                },
              ]
            : []),
        ],
      },
    },
    defaultModel: { provider: 'local', id: 'native-test', thinking: 'off' },
  }),
  { mode: 0o600 },
);
function start(name: string, env: Record<string, string>) {
  const executable = name === 'gateway' ? gatewayBin : nodeBin;
  const args = name === 'chat' ? ['chat'] : [];
  const fd = openSync(path.join(root, name + '.log'), 'a', 0o600);
  const childProcess = spawn(executable, args, {
    cwd: repo,
    env: { ...base, ...env },
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  const child: ManagedChild = {
    name,
    executable,
    args,
    pid: childProcess.pid ?? -1,
    process: childProcess,
    exited: new Promise((resolve) => {
      childProcess.once('close', (code) => resolve(code));
    }),
  };
  childProcess.once('error', (error) => {
    child.spawnError = error;
  });
  if (child.pid < 0) {
    throw new Error('Could not spawn ' + executable + ' ' + args.join(' '));
  }
  children.push(child);
  return child;
}
// Preserve bearer authorization; injecting a browser identity here would hide native auth bugs.
const proxyRequest = (req: any) => {
  req.setHeader('host', '127.0.0.1:18894');
  if (!req.getHeader('authorization')) req.setHeader('x-pirc-user', user);
  else req.removeHeader('x-pirc-user');
};
// Middleware mode keeps Vite's SIGTERM auto-exit from racing token cleanup.
const http = createHttpServer();
const upgradedSockets = new Set<Socket>();
http.on('upgrade', (request, socket) => {
  upgradedSockets.add(socket);
  socket.once('close', () => upgradedSockets.delete(socket));
});
const web = await createServer({
  configFile: false,
  plugins: managementMode ? [svelte({ configFile: false })] : [],
  root: path.join(repo, 'apps/web'),
  appType: 'custom',
  server: {
    middlewareMode: { server: http },
    host: '127.0.0.1',
    port: 18894,
    strictPort: true,
    proxy: {
      '/api': {
        target: gateway,
        ws: true,
        headers: { 'x-pirc-proxy-secret': secret },
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (projectTrustMode && req.method === 'POST' && isProjectTrustRequest(req.url)) {
              projectTrustPosts++;
            }
            proxyRequest(proxyReq);
          });
          proxy.on('proxyRes', (proxyRes, req) => {
            if (
              managementMode &&
              req.method === 'POST' &&
              req.url === '/api/native-management/requests' &&
              proxyRes.statusCode === 201
            ) {
              const chunks: Buffer[] = [];
              proxyRes.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
              proxyRes.on('end', () => {
                const value = JSON.parse(Buffer.concat(chunks).toString());
                if (typeof value.id !== 'string' || !Array.isArray(value.capabilities)) return;
                managementRequests.push({ id: value.id, capabilities: value.capabilities });
                writeFileSync(
                  managementObservation,
                  JSON.stringify({ requests: managementRequests }),
                  { mode: 0o600 },
                );
              });
            }
            if (
              projectTrustMode &&
              req.method === 'POST' &&
              isProjectTrustRequest(req.url) &&
              proxyRes.statusCode === 409
            ) {
              projectTrustConflicts++;
            }
          });
          proxy.on('proxyReqWs', proxyRequest);
        },
      },
    },
  },
});
http.on('request', async (req, res) => {
  if (managementMode && new URL(req.url ?? '/', origin).pathname === '/' && req.method === 'GET') {
    const html = await web.transformIndexHtml(
      req.url!,
      readFileSync(path.join(repo, 'apps/web/index.html'), 'utf8'),
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }
  if (pushRaceMode && req.url?.startsWith('/api/parity-push/')) {
    if (!testDeviceToken || req.headers.authorization !== `Bearer ${testDeviceToken}`) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    const pathname = new URL(req.url, origin).pathname;
    if (req.method === 'POST' && pathname === '/api/parity-push/arm') {
      if (pushGateArmed || pushGateRelease) {
        res.writeHead(409);
        res.end();
        return;
      }
      pushGateArmed = true;
      pushGateForwarded = false;
    } else if (req.method === 'POST' && pathname === '/api/parity-push/release') {
      pushGateRelease?.();
    } else if (req.method === 'POST' && pathname === '/api/parity-push/invalid-key') {
      invalidPushKey = true;
    } else if (req.method === 'POST' && pathname === '/api/parity-push/valid-key') {
      invalidPushKey = false;
    } else if (!(req.method === 'GET' && pathname === '/api/parity-push/status')) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        armed: pushGateArmed,
        held: !!pushGateRelease,
        forwarded: pushGateForwarded,
      }),
    );
    return;
  }
  if (
    pushRaceMode &&
    testDeviceToken &&
    req.headers.authorization === `Bearer ${testDeviceToken}` &&
    ((pushGateArmed && req.method === 'POST' && req.url === '/api/push/subscriptions') ||
      (invalidPushKey && req.method === 'GET' && req.url === '/api/push'))
  ) {
    const hold = req.method === 'POST';
    if (hold) pushGateArmed = false;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16384) throw new Error('Push fixture request is too large');
        chunks.push(Buffer.from(chunk));
      }
      const upstream = await fetch(`${gateway}${req.url}`, {
        method: req.method,
        headers: {
          Authorization: req.headers.authorization,
          Host: '127.0.0.1:18894',
          'Content-Type': 'application/json',
          'x-pirc-proxy-secret': secret,
        },
        ...(hold ? { body: Buffer.concat(chunks) } : {}),
      });
      let body = Buffer.from(await upstream.arrayBuffer());
      if (hold && upstream.ok) {
        pushGateForwarded = true;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => release(), 15000);
          function release() {
            clearTimeout(timer);
            pushGateRelease = undefined;
            resolve();
          }
          pushGateRelease = release;
        });
      } else if (!hold && upstream.ok) {
        body = Buffer.from(
          JSON.stringify({ ...JSON.parse(body.toString()), publicKey: 'invalid-vapid-fixture' }),
        );
      }
      if (!res.destroyed && !res.writableEnded) {
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        res.end(body);
      }
    } catch {
      res.destroy();
    }
    return;
  }

  if (projectTrustMode && req.url?.startsWith('/api/parity-project-trust/')) {
    if (!testDeviceToken || req.headers.authorization !== `Bearer ${testDeviceToken}`) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    const pathname = new URL(req.url, origin).pathname;
    if (pathname === '/api/parity-project-trust/stats' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          trustPosts: projectTrustPosts,
          trustConflicts: projectTrustConflicts,
          configVersion: projectTrustVersion,
        }),
      );
      return;
    }
    if (pathname === '/api/parity-project-trust/config' && req.method === 'POST') {
      try {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of req) {
          const data = Buffer.from(chunk);
          length += data.length;
          if (length > 1024) throw new Error('Fixture config request too large.');
          chunks.push(data);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          Object.keys(body).length !== 1 ||
          (body.version !== 'v1' && body.version !== 'v2')
        ) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'version must be v1 or v2' }));
          return;
        }
        writeProjectTrustConfig(body.version);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ configVersion: projectTrustVersion }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (error as Error).message }));
      }
      return;
    }
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }
  // Fault injection exists only in this explicitly opted-in private test host.
  if (answerRecoveryMode && req.url?.startsWith('/api/parity/answer-fault')) {
    if (!testDeviceToken || req.headers.authorization !== `Bearer ${testDeviceToken}`) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.method === 'POST') {
      const mode = new URL(req.url, origin).searchParams.get('mode');
      if (mode !== 'before-forward' && mode !== 'after-accept') {
        res.writeHead(400);
        res.end();
        return;
      }
      answerFault = mode;
      console.log(`ANSWER_FAULT:armed=${mode}`);
      answerForwards = 0;
      answerFaults = 0;
    } else if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        armed: answerFault ?? null,
        forwards: answerForwards,
        faults: answerFaults,
      }),
    );
    return;
  }
  if (
    answerRecoveryMode &&
    req.method === 'POST' &&
    /^\/api\/sessions\/[^/]+\/interactions\/[^/]+\/answer$/.test(req.url ?? '') &&
    testDeviceToken &&
    req.headers.authorization === `Bearer ${testDeviceToken}`
  ) {
    answerForwards++;
    if (answerFault) {
      const fault = answerFault;
      console.log(`ANSWER_FAULT:consumed=${fault}`);
      answerFault = undefined;
      answerFaults++;
      if (fault === 'before-forward') {
        answerForwards--;
        res.destroy();
        req.resume();
        return;
      }
      try {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 65536) throw new Error('Test answer body too large');
          chunks.push(Buffer.from(chunk));
        }
        const response = await fetch(`${gateway}${req.url}`, {
          method: 'POST',
          headers: {
            Authorization: req.headers.authorization,
            Host: '127.0.0.1:18894',
            'Content-Type': 'application/json',
            'x-pirc-proxy-secret': secret,
          },
          body: Buffer.concat(chunks),
        });
        const body = Buffer.from(await response.arrayBuffer());
        console.log(`ANSWER_FAULT:forward-status=${response.status}`);
        if (response.ok) {
          // The upstream accepted the mutation, but its reply is discarded.
          // Return a deterministic proxy failure: Bun's node:http shim may
          // swallow res.destroy() after this async upstream read.
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              code: 'upstream_reply_lost',
              message: 'Isolated test proxy discarded the accepted answer reply.',
            }),
          );
          return;
        }
        res.writeHead(response.status, { 'Content-Type': 'application/json' });
        res.end(body);
      } catch {
        res.destroy();
      }
      return;
    }
  }
  if (htmlMediaMode && req.url?.startsWith('/parity-html-media/')) {
    if (!testDeviceToken || req.headers.authorization !== `Bearer ${testDeviceToken}`) {
      res.writeHead(403);
      res.end();
      return;
    }
    const url = new URL(req.url, origin);
    if (url.pathname === '/parity-html-media/receipt' && req.method === 'GET') {
      const counts = Object.fromEntries(
        ['/parity-html-media/red-blue.mp4', '/parity-html-media/tone.wav'].map((path) => [
          path,
          htmlMediaRequests.filter((request) => request.path === path).length,
        ]),
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ counts, requests: htmlMediaRequests }));
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }
    const fixture =
      url.pathname === '/parity-html-media/red-blue.mp4'
        ? { path: htmlMediaFiles!.video, mimeType: 'video/mp4' }
        : url.pathname === '/parity-html-media/tone.wav'
          ? { path: htmlMediaFiles!.audio, mimeType: 'audio/wav' }
          : null;
    if (!fixture) {
      res.writeHead(404);
      res.end();
      return;
    }
    htmlMediaRequests.push({ path: url.pathname, accept: String(req.headers.accept ?? '') });
    const bytes = readFileSync(fixture.path);
    res.writeHead(200, {
      'Content-Type': fixture.mimeType,
      'Content-Length': bytes.length,
      'Cache-Control': 'no-store',
    });
    res.end(bytes);
    return;
  }
  if (documentMode && req.url?.startsWith('/parity-documents/')) {
    if (!testDeviceToken || req.headers.authorization !== `Bearer ${testDeviceToken}`) {
      res.writeHead(403);
      res.end();
      return;
    }
    const check = await fetch(`${origin}/api/sessions`, {
      headers: { Authorization: req.headers.authorization },
    });
    await check.arrayBuffer();
    if (!check.ok) {
      res.writeHead(check.status);
      res.end();
      return;
    }
    const url = new URL(req.url, origin);
    if (url.pathname === '/parity-documents/receipt') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ requests: documentRequests }));
      return;
    }
    if (url.pathname === '/parity-documents/background-layers-expected') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(
        JSON.stringify({
          cases: documentBackgroundLayersFixture.cases.map((item: any) => ({
            id: item.id,
            element: item.element,
            layerCount: item.effectivePerImageLayer.length,
            pixelSamples: item.pixelSamples,
          })),
        }),
      );
      return;
    }
    if (url.pathname === '/parity-documents/raster-background-sizes-expected') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(
        JSON.stringify({
          fixture: documentRasterBackgroundSizesFixture.fixture,
          browser: documentRasterBackgroundSizesFixture.browser,
          coverage: documentRasterBackgroundSizesFixture.coverage,
          assets: documentRasterBackgroundSizesFixture.assets.map((asset: any) => ({
            id: asset.id,
            mimeType: asset.mimeType,
            width: asset.width,
            height: asset.height,
            byteLength: asset.byteLength,
            sha256: asset.sha256,
          })),
          cases: documentRasterBackgroundSizesFixture.cases.map((item: any) => ({
            id: item.id,
            element: item.element,
            authoredCss: item.authoredCss,
            effectivePerImageLayer: item.effectivePerImageLayer,
            layerCount: item.effectivePerImageLayer.length,
            pixelSamples: item.pixelSamples,
          })),
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) throw new Error('Document fixture body too large');
      chunks.push(Buffer.from(chunk));
    }
    const bodyBytes = Buffer.concat(chunks);
    const body = bodyBytes.toString('utf8');
    const recordedRequest: (typeof documentRequests)[number] = {
      method: req.method ?? 'GET',
      path: req.url,
      body,
      bodyBase64: bodyBytes.toString('base64'),
      contentType: String(req.headers['content-type'] ?? ''),
      accept: String(req.headers.accept ?? ''),
      cacheControl: String(req.headers['cache-control'] ?? ''),
      pragma: String(req.headers.pragma ?? ''),
      ifNoneMatch: String(req.headers['if-none-match'] ?? ''),
      ifModifiedSince: String(req.headers['if-modified-since'] ?? ''),
      ...(url.pathname === '/parity-documents/assets/raster-background-size.png'
        ? {
            authenticated: req.headers.authorization === `Bearer ${testDeviceToken}`,
          }
        : {}),
    };
    documentRequests.push(recordedRequest);
    if (url.pathname === '/parity-documents/raster-background-sizes') {
      const caseId = url.searchParams.get('case') ?? '';
      const remotePng = url.searchParams.get('remotePng') === '1';
      if (
        req.method !== 'GET' ||
        (url.searchParams.has('remotePng') && !remotePng) ||
        (remotePng && caseId !== 'size-60px-40px')
      ) {
        res.writeHead(404);
        res.end();
        return;
      }
      const source = documentRasterBackgroundSizesHtml(caseId, remotePng);
      if (source == null) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(source);
      return;
    }
    if (url.pathname === '/parity-documents/assets/raster-background-size.png') {
      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end();
        return;
      }
      const fixture = documentRasterBackgroundSizesFixture.assets.find(
        (asset: any) => asset.id === 'png-red-blue-40x20',
      );
      if (!fixture?.dataUri || fixture.mimeType !== 'image/png') {
        res.writeHead(404);
        res.end();
        return;
      }
      const asset = documentBackgroundLayerAsset(fixture.dataUri);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
        'Content-Length': asset.bytes.length,
      });
      res.end(asset.bytes);
      return;
    }
    if (url.pathname === '/parity-documents/background-layers') {
      const caseId = url.searchParams.get('case') ?? '';
      const remoteSvg = url.searchParams.get('remoteSvg') === '1';
      if (
        req.method !== 'GET' ||
        (url.searchParams.has('remoteSvg') && !remoteSvg) ||
        (remoteSvg && caseId !== 'svg-over-transparent-stop-gradient')
      ) {
        res.writeHead(404);
        res.end();
        return;
      }
      const source = documentBackgroundLayerHtml(caseId, remoteSvg);
      if (source == null) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(source);
      return;
    }
    if (url.pathname === '/parity-documents/assets/background-layers/svg-red-blue.svg') {
      const fixture = documentBackgroundLayerAssets['svg-red-blue'];
      if (!fixture?.dataUri || fixture.mimeType !== 'image/svg+xml') {
        res.writeHead(404);
        res.end();
        return;
      }
      const asset = documentBackgroundLayerAsset(fixture.dataUri);
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': asset.bytes.length,
      });
      res.end(asset.bytes);
      return;
    }
    if (url.pathname === '/parity-documents/background-source') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html><head><link rel="stylesheet" href="/parity-documents/css/background.css"></head><body><div id="gif">GIF foreground</div><div id="webp">WebP foreground</div><div id="linear"></div><div id="radial"></div><div id="svg-remote"></div><div id="svg-data"></div></body></html>',
      );
      return;
    }
    if (url.pathname === '/parity-documents/css/background.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      res.end(
        `:root{--linear-start:#ff0000;--linear-end:#0000ff}body{margin:0}#gif,#webp,#linear,#radial{width:100px;height:100px}#svg-remote,#svg-data{width:100px;height:50px;background-size:100% 100%;background-repeat:no-repeat}#gif,#webp{background-size:cover;background-position:center;background-repeat:no-repeat}#gif{background-image:url(../assets/animated.gif)}#webp{background-image:url(../assets/animated.webp)}#linear{background-image:linear-gradient(to right,var(--linear-start),var(--linear-end))}#radial{background:radial-gradient(circle at center,#00ff00 0%,#000000 100%)}#svg-remote{background-image:url(../assets/split.svg)}#svg-data{background-image:url('${documentBackgroundSvgDataUri}')}`,
      );
      return;
    }
    if (url.pathname.startsWith('/parity-documents/assets/animated.')) {
      const kind = url.pathname.endsWith('.gif') ? 'image/gif' : 'image/webp';
      const fixture = documentBackgroundImages.find((item: any) => item.mimeType === kind);
      if (!fixture) throw new Error('Missing animated background fixture');
      res.writeHead(200, { 'Content-Type': kind });
      res.end(Buffer.from(fixture.base64, 'base64'));
      return;
    }
    if (url.pathname === '/parity-documents/assets/split.svg') {
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(documentBackgroundSvg);
      return;
    }
    if (url.pathname === '/parity-documents/download-source') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html><body><input value="kept"><a href="/parity-documents/download-file" download="ignored.csv">Save report</a></body></html>',
      );
      return;
    }
    if (url.pathname === '/parity-documents/download-file') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="pirc-save-acceptance.bin"',
      });
      res.end(Buffer.from([0, 127, 128, 255, 13, 10, 65]));
      return;
    }
    if (url.pathname === '/parity-documents/binary-redirect307') {
      res.writeHead(307, { Location: '/parity-documents/binary-echo' });
      res.end();
      return;
    }
    if (url.pathname === '/parity-documents/binary-echo') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html><head><title>Binary upload</title></head><body><p>Upload received</p></body></html>',
      );
      return;
    }
    if (url.pathname === '/parity-documents/app-redirect303') {
      res.writeHead(303, {
        Location: '/parity-documents/app-shell?open=schedules&schedule=real-route',
      });
      res.end();
      return;
    }
    if (url.pathname === '/parity-documents/redirect303') {
      res.writeHead(303, { Location: '/parity-documents/echo?redirected=1' });
      res.end();
      return;
    }
    if (
      url.pathname === '/parity-documents/empty204' ||
      url.pathname === '/parity-documents/empty205'
    ) {
      res.writeHead(url.pathname.endsWith('204') ? 204 : 205);
      res.end();
      return;
    }
    if (url.pathname === '/parity-documents/named-history') {
      const first = ++namedHistoryReads === 1;
      const version = first ? 'server-v1' : 'server-v2';
      const tokens = documentNamedHistoryFixture.htmlVersionTokens;
      let source = documentNamedHistoryFixture.responseHtmlTemplate
        .replaceAll(tokens.version, version)
        .replaceAll(tokens.number, first ? '11' : '22');
      if (tokens.range) source = source.replaceAll(tokens.range, first ? '10' : '20');
      if (tokens.checkAttribute)
        source = source.replaceAll(tokens.checkAttribute, first ? 'checked' : '');
      if (tokens.selectOneAttribute)
        source = source.replaceAll(tokens.selectOneAttribute, first ? 'selected' : '');
      if (tokens.selectTwoAttribute)
        source = source.replaceAll(tokens.selectTwoAttribute, first ? '' : 'selected');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      recordedRequest.responseStatus = 200;
      res.end(source);
      return;
    }
    if (url.pathname === '/parity-documents/named-history-next') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      recordedRequest.responseStatus = 200;
      res.end('<!doctype html><title>Named history next</title><p>Next history page</p>');
      return;
    }
    if (url.pathname === '/parity-documents/post-no-store') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      recordedRequest.responseStatus = 200;
      res.end('<!doctype html><title>No-store POST</title><p>Submitted data</p>');
      return;
    }
    if (url.pathname === '/parity-documents/cache') {
      const etag = '"native-cache-v1"';
      const lastModified = 'Wed, 21 Oct 2015 07:28:00 GMT';
      const cacheHeaders = {
        'Cache-Control': 'no-cache',
        ETag: etag,
        'Last-Modified': lastModified,
        Vary: 'Origin',
      };
      const ifNoneMatch = String(req.headers['if-none-match'] ?? '');
      const hasIfNoneMatch = req.headers['if-none-match'] != null;
      const etagMatches = ifNoneMatch
        .split(',')
        .some((candidate) => candidate.trim() === etag || candidate.trim() === '*');
      const ifModifiedSinceTime = Date.parse(String(req.headers['if-modified-since'] ?? ''));
      const ifModifiedSinceMatches =
        Number.isFinite(ifModifiedSinceTime) && ifModifiedSinceTime >= Date.parse(lastModified);
      const notModified =
        req.method !== 'POST' && (hasIfNoneMatch ? etagMatches : ifModifiedSinceMatches);
      if (notModified) {
        recordedRequest.responseStatus = 304;
        res.writeHead(304, cacheHeaders);
        res.end();
        return;
      }
      recordedRequest.responseStatus = 200;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        ...cacheHeaders,
      });
      res.end(
        '<!doctype html><html><head><meta charset="utf-8"><title>Native cache fixture</title></head><body><h1>Native cache fixture</h1><form action="/parity-documents/cache" method="get"><label>Message <input name="message" value="server default"></label><button>Submit</button></form></body></html>',
      );
      return;
    }
    const value =
      new URLSearchParams(req.method === 'POST' ? body : url.search).get('message') ?? 'response';
    const escape = (value: string) =>
      value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    if (url.pathname === '/parity-documents/control-styles') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        documentControlFixture.responseHtml.replaceAll(
          documentControlFixture.submitPath,
          '/parity-documents/echo',
        ),
      );
      return;
    }
    if (url.pathname === '/parity-documents/styles') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(documentStyleFixture.responseHtml);
      return;
    }
    if (
      url.pathname === '/parity-documents/app-shell' ||
      url.pathname.startsWith('/parity-documents/deep/')
    ) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(documentAppShell ?? '');
      return;
    }
    if (url.pathname.startsWith('/parity-documents/css/')) {
      if (req.headers.accept !== 'text/css,*/*;q=0.1') {
        res.writeHead(406);
        res.end('A stylesheet Accept header is required.');
        return;
      }
      const key = url.pathname.replace('/parity-documents/', '/raw/styles/');
      const stylesheet = documentStyleFixture.stylesheets[key];
      res.writeHead(stylesheet == null ? 404 : 200, { 'Content-Type': 'text/css; charset=utf-8' });
      res.end(stylesheet ?? '');
      return;
    }
    const next = url.pathname === '/parity-documents/next';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>${next ? 'Next document' : 'Echo document'}</title></head><body><h1>${next ? 'Next result' : 'Echo result'}</h1><p>${escape(value)}</p>${next ? '' : '<form action="next" method="post"><input name="message" value="response"><button>Next</button></form>'}</body></html>`,
    );
    return;
  }
  if (process.argv.includes('--files') && req.url?.startsWith('/parity-images/')) {
    if (!req.headers.authorization) {
      res.writeHead(401);
      res.end();
      return;
    }
    const check = await fetch(`${origin}/api/sessions`, {
      headers: { Authorization: req.headers.authorization },
    });
    await check.arrayBuffer();
    if (!check.ok) {
      res.writeHead(check.status);
      res.end();
      return;
    }
    if (req.url === '/parity-images/redirect.svg') {
      res.writeHead(302, { Location: '/parity-images/chart.svg' });
      res.end();
      return;
    }
    if (req.url === '/parity-images/chart.svg') {
      const fixture = JSON.parse(
        readFileSync(path.join(repo, 'fixtures/mobile-parity/markdown-images.json'), 'utf8'),
      );
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(fixture.svg);
      return;
    }
    res.writeHead(404);
    res.end();
    return;
  }
  web.middlewares(req, res, () => {
    res.statusCode = 404;
    res.end();
  });
});
let deviceId: string | undefined;
let filesSession: string | undefined;
let historySession: string | undefined;
let filesClipboard = '';
let memoryPassive: boolean | undefined;
let closing = false;
const ownedSessionIds = new Set<string>();
const defines = path.join(publicRoot, 'defines.json');
async function fixtureRequest<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${origin}${url}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(10000),
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`Fixture API ${init.method ?? 'GET'} returned ${response.status}.`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
async function createFixtureSession(name: string): Promise<string> {
  const created = await fixtureRequest<{ session?: { id?: string } }>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ workspaceId: 'chat:chats' }),
  });
  const id = created.session?.id;
  if (!id) throw new Error('Fixture session creation returned no session id.');
  ownedSessionIds.add(id);
  await fixtureRequest(`/api/sessions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
  return id;
}
async function acquireFixtureControl(sessionId: string) {
  const clientId = `parity-${runIdentity}`;
  const response = await fixtureRequest<{ lease?: { generation?: number } }>(
    `/api/sessions/${sessionId}/control/acquire`,
    { method: 'POST', body: JSON.stringify({ clientId }) },
  );
  const generation = response.lease?.generation;
  if (!generation) throw new Error('Fixture session control lease was not acquired.');
  return { clientId, generation };
}
async function sendFixtureCommand(
  sessionId: string,
  lease: { clientId: string; generation: number },
  payload: { type: string; message?: string },
) {
  await fixtureRequest(`/api/sessions/${sessionId}/commands`, {
    method: 'POST',
    body: JSON.stringify({
      commandId: `parity-${randomBytes(12).toString('hex')}`,
      clientId: lease.clientId,
      generation: lease.generation,
      payload,
    }),
  });
}
const fixtureSnapshot = (sessionId: string) =>
  fixtureRequest<any>(`/api/sessions/${sessionId}/snapshot`);
async function pollFixture<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  reason: string,
  timeoutMs = 60000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await sleep(120);
  }
  throw new Error(`Timed out waiting for ${reason}.`);
}
const activeRunStatuses = new Set(['queued', 'running', 'waiting_input', 'stopping']);
async function seedHistoryFixture(): Promise<void> {
  if (!historySession) throw new Error('History fixture session was not created.');
  if (
    historyFixtureMessages.length !== 145 ||
    historyFixtureMessages.some((message, index) => message.role !== (index % 2 ? 'assistant' : 'user'))
  ) {
    throw new Error('Pinned conversation history fixture is not 145 alternating user/assistant messages.');
  }
  const lease = await acquireFixtureControl(historySession);
  for (let index = 0; index <= 142; index += 2) {
    await sendFixtureCommand(historySession, lease, {
      type: 'prompt',
      message: historyFixtureMessages[index].content,
    });
    const expectedLength = index + 2;
    await pollFixture(
      () => fixtureSnapshot(historySession!),
      (snapshot) =>
        snapshot.history?.length === expectedLength &&
        !activeRunStatuses.has(snapshot.run?.status),
      `history ledger entry ${expectedLength - 1}`,
    );
  }
  await sendFixtureCommand(historySession, lease, {
    type: 'prompt',
    message: historyFixtureMessages[144].content,
  });
  const pending = await pollFixture(
    () => fixtureSnapshot(historySession!),
    (snapshot) =>
      snapshot.history?.length === 145 &&
      normalizeHistoryContent(snapshot.history.at(-1)?.content) ===
        historyFixtureMessages[144].content,
    'persisted final history user message',
  );
  if (pending.history.length !== 145)
    throw new Error('History fixture snapshot did not retain all 145 messages.');
  await sendFixtureCommand(historySession, lease, { type: 'stop' });
  const idle = await pollFixture(
    () => fixtureSnapshot(historySession!),
    (snapshot) =>
      snapshot.history?.length === 146 && !activeRunStatuses.has(snapshot.run?.status),
    'stopped final history run',
  );
  if (
    idle.history.slice(0, 145).some(
      (entry: any, index: number) =>
        entry.role !== historyFixtureMessages[index].role ||
        normalizeHistoryContent(entry.content) !== historyFixtureMessages[index].content,
    )
  ) {
    throw new Error('History fixture snapshot did not preserve the pinned ordered transcript.');
  }
  const stoppedAssistant = idle.history[145];
  if (
    stoppedAssistant.role !== 'assistant' ||
    normalizeHistoryContent(stoppedAssistant.content) !== '' ||
    stoppedAssistant.stopReason !== 'aborted'
  ) {
    throw new Error('History fixture did not retain the real aborted assistant message.');
  }
  const historyIds = idle.history
    .map((entry: any) => entry.id)
    .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
  if (historyIds.length > 0 && new Set(historyIds).size !== historyIds.length) {
    throw new Error('History fixture snapshot repeated an available message id.');
  }
}
function normalizeHistoryContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
    .map((part: any) => part.text)
    .join('\n');
}
async function seedObservationalMemoryFixture(): Promise<{ passive: boolean }> {
  try {
    if (!filesSession) throw new Error('Observational memory fixture session was not created.');
    const lease = await acquireFixtureControl(filesSession);
    await sendFixtureCommand(filesSession, lease, {
      type: 'prompt',
      message:
        'Create a local synthetic memory fixture. Preserve the original Flutter interactions and retain one long plain-text observation for the native panel.',
    });
    const panel = await pollFixture(
      () => fixtureRequest<any>(`/api/sessions/${filesSession}/panel/state`),
      (state) => {
        if (memoryFixtureError) throw new Error(memoryFixtureError);
        const memory = state.memory;
        return (
          memory?.enabled === true &&
          memory?.counts?.active === 2 &&
          memory?.counts?.dropped === 1 &&
          memory?.counts?.reflections === 2
        );
      },
      'real observational memory worker records',
      90000,
    );
    const memory = panel.memory;
    const observations = memory.observations ?? [];
    const longObservation = observations.find((entry: any) =>
      String(entry.content).includes('**plain text**'),
    );
    const activeObservation = observations.find(
      (entry: any) => entry.id === activeObservationId && entry.dropped !== true,
    );
    const droppedObservation = observations.find(
      (entry: any) => entry.id === droppedObservationId && entry.dropped === true,
    );
    const reflectionRows = memory.reflections ?? [];
    if (
      longObservation?.id !== longObservationId ||
      !activeObservation ||
      !droppedObservation ||
      !reflectionIds.every((id) => reflectionRows.some((entry: any) => entry.id === id)) ||
      memory.passive !== false ||
      Object.values(memoryWorkerCalls).some((count) => count === 0)
    ) {
      throw new Error('Observational memory fixture ledger did not match its worker-generated data.');
    }
    return { passive: Boolean(memory.passive) };
  } catch (error) {
    const summary = memoryWorkerRequestSummary();
    const summaryPath = path.join(publicRoot, 'observational-memory-debug.json');
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2), { mode: 0o600 });
    chmodSync(summaryPath, 0o600);
    const errorType = error instanceof Error ? error.name : typeof error;
    throw new Error(
      `Observational memory fixture failed (${errorType}); sanitized worker summary: ${JSON.stringify(summary)}; saved private summary: ${summaryPath}`,
    );
  }
}
async function stop() {
  if (closing) return;
  closing = true;
  if (!gitMode) {
    for (const sessionId of ownedSessionIds) {
      await fetch(`${origin}/api/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: { Origin: origin },
        signal: AbortSignal.timeout(3000),
      }).catch(() => {});
    }
  }
  if (deviceId)
    await fetch(`${origin}/api/devices/${deviceId}`, {
      method: 'DELETE',
      headers: { Origin: origin },
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  rmSync(defines, { force: true });
  const webClosing = web.close().catch(() => {});
  children.forEach((child) => {
    if (child.process.exitCode === null && child.process.signalCode === null)
      child.process.kill('SIGTERM');
  });
  llm.stop();
  browserPage?.stop(true);
  if (htmlMediaFixtureDir) rmSync(htmlMediaFixtureDir, { recursive: true, force: true });
  for (const socket of upgradedSockets) socket.destroy();
  upgradedSockets.clear();
  http.closeAllConnections();
  const httpClosing = http.listening
    ? new Promise<void>((resolve) => http.close(() => resolve()))
    : Promise.resolve();
  await Promise.race([Promise.all(children.map((child) => child.exited)), sleep(5000)]);
  children.forEach((child) => {
    if (child.process.exitCode === null && child.process.signalCode === null)
      child.process.kill('SIGKILL');
  });
  await Promise.race([Promise.all(children.map((c) => c.exited)), sleep(5000)]);
  await Promise.race([Promise.all([webClosing, httpClosing]), sleep(5000)]);
  if (gitMode && gitDirectory) cleanGitFixture(root, gitDirectory);
  rmSync(path.join(publicRoot, 'runtime.json'), { force: true });
  rmSync(root, { recursive: true, force: true });
}
process.on('SIGINT', () => void stop().then(() => process.exit(0)));
process.on('SIGTERM', () => void stop().then(() => process.exit(0)));
try {
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(18894, '127.0.0.1', resolve);
  });
  const gatewayHome = path.join(root, 'gateway-home');
  mkdirSync(gatewayHome, { recursive: true, mode: 0o700 });
  start('gateway', {
    HOME: gatewayHome,
    PIRC_HOST: '127.0.0.1',
    PIRC_PORT: '18895',
    PIRC_STATE_DIR: path.join(root, 'gateway-state'),
    PIRC_CONFIG_DIR: path.join(root, 'gateway-config'),
    PIRC_MODELS_FILE: modelsFile,
    PIRC_TRUSTED_PROXIES: '127.0.0.1,::1',
    PIRC_IDENTITY_HEADER: 'x-pirc-user',
    PIRC_ALLOWED_USERS: user,
    PIRC_ALLOWED_HOSTS: '127.0.0.1:18894',
    PIRC_ALLOWED_ORIGINS: origin,
    PIRC_PROXY_SECRET: secret,
    PIRC_NODE_TOKENS: JSON.stringify({ chat: token, ...(gitMode ? { git: gitToken } : {}) }),
    PIRC_VAPID_SUBJECT: `mailto:${user}`,
    PIRC_TIMEZONE: 'Asia/Taipei',
  });
  const configDir = path.join(root, 'chat-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      features: {
        sessionTitle: { enabled: false },
        autoMode: { useModel: false },
        observationalMemory: observationalMemoryMode
          ? {
              enabled: true,
              passive: false,
              observeAfterTokens: 1,
              reflectAfterTokens: 1,
              compactAfterTokens: 100000,
              observationsPoolMaxTokens: 320,
              observationsPoolTargetTokens: 220,
              showWorkerNotifications: false,
              workspace: { enabled: false },
            }
          : { enabled: false },
      },
    }),
    { mode: 0o600 },
  );
  const fakeSrt = path.join(root, 'fake-srt.sh');
  writeFileSync(
    fakeSrt,
    '#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  case "$1" in\n    --) shift; break ;;\n    --settings|--control-fd) shift 2 ;;\n    *) shift ;;\n  esac\ndone\nexec "$@"\n',
    { mode: 0o700 },
  );
  chmodSync(fakeSrt, 0o700);
  const chatHome = path.join(root, 'chat-home');
  mkdirSync(chatHome, { recursive: true, mode: 0o700 });
  start('chat', {
    HOME: chatHome,
    PIRC_NODE_ID: 'chat',
    PIRC_NODE_TOKEN: token,
    PIRC_DAEMON_URL: gateway.replace('http:', 'ws:'),
    PIRC_ALLOWED_USERS: user,
    PIRC_STATE_DIR: path.join(root, 'chat-state'),
    PIRC_CONFIG_DIR: configDir,
    PIRC_SANDBOX_SRT: path.join(root, 'fake-srt.sh'),
    PIRC_BROWSER: 'false',
    PIRC_TERMINALS: 'false',
  });
  if (gitMode) {
    if (browserMode)
      browserPage = Bun.serve({
        hostname: '127.0.0.1',
        port: 18896,
        fetch: (request) =>
          new Response(
            readFileSync(
              path.join(
                repo,
                'fixtures/mobile-parity',
                new URL(request.url).pathname === '/touch'
                  ? 'browser-touch-page.html'
                  : 'browser-page.html',
              ),
            ),
            {
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
            },
          ),
      });
    gitDirectory = mkdtempSync(path.join(root, 'git-fixture-'));
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'user.name=Native Fixture',
          '-c',
          'user.email=native@example.invalid',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { cwd: gitDirectory, stdio: 'pipe' },
      );
    git('init', '-q', '-b', 'main', '--template=');
    mkdirSync(path.join(gitDirectory, 'src'));
    if (projectTrustMode) {
      projectTrustConfigPath = path.join(gitDirectory, '.pirc', 'config.json');
      mkdirSync(path.dirname(projectTrustConfigPath), { recursive: true });
      writeProjectTrustConfig('v1');
    }
    writeFileSync(path.join(gitDirectory, 'src/main.ts'), 'export const value = "original";\n');
    writeFileSync(path.join(gitDirectory, 'README.md'), '# Native Git fixture\n');
    git('add', '.');
    git('commit', '-q', '-m', 'Initial native fixture');
    writeFileSync(path.join(gitDirectory, 'history.txt'), 'Second commit\n');
    git('add', '.');
    git('commit', '-q', '-m', 'Add history fixture');
    writeFileSync(path.join(gitDirectory, 'src/main.ts'), 'export const value = "staged";\n');
    git('add', 'src/main.ts');
    writeFileSync(path.join(gitDirectory, 'src/main.ts'), 'export const value = "working";\n');
    writeFileSync(path.join(gitDirectory, 'notes.txt'), 'Untracked native note\n');
    git('mv', 'README.md', 'GUIDE.md');
    const gitHome = path.join(root, terminalMode ? 'terminal-home' : 'git-home');
    mkdirSync(gitHome, { recursive: true, mode: 0o700 });
    start('node', {
      HOME: gitHome,
      ...(terminalMode ? { PIRC_TERMINAL_SHELL: '/bin/bash' } : {}),
      PIRC_NODE_ID: 'git',
      PIRC_NODE_TOKEN: gitToken,
      PIRC_DAEMON_URL: gateway.replace('http:', 'ws:'),
      PIRC_ALLOWED_USERS: user,
      PIRC_STATE_DIR: path.join(root, 'git-node-state'),
      PIRC_CONFIG_DIR: configDir,
      PIRC_SANDBOX_SRT: path.join(root, 'fake-srt.sh'),
      PIRC_WORKSPACES: JSON.stringify([
        { id: 'fixture', path: gitDirectory, displayName: 'Native Git workspace' },
      ]),
      PIRC_BROWSER: browserMode ? 'true' : 'false',
      ...(browserMode
        ? {
            PIRC_BROWSER_EXECUTABLE: requireTestBrowserExecutable(),
            PIRC_BROWSER_ALLOW_PRIVATE: 'localhost',
            PIRC_BROWSER_VIEWPORT: '640x400',
            PIRC_FFMPEG: '/opt/homebrew/bin/ffmpeg',
          }
        : {}),
      PIRC_TERMINALS: terminalMode ? 'true' : 'false',
    });
  }
  let ready = false;
  for (let i = 0; i < 100; i++) {
    const exited = children.find(
      (child) => child.spawnError || child.process.exitCode !== null,
    );
    if (exited) {
      throw new Error(
        exited.name +
          ' exited during startup; log: ' +
          path.join(root, exited.name + '.log'),
      );
    }
    const response = await fetch(`${origin}/api/nodes`).catch(() => null);
    const nodes = response?.ok ? (await response.json()).nodes : [];
    if (
      nodes.some((n: any) => n.id === 'chat') &&
      (!gitMode || nodes.some((n: any) => n.id === 'git'))
    ) {
      ready = true;
      break;
    }
    await sleep(200);
  }
  if (!ready)
    throw new Error(
      'Gateway/chat startup timed out; logs: ' +
        children.map((child) => path.join(root, child.name + '.log')).join(', '),
    );
  // Create a device scoped to this helper's fresh private gateway state.
  const response = await fetch(`${origin}/api/devices`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: deviceName }),
  });
  if (!response.ok) throw new Error(`Device creation returned ${response.status}`);
  const paired = await response.json();
  deviceId = paired.device.id;
  testDeviceToken = paired.token;
  if (historyMode) {
    historySession = await createFixtureSession('Native history fixture');
    await seedHistoryFixture();
  }
  if (observationalMemoryMode) {
    filesSession = await createFixtureSession('Native files fixture');
    memoryPassive = (await seedObservationalMemoryFixture()).passive;
  }
  if (gitMode) {
    const response = await fetch(`${origin}/api/sessions`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'git:fixture' }),
    });
    if (!response.ok) throw new Error(`Git fixture creation returned ${response.status}`);
    filesSession = (await response.json()).session.id;
    const named = await fetch(`${origin}/api/sessions/${filesSession}`, {
      method: 'PATCH',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Native Git fixture' }),
    });
    if (!named.ok) throw new Error(`Git fixture naming returned ${named.status}`);
  }
  if (process.argv.includes('--files')) {
    const response = await fetch(origin + '/api/sessions', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'chat:chats' }),
    });
    if (!response.ok) throw new Error('Files session creation returned ' + response.status);
    filesSession = (await response.json()).session.id;
    ownedSessionIds.add(filesSession);
    const named = await fetch(origin + '/api/sessions/' + filesSession, {
      method: 'PATCH',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Native files fixture' }),
    });
    if (!named.ok) throw new Error('Files fixture naming returned ' + named.status);
    const panel = await fetch(origin + '/api/sessions/' + filesSession + '/panel/state');
    if (!panel.ok) throw new Error('Files fixture session setup returned ' + panel.status);
    const sessionsDir = path.join(root, 'chat-state/chat/chats/sessions');
    const sessionDirs = readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory(),
    );
    if (sessionDirs.length !== 1 || !/^[A-Za-z0-9._-]+$/.test(sessionDirs[0].name)) {
      throw new Error('Could not identify the isolated Rust chat session directory.');
    }
    const directory = path.join(sessionsDir, sessionDirs[0].name);
    const fixture = JSON.parse(
      readFileSync(path.join(repo, 'fixtures/mobile-parity/files.json'), 'utf8'),
    );
    const selectionFixture = JSON.parse(
      readFileSync(path.join(repo, 'fixtures/mobile-parity/markdown-selection.json'), 'utf8'),
    );
    if (
      selectionFixture.cases.find((c: any) => c.id === 'files-readme')?.source !==
      fixture.files.markdown.content
    )
      throw new Error('Files clipboard reference has stale Markdown source');
    const selections = JSON.parse(
      readFileSync(
        path.join(repo, 'fixtures/mobile-parity/markdown-selection-expected.json'),
        'utf8',
      ),
    );
    filesClipboard = selections.find((c: any) => c.id === 'files-readme')?.text;
    if (!filesClipboard) throw new Error('Missing pinned-web Files clipboard reference');
    for (const file of Object.values(fixture.files) as any[]) {
      const target = path.resolve(directory, file.path);
      if (!target.startsWith(directory + path.sep))
        throw new Error('Fixture escaped the isolated session');
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.binary ? new Uint8Array([0, 1, 2, 255]) : file.content);
    }
    mkdirSync(path.join(directory, 'docs'), { recursive: true });
    writeFileSync(
      path.join(directory, 'docs/links.md'),
      '# Native file references\n\n`../src/main.ts:2-4`\n\n../src/main.ts:3\n',
    );
    writeFileSync(
      path.join(directory, 'docs/html.md'),
      '# Native HTML fixture\n\n<details><summary>Open native details</summary>\n\n**Nested Markdown** stays inside the disclosure.\n\n</details>\n\n<pre><code class="hljs"><span class="hljs-keyword">const</span> rawReady = <span class="hljs-literal">true</span>;</code></pre>\n\n<table><tr><th>Native table</th><th>Value</th></tr><tr><td>Result</td><td>Ready</td></tr></table>\n\n```ts\nconst ready = true;\n```\n\n<p><a href="../src/main.ts:4"><img src="/parity-images/redirect.svg" alt="Authenticated HTML image"></a></p>\n',
    );
    const htmlInteractions = JSON.parse(
      readFileSync(path.join(repo, 'fixtures/mobile-parity/html-interactions.json'), 'utf8'),
    );
    writeFileSync(
      path.join(directory, 'docs/html-interactions.md'),
      htmlInteractions.cases.map((item: { source: string }) => item.source).join('\n\n'),
    );
    const mermaid = JSON.parse(
      readFileSync(path.join(repo, 'fixtures/mobile-parity/mermaid.json'), 'utf8'),
    );
    writeFileSync(
      path.join(directory, 'docs/mermaid.md'),
      mermaid.cases
        .filter((item: { id: string }) =>
          ['flowchart-td', 'sequence-greeting', 'pie-budget'].includes(item.id),
        )
        .map((item: { source: string }) => item.source)
        .join('\n\n'),
    );
    const mermaidUml = JSON.parse(
      readFileSync(path.join(repo, 'fixtures/mobile-parity/mermaid-uml.json'), 'utf8'),
    );
    writeFileSync(
      path.join(directory, 'docs/mermaid-uml.md'),
      mermaidUml.cases
        .filter((item: { id: string }) =>
          [
            'class-basic-inheritance',
            'class-cardinality-direction',
            'state-composite-nested',
            'state-choice',
          ].includes(item.id),
        )
        .map((item: { source: string }) => item.source)
        .join('\n\n'),
    );
    const mermaidEr = JSON.parse(
      readFileSync(path.join(repo, 'fixtures/mobile-parity/mermaid-er.json'), 'utf8'),
    );
    writeFileSync(
      path.join(directory, 'docs/mermaid-er.md'),
      mermaidEr.cases
        .filter((item: { id: string }) =>
          [
            'er-basic-entities-attributes',
            'er-entity-aliases',
            'er-direction-lr-and-roles',
          ].includes(item.id),
        )
        .map((item: { source: string }) => item.source)
        .join('\n\n'),
    );
    const images = JSON.parse(
      readFileSync(path.join(repo, 'fixtures/mobile-parity/markdown-images.json'), 'utf8'),
    );
    writeFileSync(
      path.join(directory, 'docs/images.md'),
      `# Native image fixture\n\n[![Authenticated image](/parity-images/redirect.svg)](../src/main.ts:4)\n\n![Raster image](data:image/jpeg;base64,${images.jpeg})\n\n![Missing image](/parity-images/missing.png)\n`,
    );
  }
  writeFileSync(
    defines,
    JSON.stringify({
      PIRC_REAL_GATEWAY: true,
      PIRC_RUN_CONTROL: runControlMode,
      PIRC_PUSH_RACE: pushRaceMode,
      PIRC_DOCUMENTS: documentMode,
      PIRC_ANSWER_RECOVERY: answerRecoveryMode,
      PIRC_HISTORY_SESSION: historySession ?? '',
      PIRC_HISTORY_COUNT: historyMode ? 146 : 0,
      PIRC_HISTORY_STOPPED: historyMode,
      PIRC_FILES_SESSION: filesSession ?? '',
      PIRC_MEMORY_PASSIVE: memoryPassive ?? false,
      PIRC_MEMORY_ACTIVE_COUNT: observationalMemoryMode ? 2 : 0,
      PIRC_MEMORY_DROPPED_COUNT: observationalMemoryMode ? 1 : 0,
      PIRC_MEMORY_REFLECTION_COUNT: observationalMemoryMode ? 2 : 0,
      PIRC_MEMORY_LONG_OBSERVATION_ID: observationalMemoryMode ? longObservationId : '',
      PIRC_MEMORY_ACTIVE_OBSERVATION_ID: observationalMemoryMode ? activeObservationId : '',
      PIRC_MEMORY_DROPPED_OBSERVATION_ID: observationalMemoryMode ? droppedObservationId : '',
      PIRC_MEMORY_REFLECTION_IDS: observationalMemoryMode ? reflectionIds.join(',') : '',
      PIRC_FILES_CLIPBOARD_BASE64: Buffer.from(filesClipboard).toString('base64'),
      PIRC_GIT_SESSION: gitMode ? filesSession : '',
      PIRC_PROJECT_TRUST_WORKSPACE: projectTrustMode ? 'git:fixture' : '',
      PIRC_TERMINAL_SESSION: terminalMode ? filesSession : '',
      PIRC_BROWSER_SESSION: browserMode ? filesSession : '',
      PIRC_BROWSER_URL: browserMode ? 'http://localhost:18896/' : '',
      PIRC_HTML_MEDIA: htmlMediaMode,
      PIRC_HTML_MEDIA_ORIGIN: htmlMediaMode ? origin : '',
      PIRC_PAIR_LINK: `pirc://pair?${new URLSearchParams({ url: origin, token: paired.token })}`,
    }),
    { mode: 0o600 },
  );
  chmodSync(defines, 0o600);
  writeFileSync(
    path.join(publicRoot, 'runtime.json'),
    JSON.stringify({
      pid: process.pid,
      pids: children.map((child) => child.pid),
      services: children.map((child) => ({
        name: child.name,
        pid: child.pid,
        executable: child.executable,
        args: child.args,
      })),
      origin,
      gateway,
      stateRoot: root,
      filesSession,
    }),
    { mode: 0o600 },
  );
  console.log(
    `Native integration ready at ${origin}\nPrivate Dart defines: ${defines}\nRust gateway/node are real; model and sandbox wrapper are fixtures. Ctrl+C revokes the test device and stops services.`,
  );
  await new Promise(() => {});
} catch (error) {
  await stop();
  throw error;
}
