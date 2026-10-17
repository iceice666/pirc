// Private browser-style import-map resolver for a single document module graph.
function createPircDocumentImportMaps(options) {
  const URLConstructor = options.URL || URL;
  const diagnostic = options.diagnostic;
  let imports = new Map();
  let scopes = new Map();
  let integrity = new Map();
  const resolved = new Map();
  const resolutions = new Map();

  function warn(message) {
    if (typeof diagnostic === 'function') diagnostic('warning', message);
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function requireObject(value, label) {
    if (!isObject(value)) throw new TypeError('Import map ' + label + ' must be a JSON object');
    return value;
  }

  function parseURL(value, base) {
    try {
      return base === undefined ? new URLConstructor(value) : new URLConstructor(value, base);
    } catch (_) {
      return null;
    }
  }

  // The HTML Standard only treats leading /, ./, ../, and absolute URLs as URL-like.
  // In particular, a bare address such as "package/path" is not relative to the map.
  function resolveURLLike(value, base) {
    const text = String(value);
    if (text.startsWith('/') || text.startsWith('./') || text.startsWith('../'))
      return parseURL(text, base);
    return parseURL(text);
  }

  function isSpecialURL(url) {
    return /^(?:ftp|file|http|https|ws|wss):$/.test(url.protocol);
  }

  function normalizeSpecifierKey(key, base) {
    if (key === '') {
      warn('Import map specifier keys cannot be empty; ignoring the empty key');
      return null;
    }
    const url = resolveURLLike(key, base);
    return url ? url.href : key;
  }

  function normalizeSpecifierMap(original, base, label) {
    requireObject(original, label);
    const normalized = new Map();
    for (const key of Object.keys(original)) {
      const normalizedKey = normalizeSpecifierKey(key, base);
      if (normalizedKey === null) continue;
      const value = original[key];
      if (typeof value !== 'string') {
        warn('Import map address for "' + key + '" must be a string; treating it as blocked');
        normalized.set(normalizedKey, null);
        continue;
      }
      const address = resolveURLLike(value, base);
      if (!address) {
        warn('Import map address for "' + key + '" is not a valid URL-like address; treating it as blocked');
        normalized.set(normalizedKey, null);
        continue;
      }
      if (normalizedKey.endsWith('/') && !address.href.endsWith('/')) {
        warn('Import map address for normalized slash-ending key "' + normalizedKey + '" must also end in a slash; treating it as blocked');
        normalized.set(normalizedKey, null);
        continue;
      }
      normalized.set(normalizedKey, address.href);
    }
    return normalized;
  }

  function normalizeIntegrityMap(original, base) {
    requireObject(original, 'integrity');
    const normalized = new Map();
    for (const [key, value] of Object.entries(original)) {
      const url = resolveURLLike(key, base);
      if (!url) {
        warn('Import map integrity key "' + key + '" is not a valid URL-like URL; ignoring the entry');
        continue;
      }
      if (typeof value !== 'string') {
        warn('Import map integrity metadata for "' + key + '" must be a string; ignoring the entry');
        continue;
      }
      normalized.set(url.href, value);
    }
    return normalized;
  }

  function normalizeScopes(original, base) {
    requireObject(original, 'scopes');
    const normalized = new Map();
    for (const [scopePrefix, specifierMap] of Object.entries(original)) {
      requireObject(specifierMap, 'scope "' + scopePrefix + '"');
      const url = parseURL(scopePrefix, base);
      if (!url) {
        warn('Import map scope prefix "' + scopePrefix + '" is not a valid URL; ignoring the scope');
        continue;
      }
      normalized.set(url.href, normalizeSpecifierMap(specifierMap, base, 'scope "' + scopePrefix + '"'));
    }
    return normalized;
  }

  function scopeApplies(scopePrefix, referrerURL) {
    return scopePrefix === referrerURL ||
      (scopePrefix.endsWith('/') && referrerURL.startsWith(scopePrefix));
  }

  function scopedRuleAffectsRecord(specifierKey, record) {
    if (specifierKey === record.specifier) return true;
    return specifierKey.endsWith('/') && record.specifier.startsWith(specifierKey) &&
      (record.asURL === null || isSpecialURL(record.asURL));
  }

  function globalRuleAffectsRecord(specifierKey, record) {
    // The current HTML Standard's global merge step prunes keys that start with
    // the already-resolved specifier; scoped maps instead prune matching prefixes.
    return specifierKey.startsWith(record.specifier);
  }

  function filterResolvedRules(newMap, scopePrefix) {
    const filtered = new Map(newMap);
    for (const [key] of filtered) {
      for (const record of resolutions.values()) {
        if (scopePrefix !== undefined && !scopeApplies(scopePrefix, record.baseURL)) continue;
        const affects = scopePrefix === undefined
          ? globalRuleAffectsRecord(key, record)
          : scopedRuleAffectsRecord(key, record);
        if (!affects) continue;
        warn('Ignoring import map rule for "' + key + '" because it would change an already-resolved module');
        filtered.delete(key);
        break;
      }
    }
    return filtered;
  }

  function mergeSpecifierMaps(newMap, oldMap, scopePrefix) {
    const filtered = filterResolvedRules(newMap, scopePrefix);
    const merged = new Map(oldMap);
    for (const [key, value] of filtered) {
      if (merged.has(key)) {
        warn('Ignoring later import map rule for "' + key + '" because the first mapping wins');
        continue;
      }
      merged.set(key, value);
    }
    return merged;
  }

  function mergeIntegrityMaps(newMap, oldMap) {
    const merged = new Map(oldMap);
    for (const [url, metadata] of newMap) {
      if (merged.has(url)) {
        warn('Ignoring later import map integrity metadata for "' + url + '" because the first mapping wins');
        continue;
      }
      merged.set(url, metadata);
    }
    return merged;
  }

  function compareCodeUnitsDescending(left, right) {
    if (left === right) return 0;
    return left < right ? 1 : -1;
  }

  function sortedEntries(map) {
    return Array.from(map.entries()).sort((left, right) => compareCodeUnitsDescending(left[0], right[0]));
  }

  function mergeImportMaps(newImports, newScopes, newIntegrity) {
    const mergedScopes = new Map(scopes);
    for (const [scopePrefix, scopeImports] of newScopes) {
      const oldScopeImports = scopes.get(scopePrefix) || new Map();
      mergedScopes.set(scopePrefix, mergeSpecifierMaps(scopeImports, oldScopeImports, scopePrefix));
    }
    const mergedImports = mergeSpecifierMaps(newImports, imports);
    const mergedIntegrity = mergeIntegrityMaps(newIntegrity, integrity);
    imports = mergedImports;
    scopes = mergedScopes;
    integrity = mergedIntegrity;
  }

  function add(sourceText, baseURL) {
    const base = parseURL(String(baseURL));
    if (!base) throw new TypeError('Import map base URL is not a valid URL');
    const parsed = JSON.parse(String(sourceText));
    requireObject(parsed, 'top-level value');

    const newImports = Object.prototype.hasOwnProperty.call(parsed, 'imports')
      ? normalizeSpecifierMap(requireObject(parsed.imports, 'imports'), base, 'imports')
      : new Map();
    const newScopes = Object.prototype.hasOwnProperty.call(parsed, 'scopes')
      ? normalizeScopes(requireObject(parsed.scopes, 'scopes'), base)
      : new Map();
    const newIntegrity = Object.prototype.hasOwnProperty.call(parsed, 'integrity')
      ? normalizeIntegrityMap(parsed.integrity, base)
      : new Map();
    for (const key of Object.keys(parsed)) {
      if (key !== 'imports' && key !== 'scopes' && key !== 'integrity')
        warn('Ignoring unrecognized import map top-level key "' + key + '"');
    }

    mergeImportMaps(newImports, newScopes, newIntegrity);
  }

  function resolveImportsMatch(normalizedSpecifier, asURL, specifierMap) {
    for (const [key, address] of sortedEntries(specifierMap)) {
      if (key === normalizedSpecifier) {
        if (address === null)
          throw new TypeError('Module specifier "' + key + '" is blocked by a null import map entry');
        return address;
      }
      if (!key.endsWith('/') || !normalizedSpecifier.startsWith(key) ||
          (asURL !== null && !isSpecialURL(asURL))) continue;
      if (address === null)
        throw new TypeError('Module specifier "' + key + '" is blocked by a null import map prefix');
      const afterPrefix = normalizedSpecifier.slice(key.length);
      const url = parseURL(afterPrefix, address);
      if (!url)
        throw new TypeError('Module specifier "' + normalizedSpecifier + '" cannot be URL-parsed after import map prefix "' + key + '"');
      if (!url.href.startsWith(address))
        throw new TypeError('Module specifier "' + normalizedSpecifier + '" backtracks above import map prefix "' + key + '"');
      return url.href;
    }
    return null;
  }

  function resolve(specifier, referrerURL) {
    const base = parseURL(String(referrerURL));
    if (!base) throw new TypeError('Module referrer URL is not a valid URL');
    const serializedBaseURL = base.href;
    const text = String(specifier);
    const asURL = resolveURLLike(text, base);
    const normalizedSpecifier = asURL ? asURL.href : text;
    const resolutionKey = JSON.stringify([serializedBaseURL, normalizedSpecifier]);
    if (resolved.has(resolutionKey)) return resolved.get(resolutionKey);

    let result = null;
    for (const [scopePrefix, scopeImports] of sortedEntries(scopes)) {
      if (!scopeApplies(scopePrefix, serializedBaseURL)) continue;
      result = resolveImportsMatch(normalizedSpecifier, asURL, scopeImports);
      if (result !== null) break;
    }
    if (result === null) result = resolveImportsMatch(normalizedSpecifier, asURL, imports);
    if (result === null && asURL !== null) result = asURL.href;
    if (result === null)
      throw new TypeError('Bare module specifier "' + text + '" was not mapped from "' + serializedBaseURL + '"');

    resolved.set(resolutionKey, result);
    resolutions.set(resolutionKey, {
      baseURL: serializedBaseURL,
      specifier: normalizedSpecifier,
      asURL,
    });
    return result;
  }

  function integrityFor(url) {
    const normalizedURL = parseURL(String(url));
    if (!normalizedURL) return null;
    return integrity.get(normalizedURL.href) ?? null;
  }

  return {add, resolve, integrityFor};
}
