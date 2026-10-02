/**
 * Which hosts the agent's browser may reach (audit M8). Chromium runs on the
 * node outside the OS sandbox, so without this check an agent could drive it
 * into the gateway's own UI and API, cloud metadata (169.254.169.254), the
 * node's loopback services and the LAN. Before every navigation, and for every
 * request and WebSocket the pages make (redirects included), the host is
 * resolved and refused when it names or resolves to a loopback, private,
 * carrier-grade NAT, link-local, unique-local, multicast or otherwise
 * non-public address, a `localhost` / `.local` / `.internal` / `.home.arpa`
 * name, or the gateway this node connects to — unless the node allows it
 * (`PIRC_BROWSER_ALLOW_PRIVATE`).
 *
 * Limitation: Chromium resolves names again on its own, so a DNS-rebinding
 * host could still answer a private address after passing this check. The
 * short cache below narrows, but does not close, that window.
 */
import { lookup } from 'node:dns/promises';
import { ApiError } from '../errors.js';

/** Why an IP address is not public, or null when it is. */
export function privateAddressKind(address: string): string | null {
  const v4 = parseIPv4(address);
  if (v4 !== null) return ipv4Kind(v4);
  const v6 = parseIPv6(address);
  if (v6 === null) return null;
  return ipv6Kind(v6);
}

function parseIPv4(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    value = value * 256 + byte;
  }
  return value;
}

const V4_RANGES: Array<[string, number, string]> = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'reserved'],
  ['192.0.2.0', 24, 'reserved'],
  ['192.88.99.0', 24, 'reserved'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'reserved'],
  ['198.51.100.0', 24, 'reserved'],
  ['203.0.113.0', 24, 'reserved'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];
const V4_PARSED = V4_RANGES.map(([base, bits, kind]) => ({
  base: parseIPv4(base)!,
  bits,
  kind,
}));

const inV4 = (address: number, base: number, bits: number) =>
  bits === 0 || Math.floor(address / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits));

function ipv4Kind(address: number): string | null {
  for (const range of V4_PARSED) if (inV4(address, range.base, range.bits)) return range.kind;
  return null;
}

/** Eight 16-bit groups, or null. Accepts `::`, embedded dotted IPv4, brackets and zone ids. */
function parseIPv6(text: string): number[] | null {
  let raw = text.trim();
  if (raw.startsWith('[') && raw.endsWith(']')) raw = raw.slice(1, -1);
  raw = raw.replace(/%.*$/, '');
  if (!raw.includes(':')) return null;
  let tail: number[] = [];
  const lastColon = raw.lastIndexOf(':');
  const last = raw.slice(lastColon + 1);
  if (last.includes('.')) {
    const v4 = parseIPv4(last);
    if (v4 === null) return null;
    tail = [Math.floor(v4 / 65536), v4 % 65536];
    // `::ffff:1.2.3.4` → `::ffff` + two groups; `::1.2.3.4` → `::` + two groups.
    raw = raw.slice(0, lastColon);
    if (raw.endsWith(':')) raw += ':';
  }
  const halves = raw.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  const parse = (items: string[]) =>
    items.map((item) => (/^[0-9a-f]{1,4}$/i.test(item) ? parseInt(item, 16) : NaN));
  const a = parse(head);
  const b = [...parse(rest), ...tail];
  if ([...a, ...b].some(Number.isNaN)) return null;
  const missing = 8 - a.length - b.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  return [...a, ...Array<number>(Math.max(0, missing)).fill(0), ...b];
}

function ipv6Kind(g: number[]): string | null {
  const embedded = (hi: number, lo: number) => ipv4Kind(hi * 65536 + lo);
  if (g.every((x) => x === 0)) return 'unspecified';
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback';
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): the IPv4 rules apply.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0))
    return embedded(g[6]!, g[7]!) ?? (g[5] === 0 ? 'reserved' : null);
  // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) carry an IPv4 address too.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))
    return embedded(g[6]!, g[7]!);
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!);
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return 'unique-local';
  if ((first & 0xffc0) === 0xfe80) return 'link-local';
  if ((first & 0xffc0) === 0xfec0) return 'site-local';
  if ((first & 0xff00) === 0xff00) return 'multicast';
  if (first === 0x2001 && g[1] === 0x0db8) return 'reserved';
  return null;
}

/** Host names that only ever mean something on this machine or network. */
export function localNameKind(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  for (const suffix of ['.local', '.internal', '.home.arpa', '.lan', '.intranet', '.corp'])
    if (host.endsWith(suffix) || host === suffix.slice(1)) return 'local network';
  return null;
}

interface AllowRule {
  match(host: string, addresses: string[]): boolean;
}

function cidr(text: string): AllowRule | null {
  const [base, bitsText] = text.split('/');
  if (!base) return null;
  const v4 = parseIPv4(base);
  if (v4 !== null) {
    const bits = bitsText === undefined ? 32 : Number(bitsText);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
    return {
      match: (_host, addresses) =>
        addresses.length > 0 &&
        addresses.every((address) => {
          const value = parseIPv4(address) ?? mappedV4(address);
          return value !== null && inV4(value, v4, bits);
        }),
    };
  }
  const v6 = parseIPv6(base);
  if (v6 !== null) {
    const bits = bitsText === undefined ? 128 : Number(bitsText);
    if (!Number.isInteger(bits) || bits < 0 || bits > 128) return null;
    return {
      match: (_host, addresses) =>
        addresses.length > 0 &&
        addresses.every((address) => {
          const value = parseIPv6(address);
          return value !== null && prefixEqual(value, v6, bits);
        }),
    };
  }
  return null;
}

function mappedV4(address: string): number | null {
  const g = parseIPv6(address);
  if (!g || !g.slice(0, 5).every((x) => x === 0) || g[5] !== 0xffff) return null;
  return g[6]! * 65536 + g[7]!;
}

function prefixEqual(a: number[], b: number[], bits: number): boolean {
  for (let i = 0; i < 8 && bits > 0; i++, bits -= 16) {
    const mask = bits >= 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
    if ((a[i]! & mask) !== (b[i]! & mask)) return false;
  }
  return true;
}

/**
 * `PIRC_BROWSER_ALLOW_PRIVATE` entries: `*` (no private-address check at
 * all), an exact host name (`nas.lan`), a `*.suffix` wildcard, an IP address
 * or a CIDR range (`192.168.1.0/24`, `fd00::/8`). Ports are ignored.
 */
export function parseAllowRules(entries: readonly string[]): {
  any: boolean;
  rules: AllowRule[];
} {
  let any = false;
  const rules: AllowRule[] = [];
  for (const raw of entries) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') {
      any = true;
      continue;
    }
    const range = cidr(entry.replace(/^\[|\]$/g, ''));
    if (range) {
      rules.push(range);
      // An IP literal may also appear as the URL host itself.
      if (!entry.includes('/'))
        rules.push({ match: (host) => normalizeHost(host) === normalizeHost(entry) });
      continue;
    }
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1);
      rules.push({ match: (host) => normalizeHost(host).endsWith(suffix) });
    } else rules.push({ match: (host) => normalizeHost(host) === entry });
  }
  return { any, rules };
}

const normalizeHost = (host: string) =>
  host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

const CACHE_MS = 30_000;
const CACHE_MAX = 1_000;

export interface BrowserHostPolicy {
  /** `PIRC_BROWSER_ALLOW_PRIVATE` entries (see parseAllowRules). */
  allowPrivateHosts?: readonly string[] | undefined;
  /** The gateway this node connects to: refused even if public. */
  gatewayHost?: string | undefined;
  /** Further names of the gateway (its public host names, PIRC_BROWSER_BLOCK_HOSTS). */
  blockedHosts?: readonly string[] | undefined;
}

/** Decides, with a short cache, whether the browser may contact a URL's host. */
export class BrowserHostGuard {
  private readonly allow: ReturnType<typeof parseAllowRules>;
  private readonly gateway: Set<string>;
  private readonly cache = new Map<string, { until: number; reason: string | null }>();

  constructor(
    policy: BrowserHostPolicy,
    private readonly resolve: Resolver = defaultResolver,
  ) {
    this.allow = parseAllowRules(policy.allowPrivateHosts ?? []);
    this.gateway = new Set(
      [policy.gatewayHost, ...(policy.blockedHosts ?? [])]
        .filter((host): host is string => Boolean(host?.trim()))
        // Entries may carry a port (`Host` values); ports are ignored.
        .map((host) => normalizeHost(host.trim().replace(/:\d+$/, ''))),
    );
  }

  /** Why the URL's host is refused, or null when the browser may contact it. */
  async blockedReason(rawUrl: string): Promise<string | null> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return 'not a valid URL';
    }
    // Only network schemes reach a host; data:, blob:, about: never do.
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return null;
    const host = normalizeHost(url.hostname);
    const cached = this.cache.get(host);
    if (cached && cached.until > Date.now()) return cached.reason;
    const reason = await this.decide(host);
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(host, { until: Date.now() + CACHE_MS, reason });
    return reason;
  }

  /** Throws a clear, agent-facing error when the URL is refused. */
  async check(rawUrl: string): Promise<void> {
    const reason = await this.blockedReason(rawUrl);
    if (reason) throw blockedError(rawUrl, reason);
  }

  private async decide(host: string): Promise<string | null> {
    const explicit = (addresses: string[]) =>
      this.allow.rules.some((rule) => rule.match(host, addresses));
    if (this.gateway.has(host))
      return explicit([]) ? null : 'it is the pirc gateway this node connects to';
    if (!host) return 'it has no host';
    const literal = privateAddressKind(host);
    let addresses: string[];
    if (parseIPv4(host) !== null || parseIPv6(host) !== null) addresses = [host];
    else {
      const name = localNameKind(host);
      if (name) return this.allow.any || explicit([]) ? null : `${host} is a ${name} name`;
      try {
        addresses = await this.resolve(host);
      } catch {
        return `${host} could not be resolved`;
      }
      if (!addresses.length) return `${host} could not be resolved`;
    }
    if (this.allow.any || explicit(addresses)) return null;
    if (literal) return `${host} is a ${literal} address`;
    for (const address of addresses) {
      const kind = privateAddressKind(address);
      if (kind) return `${host} resolves to a ${kind} address (${address})`;
    }
    return null;
  }
}

export function blockedError(url: string, reason: string): ApiError {
  return new ApiError(
    403,
    'forbidden',
    `The browser may not open ${url.slice(0, 200)}: ${reason}. Agent browsing is limited to public ` +
      'internet hosts; local, private and the pirc gateway itself are blocked unless the node ' +
      'operator allows them (PIRC_BROWSER_ALLOW_PRIVATE).',
  );
}
