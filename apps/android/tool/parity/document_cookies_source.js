/* Synchronous document.cookie view. Native code independently validates each write. */
function createPircDocumentCookies(options) {
  'use strict';
  const StringValue = String, DateValue = Date;
  const now = Date.now.bind(Date);
  const URLValue = pircUrlPolyfill.URL;
  let seed = null, cookies = [], protections = [], writes = [], serial = 0;
  let documentCookieUrl = null;
  const fail = message => {
    options.diagnostic('cookies.state_unavailable', 'error', message);
    throw new TypeError(message);
  };
  const url = () => {
    try { return new URLValue(options.getUrl()); } catch (_) { return null; }
  };
  const trim = value => value.replace(/^[\t ]+|[\t ]+$/g, '');
  const pathMatches = (path, cookiePath) => path === cookiePath ||
    (path.startsWith(cookiePath) && (cookiePath.endsWith('/') || path[cookiePath.length] === '/'));
  const domainMatches = (host, cookie) => host === cookie.domain ||
    (!cookie.hostOnly && host.endsWith('.' + cookie.domain));
  const keyMatches = (a, b) => a.name === b.name && a.domain === b.domain &&
    a.path === b.path && a.hostOnly === b.hostOnly;
  const live = cookie => cookie.expiresAt == null || cookie.expiresAt > now();
  function sync(input) {
    if (writes.length) fail('Pending cookie writes must be flushed before synchronizing.');
    if (!input || !Number.isSafeInteger(input.generation) ||
        !Array.isArray(input.cookies) || !Array.isArray(input.protections)) {
      seed = null; cookies = []; protections = [];
      return;
    }
    if (input.truncated || input.error) fail('Native cookie state exceeds its supported message limit.');
    if (input.cookies.length > 3000 || input.protections.length > 3000)
      fail('Invalid native cookie state.');
    let inputUrl;
    try { inputUrl = new URLValue(input.url); } catch (_) { fail('Invalid native cookie state.'); }
    if (documentCookieUrl == null) documentCookieUrl = inputUrl.href;
    else {
      let initialUrl;
      try { initialUrl = new URLValue(documentCookieUrl); } catch (_) { fail('Invalid native cookie state.'); }
      if (inputUrl.origin !== initialUrl.origin) fail('Cookie document origin changed.');
    }
    // Cookie getter/setter path scope remains anchored to the URL that created
    // this Document, even when history.pushState changes the active location.
    seed = { ...input, url: documentCookieUrl };
    cookies = input.cookies.map(cookie => ({ ...cookie }));
    protections = input.protections.map(cookie => ({ ...cookie }));
    serial = cookies.reduce((value, cookie) => Math.max(value, cookie.creationOrder || 0), 0) + 1;
  }
  function requireState() {
    if (!seed) fail('Cookies require native document cookie support.');
    const current = url();
    if (!current || !['http:', 'https:'].includes(current.protocol)) return null;
    const initial = new URLValue(documentCookieUrl || seed.url);
    if (current.origin !== initial.origin) fail('Cookie document origin changed.');
    return initial;
  }
  function read() {
    const current = requireState();
    if (!current) return '';
    cookies = cookies.filter(live);
    return cookies.filter(cookie => domainMatches(current.hostname, cookie) &&
      pathMatches(current.pathname, cookie.path) && (!cookie.secure || seed.secureOrigin) &&
      (seed.sameSiteContext || cookie.sameSite === 'none'))
      .sort((a, b) => b.path.length - a.path.length || a.creationOrder - b.creationOrder)
      .map(cookie => cookie.name + '=' + cookie.value).join('; ');
  }
  function write(value) {
    const line = StringValue(value), current = requireState();
    if (!current) return;
    if (options.utf8ByteLength(line) > 4096) return;
    if (writes.length >= 128) fail('Too many cookie assignments in one script turn (maximum 128).');
    // Send the original assignment, including invalid syntax, for independent
    // native validation. It never becomes an arbitrary HTTP request header.
    writes.push({ url: current.href, line, generation: seed.generation });
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(line)) return;
    const parts = line.split(';'), pair = parts.shift(), equals = pair.indexOf('=');
    if (equals < 0) return;
    const name = trim(pair.slice(0, equals)), cookieValue = trim(pair.slice(equals + 1));
    if (!name || /[^\x20-\x7e]/.test(name + cookieValue)) return;
    const candidate = {
      name, value: cookieValue, domain: current.hostname, hostOnly: true,
      path: current.pathname.lastIndexOf('/') <= 0 ? '/' : current.pathname.slice(0, current.pathname.lastIndexOf('/')),
      secure: false, sameSite: 'default', expiresAt: null,
      createdAt: now(), creationOrder: serial++
    };
    let domainAttribute = false, pathAttribute = false, maxAge = null, expires = null;
    for (const part of parts) {
      const at = part.indexOf('='), attribute = trim(at < 0 ? part : part.slice(0, at)).toLowerCase();
      const attributeValue = at < 0 ? '' : trim(part.slice(at + 1));
      if (attribute === 'httponly' || attribute === 'partitioned') return;
      if (attribute === 'secure') candidate.secure = true;
      if (attribute === 'domain' && attributeValue) {
        let domain = attributeValue.replace(/^\./, '').toLowerCase();
        try { domain = new URLValue('http://' + domain + '/').hostname; } catch (_) { return; }
        if (!(seed.allowedDomainSuffixes || []).includes(domain)) return;
        candidate.domain = domain; candidate.hostOnly = false; domainAttribute = true;
      }
      if (attribute === 'path' && attributeValue.startsWith('/')) {
        candidate.path = attributeValue; pathAttribute = true;
      }
      if (attribute === 'samesite') candidate.sameSite = ['strict', 'lax', 'none'].includes(attributeValue.toLowerCase()) ? attributeValue.toLowerCase() : 'default';
      if (attribute === 'max-age' && /^-?\d+$/.test(attributeValue)) maxAge = Number(attributeValue);
      if (attribute === 'expires') {
        const parsed = DateValue.parse(attributeValue);
        if (Number.isFinite(parsed)) expires = parsed;
      }
    }
    if ((candidate.secure && !seed.secureOrigin) || (candidate.sameSite === 'none' && !candidate.secure) ||
        (!seed.sameSiteContext && candidate.sameSite !== 'none')) return;
    const lowerName = name.toLowerCase();
    if (lowerName.startsWith('__secure-') && (!candidate.secure || !seed.secureOrigin)) return;
    if (lowerName.startsWith('__host-') && (!candidate.secure || !seed.secureOrigin || domainAttribute || !pathAttribute || candidate.path !== '/')) return;
    if (lowerName.startsWith('__http-') || lowerName.startsWith('__host-http-')) return;
    cookies = cookies.filter(live);
    if (protections.some(cookie => cookie.httpOnly && keyMatches(cookie, candidate))) return;
    if (!seed.secureOrigin && protections.some(cookie => cookie.secure && cookie.name === candidate.name &&
        (domainMatches(candidate.domain, cookie) || domainMatches(cookie.domain, candidate)) && pathMatches(candidate.path, cookie.path))) return;
    candidate.expiresAt = maxAge == null ? expires : maxAge <= 0 ? 0 :
      Math.min(now() + maxAge * 1000, now() + 400 * 24 * 60 * 60 * 1000);
    const previous = cookies.find(cookie => keyMatches(cookie, candidate));
    if (previous) {
      candidate.createdAt = previous.createdAt;
      candidate.creationOrder = previous.creationOrder;
    }
    cookies = cookies.filter(cookie => !keyMatches(cookie, candidate));
    if (live(candidate)) cookies.push(candidate);
  }
  return Object.freeze({
    sync,
    drain: () => writes.splice(0),
    install(document, initial) {
      sync(initial);
      Object.defineProperty(document, 'cookie', { get: read, set: write, configurable: false, enumerable: false });
    }
  });
}
