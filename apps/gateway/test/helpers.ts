import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GatewayConfig } from '../src/config.js';

export function testConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'pirc-gateway-'));
  const workspace = path.join(stateDir, 'workspace');
  mkdirSync(workspace);
  const sessionsDir = path.join(stateDir, 'sessions');
  const uploadsDir = path.join(stateDir, 'uploads');
  mkdirSync(sessionsDir);
  mkdirSync(uploadsDir);
  return {
    host: '127.0.0.1',
    port: 0,
    stateDir,
    databasePath: path.join(stateDir, 'test.sqlite'),
    sessionsDir,
    uploadsDir,
    piCommand: process.execPath,
    piArgs: [path.resolve('test/fixtures/fake-pi.mjs')],
    hostId: 'test',
    workspaces: [{ id: 'test', path: workspace, displayName: 'Test', defaults: {} }],
    trustedProxies: new Set(['127.0.0.1', '::1']),
    allowedUsers: new Set(['test@example.com']),
    allowedOrigins: new Set(['https://test.example']),
    allowedHosts: new Set(['test.example']),
    identityHeader: 'x-pirc-user',
    runnerLimit: 2,
    eventBufferSize: 20,
    rpcMaxLineBytes: 1024 * 1024,
    rpcMaxOutputBytes: 16 * 1024 * 1024,
    websocketMaxBufferedBytes: 1024 * 1024,
    uploadMaxBytes: 1024 * 1024,
    leaseTtlMs: 5000,
    interactionTtlMs: 5000,
    shutdownGraceMs: 100,
    allowDefaultWorkspace: false,
    ...overrides,
  };
}

export const headers = {
  host: 'test.example',
  origin: 'https://test.example',
  'x-pirc-user': 'test@example.com',
};
