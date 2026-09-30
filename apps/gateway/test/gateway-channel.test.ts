import { describe, expect, it } from 'bun:test';
import { GatewayError, NodeGateway, processGateway } from '../src/agent/gateway.js';
import { DaemonAgentGateway, offlineGateway } from '../src/node/agent-gateway.js';
import { withoutSecrets } from '../src/node/secrets.js';
import type { NodeToDaemon } from '../src/protocol.js';

describe('agent gateway client', () => {
  it('sends requests and settles them from the node answers', async () => {
    const lines: any[] = [];
    const gateway = new NodeGateway((value) => lines.push(value));
    const ok = gateway.request('assistant.context', { a: 1 });
    const failed = gateway.request('nope.op');
    expect(lines.map((line) => [line.type, line.op, line.args])).toEqual([
      ['gateway_request', 'assistant.context', { a: 1 }],
      ['gateway_request', 'nope.op', {}],
    ]);
    gateway.respond({ id: 'someone-else', ok: true, result: 1 });
    gateway.respond({ id: lines[0].id, ok: true, result: { enabled: false } });
    gateway.respond({
      id: lines[1].id,
      ok: false,
      error: {
        status: 404,
        code: 'unknown_operation',
        message: 'Unknown gateway operation: nope.op',
      },
    });
    expect(await ok).toEqual({ enabled: false });
    const error = (await failed.catch((reason: unknown) => reason)) as GatewayError;
    expect(error).toBeInstanceOf(GatewayError);
    expect([error.code, error.status, error.message]).toEqual([
      'unknown_operation',
      404,
      'Unknown gateway operation: nope.op',
    ]);
  });

  it('gives up on aborts, lost replies and shutdown', async () => {
    const quick = new NodeGateway(() => {}, 20);
    const controller = new AbortController();
    const aborted = quick.request('a.b', {}, controller.signal).catch((e: Error) => e.message);
    controller.abort();
    expect(await aborted).toBe('Aborted');
    expect(await quick.request('a.b').catch((e: GatewayError) => e.code)).toBe('gateway_timeout');
    const slow = new NodeGateway(() => {}, 60_000);
    const pending = slow.request('a.b').catch((e: GatewayError) => e.code);
    slow.closeAll();
    expect(await pending).toBe('gateway_closed');
  });

  it('exists only for the main agent of a node', () => {
    const saved = { gateway: process.env.PIRC_GATEWAY, team: process.env.PIRC_TEAM_AGENT };
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    try {
      delete process.env.PIRC_TEAM_AGENT;
      process.env.PIRC_GATEWAY = '1';
      expect(processGateway()).toBeDefined();
      process.env.PIRC_TEAM_AGENT = 'worker';
      expect(processGateway()).toBeUndefined();
      delete process.env.PIRC_TEAM_AGENT;
      delete process.env.PIRC_GATEWAY;
      expect(processGateway()).toBeUndefined();
    } finally {
      restore('PIRC_GATEWAY', saved.gateway);
      restore('PIRC_TEAM_AGENT', saved.team);
    }
  });
});

describe('node gateway link', () => {
  it('answers offline until connected, then correlates the daemon answers', async () => {
    expect(await offlineGateway.request('s', 'a.b', {})).toMatchObject({
      status: 503,
      body: { error: { code: 'gateway_offline' } },
    });
    const link = new DaemonAgentGateway(60_000);
    expect((await link.request('s', 'a.b', {})).status).toBe(503);
    const frames: NodeToDaemon[] = [];
    link.connect((frame) => (frames.push(frame), true));
    const answer = link.request('session-1', 'assistant.context', { x: 1 });
    const frame = frames[0] as Extract<NodeToDaemon, { type: 'agent_request' }>;
    expect([frame.type, frame.sessionId, frame.op, frame.args]).toEqual([
      'agent_request',
      'session-1',
      'assistant.context',
      { x: 1 },
    ]);
    link.receive({ requestId: 'someone-else', status: 200, body: {} });
    link.receive({ requestId: frame.requestId, status: 200, body: { result: { enabled: false } } });
    expect(await answer).toEqual({ status: 200, body: { result: { enabled: false } } });
  });

  it('always answers: timeouts, dropped links, unsendable frames and floods', async () => {
    const quick = new DaemonAgentGateway(20);
    quick.connect(() => true);
    expect((await quick.request('s', 'a.b', {})).body).toMatchObject({
      error: { code: 'gateway_timeout' },
    });
    const link = new DaemonAgentGateway(60_000, 2);
    link.connect(() => true);
    const waiting = [link.request('s', 'a.b', {}), link.request('s', 'a.b', {})];
    expect((await link.request('s', 'a.b', {})).status).toBe(429);
    link.disconnect();
    expect((await Promise.all(waiting)).map((answer) => answer.status)).toEqual([503, 503]);
    link.connect(() => false);
    expect((await link.request('s', 'a.b', {})).status).toBe(503);
  });
});

describe('agent environment', () => {
  it('drops the node secrets and keeps everything else', () => {
    expect(
      withoutSecrets({
        PIRC_NODE_TOKEN: 'a',
        PIRC_NODE_TOKENS: '{}',
        PIRC_OAUTH_SECRET_KEY: 'b',
        PIRC_CLIPROXYAPI_KEY: 'provider key in a shared environment file',
        PIRC_VAPID_PRIVATE_KEY: 'c',
        EXA_API_KEY: 'd',
        PIRC_NODE_ID: 'n',
        PIRC_WORKSPACE_KIND: 'directory',
        HOME: '/home/u',
        GITHUB_TOKEN: 'user tools may need their own tokens',
      }),
    ).toEqual({
      PIRC_NODE_ID: 'n',
      PIRC_WORKSPACE_KIND: 'directory',
      HOME: '/home/u',
      GITHUB_TOKEN: 'user tools may need their own tokens',
    });
  });
});
