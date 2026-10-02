import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyRequest } from 'fastify';
import { loadDaemonConfig, type BrowserAuthConfig } from '../src/config.js';
import { PROXY_SECRET_HEADER, proxySecretMatches, validateRequest } from '../src/daemon/auth.js';

const SECRET = 's'.repeat(40);
const stateDir = mkdtempSync(path.join(tmpdir(), 'pirc-auth-test-'));
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));
const config: BrowserAuthConfig = {
  trustedProxies: new Set(['127.0.0.1']),
  allowedUsers: new Set(['alice@example.com']),
  allowedOrigins: new Set(['https://pirc.example']),
  allowedHosts: new Set(['pirc.example']),
  identityHeader: 'x-pirc-user',
};
const devices = {
  authenticate: () => {
    throw new Error('no device tokens in these tests');
  },
};

function request(headers: Record<string, string>, remoteAddress = '127.0.0.1') {
  return {
    socket: { remoteAddress },
    headers: { host: 'pirc.example', 'x-pirc-user': 'alice@example.com', ...headers },
    url: '/api/sessions',
    routeOptions: { url: '/api/sessions' },
    method: 'GET',
  } as unknown as FastifyRequest;
}

describe('trusted proxy shared secret (PIRC_PROXY_SECRET)', () => {
  it('compares in constant time, whatever the lengths', () => {
    expect(proxySecretMatches(SECRET, SECRET)).toBe(true);
    expect(proxySecretMatches(`${SECRET}x`, SECRET)).toBe(false);
    expect(proxySecretMatches('short', SECRET)).toBe(false);
    expect(proxySecretMatches(undefined, SECRET)).toBe(false);
    expect(proxySecretMatches([SECRET, SECRET], SECRET)).toBe(false);
  });

  it('accepts the proxy only with the secret header', () => {
    const withSecret = { ...config, proxySecret: SECRET };
    const ok = request({ [PROXY_SECRET_HEADER]: SECRET });
    validateRequest(ok, withSecret, devices);
    expect(ok.identity).toEqual({ user: 'alice@example.com' });
    // A local process forging the identity header from the proxy's address.
    for (const forged of [request({}), request({ [PROXY_SECRET_HEADER]: 'guess' })])
      expect(() => validateRequest(forged, withSecret, devices)).toThrow(
        'Request did not arrive from a trusted proxy',
      );
    // The secret does not make an untrusted address trusted.
    expect(() =>
      validateRequest(request({ [PROXY_SECRET_HEADER]: SECRET }, '10.0.0.9'), withSecret, devices),
    ).toThrow('trusted proxy');
  });

  it('keeps the address-only check when no secret is configured', () => {
    const plain = request({});
    validateRequest(plain, config, devices);
    expect(plain.identity).toEqual({ user: 'alice@example.com' });
  });

  it('reads PIRC_PROXY_SECRET and refuses a short one', () => {
    const env = {
      PIRC_NODE_TOKENS: JSON.stringify({ n: 'n'.repeat(32) }),
      PIRC_TRUSTED_PROXIES: '127.0.0.1',
      PIRC_ALLOWED_ORIGINS: 'https://pirc.example',
      PIRC_ALLOWED_HOSTS: 'pirc.example',
      PIRC_ALLOWED_USERS: 'alice@example.com',
      PIRC_STATE_DIR: stateDir,
    };
    expect(loadDaemonConfig(env).proxySecret).toBeUndefined();
    expect(loadDaemonConfig({ ...env, PIRC_PROXY_SECRET: ` ${SECRET} ` }).proxySecret).toBe(SECRET);
    expect(() => loadDaemonConfig({ ...env, PIRC_PROXY_SECRET: 'short' })).toThrow(
      'at least 32 characters',
    );
  });
});
