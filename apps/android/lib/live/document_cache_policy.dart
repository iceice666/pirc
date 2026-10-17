/// HTTP cache decisions for responses fetched as native documents.
///
/// This models a private cache for successful GET responses. It does not
/// define browser history behavior: history restoration is a separate policy.
library;

import 'dart:collection';
import 'dart:io';

/// What the native document loader should do with a previously stored body.
enum NativeDocumentCacheDecision {
  /// The stored body can satisfy the request without contacting the server.
  fresh,

  /// The stored body has a validator and should be checked with the server.
  revalidate,

  /// The stored body cannot safely be reused; perform an unconditional fetch.
  fetch,
}

/// The HTTP caching metadata needed to reuse or revalidate a native document.
///
/// The implementation is intentionally conservative. It understands the
/// `Accept`, `Accept-Language` and `Referer` request fields, and the native transport's
/// known-absent `Origin` field, for `Vary`; other `Vary` names can be stored as
/// metadata but cannot be reused by this policy. `s-maxage` is ignored because
/// this is a private, per-user cache.
class NativeDocumentCachePolicy {
  NativeDocumentCachePolicy._({
    required this.receivedAt,
    required this.status,
    required this.method,
    required this.requestSentAt,
    required this.canStore,
    required this.etag,
    required this.lastModified,
    required this.varyFields,
    required this.responseHeaders,
    required this._originalRequestHeaders,
    required this._freshnessLifetime,
    required this._correctedInitialAge,
    required this._requiresValidation,
    required this._varyIsUncacheable,
    required this._varyCanBeMatched,
  });

  /// Builds a policy from the response and the original request metadata.
  ///
  /// [requestSentAt] is optional. If it is omitted, the response delay used
  /// in RFC 9111's age calculation is treated as zero. [requestHeaders] should
  /// contain the request fields that might be named by `Vary`. Missing fields
  /// are compared as absent. This policy compares `Accept`, `Accept-Language`,
  /// `Referer`, and `Origin`; the native document transport does not add an `Origin`
  /// field to GET requests, so its absence is a known request value.
  factory NativeDocumentCachePolicy.fromHeaders(
    Map<String, String> headers, {
    required DateTime receivedAt,
    required int status,
    required String method,
    DateTime? requestSentAt,
    Map<String, String> requestHeaders = const <String, String>{},
  }) {
    final responseFieldValues = <String, List<String>>{};
    for (final entry in headers.entries) {
      final name = entry.key.toLowerCase();
      responseFieldValues.putIfAbsent(name, () => <String>[]).add(entry.value);
    }

    final normalizedResponseHeaders = <String, String>{};
    for (final entry in responseFieldValues.entries) {
      normalizedResponseHeaders[entry.key] = entry.value.join(', ');
    }
    final immutableHeaders = UnmodifiableMapView<String, String>(
      normalizedResponseHeaders,
    );

    final controls = _parseCacheControl(
      responseFieldValues['cache-control'] ?? const <String>[],
    );
    final cacheControl = controls.directives;
    final noStore = cacheControl.containsKey('no-store');
    final noCache = cacheControl.containsKey('no-cache');
    final maxAgeValues = cacheControl['max-age'] ?? const <String?>[];

    var freshnessIsInvalid = controls.malformed;
    var hasValidMaxAge = false;
    Duration? explicitFreshness;
    if (maxAgeValues.isNotEmpty) {
      if (maxAgeValues.length != 1) {
        freshnessIsInvalid = true;
      } else {
        final seconds = _parseDeltaSeconds(maxAgeValues.single);
        if (seconds == null) {
          freshnessIsInvalid = true;
        } else {
          hasValidMaxAge = true;
          explicitFreshness = Duration(seconds: seconds);
        }
      }
    }

    final dateValues = responseFieldValues['date'] ?? const <String>[];
    final expiresValues = responseFieldValues['expires'] ?? const <String>[];
    final ageValues = responseFieldValues['age'] ?? const <String>[];
    final lastModifiedValues =
        responseFieldValues['last-modified'] ?? const <String>[];
    final etagValues = responseFieldValues['etag'] ?? const <String>[];

    final date = dateValues.length == 1
        ? _parseHttpDate(dateValues.single)
        : null;
    final expires = expiresValues.length == 1
        ? _parseHttpDate(expiresValues.single)
        : null;
    final lastModifiedDate = lastModifiedValues.length == 1
        ? _parseHttpDate(lastModifiedValues.single)
        : null;

    if (dateValues.length > 1 || (dateValues.isNotEmpty && date == null)) {
      freshnessIsInvalid = true;
    }

    // A valid max-age is the private cache's authoritative freshness lifetime.
    // Ignore Expires when it is malformed or repeated in that case; without a
    // valid max-age, malformed Expires must be stale and must not fall through
    // to a Last-Modified heuristic.
    if (!hasValidMaxAge &&
        (expiresValues.length > 1 ||
            (expiresValues.isNotEmpty && expires == null))) {
      freshnessIsInvalid = true;
    }

    final ageSeconds = ageValues.length == 1
        ? _parseDeltaSeconds(ageValues.single)
        : ageValues.isEmpty
        ? 0
        : null;
    if (ageSeconds == null) freshnessIsInvalid = true;

    if (explicitFreshness == null &&
        expiresValues.isNotEmpty &&
        expires != null) {
      final referenceDate = date ?? receivedAt;
      final delta = expires.difference(referenceDate);
      explicitFreshness = delta.isNegative ? Duration.zero : delta;
    }

    var freshnessLifetime = explicitFreshness;
    final hasExplicitExpiry =
        maxAgeValues.isNotEmpty || expiresValues.isNotEmpty;
    if (freshnessLifetime == null &&
        !hasExplicitExpiry &&
        !freshnessIsInvalid &&
        status == HttpStatus.ok &&
        lastModifiedDate != null) {
      final referenceDate = date ?? receivedAt;
      final modifiedAge = referenceDate.difference(lastModifiedDate);
      if (!modifiedAge.isNegative) {
        final heuristicMillis = (modifiedAge.inMilliseconds ~/ 10).clamp(
          0,
          _maximumHeuristicLifetime.inMilliseconds,
        );
        freshnessLifetime = Duration(milliseconds: heuristicMillis);
      }
    }

    final correctedInitialAge = _calculateCorrectedInitialAge(
      receivedAt: receivedAt,
      requestSentAt: requestSentAt,
      date: date,
      ageSeconds: ageSeconds ?? 0,
    );

    final varyParse = _parseVary(
      responseFieldValues['vary'] ?? const <String>[],
    );
    final normalizedRequestHeaders = _normalizeHeaders(requestHeaders);
    final methodUpper = method.trim().toUpperCase();
    final statusCanStore = status >= 200 && status < 300;
    final varyIsUncacheable = varyParse.containsStar;

    return NativeDocumentCachePolicy._(
      receivedAt: receivedAt.toUtc(),
      status: status,
      method: methodUpper,
      requestSentAt: requestSentAt?.toUtc(),
      canStore:
          methodUpper == 'GET' &&
          statusCanStore &&
          !noStore &&
          !varyIsUncacheable,
      etag: etagValues.length == 1 ? etagValues.single.trim() : null,
      lastModified: lastModifiedValues.length == 1
          ? lastModifiedValues.single.trim()
          : null,
      varyFields: List<String>.unmodifiable(varyParse.fields),
      responseHeaders: immutableHeaders,
      originalRequestHeaders: Map<String, String>.unmodifiable(
        normalizedRequestHeaders,
      ),
      freshnessLifetime: freshnessIsInvalid ? Duration.zero : freshnessLifetime,
      correctedInitialAge: correctedInitialAge,
      requiresValidation: noCache || freshnessIsInvalid || varyParse.malformed,
      varyIsUncacheable: varyIsUncacheable,
      varyCanBeMatched:
          !varyParse.malformed &&
          varyParse.fields.every(_supportedVaryFields.contains) &&
          (!varyParse.fields.contains('cookie') ||
              normalizedRequestHeaders.containsKey('cookie')),
    );
  }

  static const Duration _maximumHeuristicLifetime = Duration(hours: 24);
  static const Set<String> _supportedVaryFields = <String>{
    'accept',
    'accept-language',
    'referer',
    'origin',
    'cookie',
  };

  /// Response receipt time, in UTC.
  final DateTime receivedAt;

  /// Response status code and normalized request method.
  final int status;
  final String method;

  /// Request start time, if supplied to [fromHeaders].
  final DateTime? requestSentAt;

  /// Whether this response may be kept in the private native HTTP cache.
  ///
  /// A response with an unsupported `Vary` field may still be storable, but
  /// [decision] will never reuse it because this module cannot verify a match.
  final bool canStore;

  /// The response's entity tag, if present as a single header value.
  final String? etag;

  /// The response's Last-Modified value, if present as a single header value.
  final String? lastModified;

  /// Lowercase names from the response's `Vary` field.
  final List<String> varyFields;

  /// Response headers normalized to lowercase names.
  ///
  /// Repeated field values are joined with `, `; callers needing the exact
  /// wire representation should keep that separately.
  final Map<String, String> responseHeaders;

  final Map<String, String> _originalRequestHeaders;
  final Duration? _freshnessLifetime;
  final Duration _correctedInitialAge;
  final bool _requiresValidation;
  final bool _varyIsUncacheable;
  final bool _varyCanBeMatched;

  /// Conditional request headers for the stored representation.
  ///
  /// Sends each available safe validator. The server applies its conditional
  /// request precedence when both ETag and Last-Modified are present.
  Map<String, String> get conditionalHeaders {
    final headers = <String, String>{};
    final entityTag = etag;
    if (entityTag != null &&
        entityTag.isNotEmpty &&
        !entityTag.contains('\r') &&
        !entityTag.contains('\n')) {
      headers['if-none-match'] = entityTag;
    }
    final modified = lastModified;
    if (modified != null &&
        modified.isNotEmpty &&
        _parseHttpDate(modified) != null) {
      headers['if-modified-since'] = modified;
    }
    return Map<String, String>.unmodifiable(headers);
  }

  /// Estimated current age of the response using the corrected initial age.
  Duration currentAgeAt(DateTime now) {
    final residentTime = now.toUtc().difference(receivedAt);
    return _correctedInitialAge +
        (residentTime.isNegative ? Duration.zero : residentTime);
  }

  /// Determines whether the stored response may satisfy a request now.
  ///
  /// A reload ignores freshness, including `immutable`, but may still use a
  /// validator for a conditional network request. When [requestHeaders] is
  /// supplied, it is compared with the original request for supported `Vary`
  /// fields. A mismatch or unsupported `Vary` field requires an unconditional
  /// fetch because this stored representation is not known to match.
  NativeDocumentCacheDecision decision({
    required DateTime now,
    bool requestReload = false,
    Map<String, String>? requestHeaders,
  }) {
    if (!canStore || _varyIsUncacheable || !_varyCanBeMatched) {
      return NativeDocumentCacheDecision.fetch;
    }

    final currentRequestHeaders = requestHeaders == null
        ? _originalRequestHeaders
        : _normalizeHeaders(requestHeaders);
    for (final field in varyFields) {
      if (_originalRequestHeaders[field] != currentRequestHeaders[field]) {
        return NativeDocumentCacheDecision.fetch;
      }
    }

    final freshnessLifetime = _freshnessLifetime;
    final isFresh =
        freshnessLifetime != null && freshnessLifetime > currentAgeAt(now);
    if (!requestReload && !_requiresValidation && isFresh) {
      return NativeDocumentCacheDecision.fresh;
    }

    return conditionalHeaders.isNotEmpty
        ? NativeDocumentCacheDecision.revalidate
        : NativeDocumentCacheDecision.fetch;
  }
}

const int _maximumDeltaSeconds = 0x80000000;

int? _parseDeltaSeconds(String? value) {
  if (value == null || !RegExp(r'^\d+$').hasMatch(value)) return null;
  final parsed = int.tryParse(value);
  if (parsed == null) return _maximumDeltaSeconds;
  return parsed.clamp(0, _maximumDeltaSeconds);
}

Duration _calculateCorrectedInitialAge({
  required DateTime receivedAt,
  required DateTime? requestSentAt,
  required DateTime? date,
  required int ageSeconds,
}) {
  final responseTime = receivedAt.toUtc();
  final apparentAge = date == null
      ? Duration.zero
      : responseTime.difference(date.toUtc());
  final nonNegativeApparentAge = apparentAge.isNegative
      ? Duration.zero
      : apparentAge;
  final responseDelay = requestSentAt == null
      ? Duration.zero
      : responseTime.difference(requestSentAt.toUtc());
  final nonNegativeResponseDelay = responseDelay.isNegative
      ? Duration.zero
      : responseDelay;
  final correctedAgeValue =
      Duration(seconds: ageSeconds) + nonNegativeResponseDelay;
  return nonNegativeApparentAge > correctedAgeValue
      ? nonNegativeApparentAge
      : correctedAgeValue;
}

DateTime? _parseHttpDate(String value) {
  final trimmed = value.trim();
  if (trimmed.isEmpty) return null;
  try {
    return HttpDate.parse(trimmed).toUtc();
  } on FormatException {
    return null;
  } on HttpException {
    return null;
  }
}

Map<String, String> _normalizeHeaders(Map<String, String> headers) {
  final values = <String, List<String>>{};
  for (final entry in headers.entries) {
    values
        .putIfAbsent(entry.key.toLowerCase(), () => <String>[])
        .add(_trimOptionalWhitespace(entry.value));
  }
  return <String, String>{
    for (final entry in values.entries) entry.key: entry.value.join(', '),
  };
}

String _trimOptionalWhitespace(String value) {
  var start = 0;
  var end = value.length;
  while (start < end &&
      (value.codeUnitAt(start) == 0x20 || value.codeUnitAt(start) == 0x09)) {
    start++;
  }
  while (end > start &&
      (value.codeUnitAt(end - 1) == 0x20 ||
          value.codeUnitAt(end - 1) == 0x09)) {
    end--;
  }
  return value.substring(start, end);
}

class _CacheControlParseResult {
  const _CacheControlParseResult(this.directives, this.malformed);

  final Map<String, List<String?>> directives;
  final bool malformed;
}

_CacheControlParseResult _parseCacheControl(List<String> fieldValues) {
  final directives = <String, List<String?>>{};
  var malformed = false;
  for (final fieldValue in fieldValues) {
    final split = _splitOutsideQuotes(fieldValue, ',');
    if (split.malformed) malformed = true;
    for (final rawDirective in split.parts) {
      final directive = rawDirective.trim();
      if (directive.isEmpty) {
        malformed = true;
        continue;
      }
      final equalsAt = _indexOfOutsideQuotes(directive, '=');
      final name = (equalsAt < 0 ? directive : directive.substring(0, equalsAt))
          .trim()
          .toLowerCase();
      if (!_isHttpToken(name)) {
        malformed = true;
        continue;
      }
      final rawValue = equalsAt < 0
          ? null
          : directive.substring(equalsAt + 1).trim();
      final decodedValue = rawValue == null
          ? null
          : _decodeDirectiveValue(rawValue);
      if (rawValue != null && decodedValue == null) malformed = true;
      directives.putIfAbsent(name, () => <String?>[]).add(decodedValue);
    }
  }
  return _CacheControlParseResult(directives, malformed);
}

class _SplitResult {
  const _SplitResult(this.parts, this.malformed);

  final List<String> parts;
  final bool malformed;
}

_SplitResult _splitOutsideQuotes(String input, String delimiter) {
  final parts = <String>[];
  var quoted = false;
  var escaped = false;
  var start = 0;
  for (var index = 0; index < input.length; index++) {
    final char = input[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && char == r'\') {
      escaped = true;
      continue;
    }
    if (char == '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && char == delimiter) {
      parts.add(input.substring(start, index));
      start = index + 1;
    }
  }
  parts.add(input.substring(start));
  return _SplitResult(parts, quoted || escaped);
}

int _indexOfOutsideQuotes(String input, String sought) {
  var quoted = false;
  var escaped = false;
  for (var index = 0; index < input.length; index++) {
    final char = input[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && char == r'\') {
      escaped = true;
      continue;
    }
    if (char == '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && char == sought) return index;
  }
  return -1;
}

String? _decodeDirectiveValue(String rawValue) {
  if (rawValue.isEmpty) return '';
  if (!rawValue.startsWith('"')) {
    if (rawValue.contains('"')) return null;
    return rawValue;
  }
  if (rawValue.length < 2 || !rawValue.endsWith('"')) return null;
  final output = StringBuffer();
  for (var index = 1; index < rawValue.length - 1; index++) {
    final char = rawValue[index];
    if (char == r'\') {
      if (index + 1 >= rawValue.length - 1) return null;
      index++;
      output.write(rawValue[index]);
    } else if (char == '"') {
      return null;
    } else {
      output.write(char);
    }
  }
  return output.toString();
}

class _VaryParseResult {
  const _VaryParseResult({
    required this.fields,
    required this.containsStar,
    required this.malformed,
  });

  final List<String> fields;
  final bool containsStar;
  final bool malformed;
}

_VaryParseResult _parseVary(List<String> fieldValues) {
  final fields = <String>{};
  var containsStar = false;
  var malformed = false;
  for (final fieldValue in fieldValues) {
    for (final rawField in fieldValue.split(',')) {
      final field = rawField.trim().toLowerCase();
      if (field == '*') {
        containsStar = true;
      } else if (_isHttpToken(field)) {
        fields.add(field);
      } else {
        malformed = true;
      }
    }
  }
  return _VaryParseResult(
    fields: fields.toList(growable: false),
    containsStar: containsStar,
    malformed: malformed,
  );
}

bool _isHttpToken(String value) {
  if (value.isEmpty) return false;
  for (final codeUnit in value.codeUnits) {
    final isAlphaNumeric =
        (codeUnit >= 0x30 && codeUnit <= 0x39) ||
        (codeUnit >= 0x41 && codeUnit <= 0x5a) ||
        (codeUnit >= 0x61 && codeUnit <= 0x7a);
    const punctuation = "!#\$%&'*+-.^_`|~";
    if (!isAlphaNumeric &&
        !punctuation.contains(String.fromCharCode(codeUnit))) {
      return false;
    }
  }
  return true;
}
