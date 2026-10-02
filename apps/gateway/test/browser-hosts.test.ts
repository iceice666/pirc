import { describe, expect, it } from 'bun:test';
import {
  BrowserHostGuard,
  localNameKind,
  parseAllowRules,
  privateAddressKind,
} from '../src/node/browser-hosts.js';

describe('browser host classifier', () => {
  it('flags non-public IPv4 addresses', () => {
    for (const [address, kind] of [
      ['127.0.0.1', 'loopback'],
      ['127.255.0.9', 'loopback'],
      ['0.0.0.0', 'unspecified'],
      ['10.1.2.3', 'private'],
      ['172.16.0.1', 'private'],
      ['172.31.255.255', 'private'],
      ['192.168.1.1', 'private'],
      ['100.64.0.1', 'carrier-grade NAT'],
      ['100.127.255.254', 'carrier-grade NAT'],
      ['169.254.169.254', 'link-local'],
      ['224.0.0.1', 'multicast'],
      ['255.255.255.255', 'reserved'],
    ] as const)
      expect(privateAddressKind(address)).toBe(kind);
  });

  it('passes public IPv4 addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '172.15.255.255'])
      expect(privateAddressKind(address)).toBeNull();
  });

  it('flags non-public IPv6 addresses, including embedded IPv4', () => {
    for (const [address, kind] of [
      ['::1', 'loopback'],
      ['[::1]', 'loopback'],
      ['::', 'unspecified'],
      ['fd00::1', 'unique-local'],
      ['fc12:3456::9', 'unique-local'],
      ['fe80::1%en0', 'link-local'],
      ['ff02::1', 'multicast'],
      ['::ffff:127.0.0.1', 'loopback'],
      ['::ffff:7f00:1', 'loopback'],
      ['::ffff:a9fe:a9fe', 'link-local'],
      ['::ffff:192.168.0.1', 'private'],
      ['64:ff9b::a00:1', 'private'],
      ['2002:c0a8:0101::1', 'private'],
    ] as const)
      expect(privateAddressKind(address)).toBe(kind);
  });

  it('passes public IPv6 addresses', () => {
    for (const address of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8'])
      expect(privateAddressKind(address)).toBeNull();
  });

  it('flags local-only names', () => {
    expect(localNameKind('localhost')).toBe('loopback');
    expect(localNameKind('app.localhost.')).toBe('loopback');
    expect(localNameKind('printer.local')).toBe('local network');
    expect(localNameKind('metadata.google.internal')).toBe('local network');
    expect(localNameKind('router.home.arpa')).toBe('local network');
    expect(localNameKind('example.com')).toBeNull();
    expect(localNameKind('localhost.example.com')).toBeNull();
  });

  it('parses the allowlist', () => {
    expect(parseAllowRules(['*']).any).toBe(true);
    const { any, rules } = parseAllowRules(['nas.lan', '*.dev.test', '192.168.1.0/24', 'fd00::/8']);
    expect(any).toBe(false);
    const allowed = (host: string, addresses: string[]) =>
      rules.some((rule) => rule.match(host, addresses));
    expect(allowed('nas.lan', [])).toBe(true);
    expect(allowed('a.dev.test', [])).toBe(true);
    expect(allowed('x', ['192.168.1.20'])).toBe(true);
    expect(allowed('x', ['192.168.1.20', '10.0.0.1'])).toBe(false);
    expect(allowed('x', ['fd12::1'])).toBe(true);
    expect(allowed('x', ['192.168.2.1'])).toBe(false);
  });
});

describe('BrowserHostGuard', () => {
  const dns: Record<string, string[]> = {
    'example.com': ['93.184.215.14'],
    'rebind.example': ['127.0.0.1'],
    'mixed.example': ['93.184.215.14', '10.0.0.5'],
    'nas.example': ['192.168.1.10'],
    'pirc.example': ['203.0.114.7'],
  };
  const resolve = async (host: string) => {
    const addresses = dns[host];
    if (!addresses) throw new Error('ENOTFOUND');
    return addresses;
  };

  it('blocks private destinations with an agent-readable error', async () => {
    const guard = new BrowserHostGuard(
      { gatewayHost: 'pirc.example', blockedHosts: ['ui.example:8443'] },
      resolve,
    );
    expect(await guard.blockedReason('https://example.com/')).toBeNull();
    expect(await guard.blockedReason('https://UI.example:8443/')).toContain('gateway');
    expect(await guard.blockedReason('http://127.0.0.1:8787/api')).toContain('loopback');
    expect(await guard.blockedReason('http://2130706433/')).toContain('loopback');
    expect(await guard.blockedReason('http://[::1]:3000/')).toContain('loopback');
    expect(await guard.blockedReason('http://169.254.169.254/latest')).toContain('link-local');
    expect(await guard.blockedReason('http://rebind.example/')).toContain('resolves to a loopback');
    expect(await guard.blockedReason('https://mixed.example/')).toContain('private');
    expect(await guard.blockedReason('http://localhost:5173/')).toContain('loopback');
    expect(await guard.blockedReason('http://printer.local/')).toContain('local network');
    expect(await guard.blockedReason('https://pirc.example/')).toContain('gateway');
    expect(await guard.blockedReason('wss://pirc.example/node/connect')).toContain('gateway');
    expect(await guard.blockedReason('https://nowhere.example/')).toContain(
      'could not be resolved',
    );
    // Never a network host.
    expect(await guard.blockedReason('about:blank')).toBeNull();
    expect(await guard.blockedReason('data:text/html,hi')).toBeNull();
    await expect(guard.check('http://10.0.0.1/')).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
      message: expect.stringContaining('PIRC_BROWSER_ALLOW_PRIVATE'),
    });
  });

  it('honours the node allowlist, but keeps the gateway blocked under *', async () => {
    const guard = new BrowserHostGuard(
      { allowPrivateHosts: ['nas.example', '127.0.0.1', 'localhost'], gatewayHost: 'pirc.example' },
      resolve,
    );
    expect(await guard.blockedReason('http://nas.example/')).toBeNull();
    expect(await guard.blockedReason('http://127.0.0.1:3000/')).toBeNull();
    expect(await guard.blockedReason('http://localhost:3000/')).toBeNull();
    expect(await guard.blockedReason('http://10.0.0.1/')).toContain('private');
    const all = new BrowserHostGuard(
      { allowPrivateHosts: ['*'], gatewayHost: 'pirc.example' },
      resolve,
    );
    expect(await all.blockedReason('http://10.0.0.1/')).toBeNull();
    expect(await all.blockedReason('http://printer.local/')).toBeNull();
    expect(await all.blockedReason('https://pirc.example/')).toContain('gateway');
    const explicit = new BrowserHostGuard(
      { allowPrivateHosts: ['pirc.example'], gatewayHost: 'pirc.example' },
      resolve,
    );
    expect(await explicit.blockedReason('https://pirc.example/')).toBeNull();
  });
});
