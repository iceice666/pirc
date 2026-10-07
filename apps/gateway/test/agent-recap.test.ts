import { describe, expect, it } from 'bun:test';
import type { Agent } from '../src/agent/agent.js';
import {
  parseRecapArgs,
  recapCurrentContext,
  recapFeature,
  RECAP_SYSTEM_PROMPT,
} from '../src/agent/features/recap.js';
import type { RecapEvidence } from '../src/node/recap.js';

function evidence(): RecapEvidence {
  return {
    version: 1,
    scope: { workspaceId: 'workspace-1', days: 14, since: 10, until: 20 },
    sampling: 'Most recent 20 eligible sessions; bounded sample.',
    sessions: [
      {
        sessionId: 'session-source',
        truncated: false,
        evidence: [
          {
            entryId: 'entry-source',
            timestamp: 15,
            role: 'user',
            text: 'PRIVATE_HISTORY_SENTINEL: please run tests',
          },
        ],
      },
    ],
    skipped: [{ sessionId: 'skipped-source', reason: 'recap_marked_session' }],
    truncated: true,
    scannedBytes: 100,
  };
}

function fixture(
  options: {
    data?: RecapEvidence;
    stop?: string;
    text?: string;
    error?: boolean;
    gateway?: boolean;
    pending?: boolean;
  } = {},
) {
  const reports: any[] = [];
  const notifications: string[] = [];
  const entries: any[] = [];
  const requests: any[] = [];
  const collects: any[] = [];
  const statuses: any[] = [];
  const completionStates: string[][] = [];
  const agent = {
    hasUI: true,
    completionChanged: () => completionStates.push(feature.completionBlockers!(agent)),
    config: { workspaceKind: 'directory' },
    modelRef: { provider: 'test', id: 'model' },
    store: { sessionId: 'current', append: (entry: any) => entries.push(entry) },
    ui: {
      notify: (text: string) => notifications.push(text),
      setStatus: (...args: any[]) => statuses.push(args),
    },
    appendMessage: (...args: any[]) => reports.push(args),
    deliver: () => {
      throw new Error('Reports must not enter the run queue');
    },
    resolveModel: () => ({
      providerName: 'test',
      provider: { apiKey: 'secret-provider-key' },
      model: { maxTokens: 8000 },
    }),
    streamFunction: () => async (request: any) => {
      requests.push(request);
      if (options.pending)
        await new Promise((_, reject) =>
          request.signal.addEventListener('abort', () => reject(new Error('sensitive error'))),
        );
      if (options.error) throw new Error('PRIVATE_HISTORY_SENTINEL secret-provider-key');
      return {
        stopReason: options.stop ?? 'stop',
        content: [
          {
            type: 'text',
            text: options.text ?? 'Review test coverage [session-source / entry-source].',
          },
        ],
      };
    },
  } as unknown as Agent;
  const feature = recapFeature({
    gateway: () =>
      options.gateway === false
        ? undefined
        : {
            request: async (...args: any[]) => {
              collects.push(args);
              return options.data ?? evidence();
            },
          },
    currentContext: () => 'Safe current config',
  });
  feature.init!(agent);
  const run = (args = '') => feature.commands!.recap!.run(agent, args);
  return {
    agent,
    feature,
    run,
    reports,
    notifications,
    entries,
    requests,
    collects,
    statuses,
    completionStates,
  };
}

describe('recap command', () => {
  it('parses defaults, bounded days and focus without inventing date ranges', () => {
    expect(parseRecapArgs('')).toEqual({ days: 14, focus: '' });
    expect(parseRecapArgs('最近兩週')).toEqual({ days: 14, focus: '' });
    expect(parseRecapArgs('7 testing')).toEqual({ days: 7, focus: 'testing' });
    expect(parseRecapArgs('--days 90 repeated corrections')).toEqual({
      days: 90,
      focus: 'repeated corrections',
    });
    expect(parseRecapArgs('測試流程')).toEqual({ days: 14, focus: '測試流程' });
    for (const input of ['0', '91', '-1', '1.5', '--days nope'])
      expect(() => parseRecapArgs(input)).toThrow();
  });

  it('is unavailable in chats, headless sessions and standalone sessions, and registers no tools', () => {
    for (const kind of ['chat', 'headless', 'standalone']) {
      const f = fixture({ gateway: kind !== 'standalone' });
      if (kind === 'chat') f.agent.config.workspaceKind = 'chat';
      if (kind === 'headless') Object.defineProperty(f.agent, 'hasUI', { value: false });
      expect(f.feature.commands).toEqual({});
      expect(f.feature.tools).toBeUndefined();
    }
  });

  it('keeps raw evidence transient and records only a marker plus a redacted final report', async () => {
    const f = fixture({
      text: 'Recommendation [session-source / entry-source]. sk-abcdefghijklmnopqrstuvwxyz1234',
    });
    await f.run('7 test focus');
    expect(f.collects[0][0]).toBe('recap.collect');
    expect(f.collects[0][1]).toEqual({ days: 7 });
    expect(f.entries).toEqual([{ type: 'custom', customType: 'recap.run', data: { days: 7 } }]);
    expect(f.requests[0]).toMatchObject({
      tools: [],
      thinking: 'off',
      maxTokens: 4096,
      sessionId: 'current-recap',
    });
    expect(f.requests[0].messages[0].content).toContain('PRIVATE_HISTORY_SENTINEL');
    expect(f.reports).toHaveLength(1);
    expect(f.reports[0]).toHaveLength(1); // no triggerTurn
    expect(f.reports[0][0]).toMatchObject({ customType: 'recap.report', display: true });
    const report = f.reports[0][0].content;
    expect(report).toContain('workspace-1');
    expect(report).toContain('recap_marked_session');
    expect(report).toContain('Limitations:');
    expect(report).toContain('Truncated: yes');
    expect(report).not.toContain('PRIVATE_HISTORY_SENTINEL');
    expect(report).not.toContain('abcdefghijklmnopqrstuvwxyz1234');
    expect(f.feature.completionBlockers!(f.agent)).toEqual([]);
  });

  it('appends reports directly even when a normal run starts during collection', async () => {
    const f = fixture();
    const running = f.run();
    Object.defineProperty(f.agent, 'isRunning', { value: true });
    await running;
    expect(f.reports).toHaveLength(1);
    expect(f.reports[0][0].role).toBe('custom');
    expect(f.statuses[0]).toEqual(['recap', 'Reviewing recent workspace sessions…']);
    expect(f.statuses.at(-1)).toEqual(['recap', undefined]);
    expect(f.completionStates).toEqual([['Recap is running.'], []]);
  });

  it('makes no paid request without history', async () => {
    const data = evidence();
    data.sessions = [];
    const f = fixture({ data });
    await f.run();
    expect(f.requests).toHaveLength(0);
    expect(f.reports[0][0].content).toContain('no model request');
  });

  it('rejects provider failures and incomplete or tool-call responses without raw errors', async () => {
    for (const stop of ['error', 'aborted', 'length', 'toolUse', 'tool_calls']) {
      const f = fixture({ stop });
      await f.run();
      expect(f.reports).toHaveLength(0);
      expect(f.notifications.join()).toContain('Recap failed');
    }
    const f = fixture({ error: true });
    await f.run();
    expect(f.notifications.join()).not.toContain('PRIVATE_HISTORY');
    expect(f.notifications.join()).not.toContain('secret-provider-key');
    expect(f.reports).toHaveLength(0);
  });

  it('guards inflight requests and aborts both cancellation and shutdown', async () => {
    for (const hook of ['abort', 'shutdown'] as const) {
      const f = fixture({ pending: true });
      const running = f.run();
      await Bun.sleep(0);
      expect(f.feature.completionBlockers!(f.agent)).toHaveLength(1);
      await f.run();
      expect(f.requests).toHaveLength(1);
      f.feature[hook]!(f.agent);
      await running;
      expect(f.reports).toHaveLength(0);
      expect(f.notifications.join()).toContain('cancelled');
      expect(f.feature.completionBlockers!(f.agent)).toEqual([]);
    }
  });

  it('uses explicit safe config fields, bounded context and untrusted-data instructions', () => {
    const agent = {
      config: {
        workspace: '/nonexistent-recap-test',
        configDir: '/nonexistent-recap-test',
        roleDirs: [],
        systemPrompt: [
          { id: 'agents:workspace', title: 'Rules', text: 'x'.repeat(30_000) },
          { id: 'private', text: 'HIDDEN_SYSTEM_SENTINEL' },
        ],
        features: { skills: { enabled: false, secret: 'FEATURE_SECRET_SENTINEL' } },
        providers: { secret: 'PROVIDER_SECRET_SENTINEL' },
        env: { TOKEN: 'ENV_SECRET_SENTINEL' },
      },
      modelRef: { provider: 'test', id: 'model' },
      thinking: 'medium',
    } as unknown as Agent;
    const context = recapCurrentContext(agent);
    expect(context.length).toBeLessThanOrEqual(20_000);
    for (const secret of [
      'FEATURE_SECRET_SENTINEL',
      'PROVIDER_SECRET_SENTINEL',
      'ENV_SECRET_SENTINEL',
      'HIDDEN_SYSTEM_SENTINEL',
    ])
      expect(context).not.toContain(secret);
    expect(context).toContain('"skills":false');
    expect(RECAP_SYSTEM_PROMPT).toContain('UNTRUSTED DATA');
    expect(RECAP_SYSTEM_PROMPT).toContain('zero is valid');
  });
});
