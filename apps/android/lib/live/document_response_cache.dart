import '../l10n/app_i18n.dart';
import 'dart:typed_data';

import 'document_cache_policy.dart';
import 'document_referrer.dart';
import 'document_origin.dart';
import 'gateway.dart';

/// A bounded private HTTP response cache. It stores response bytes, never
/// widget/control state. Browser history restoration is a separate mechanism.
class NativeDocumentResponseCache {
  NativeDocumentResponseCache({
    required this.fetch,
    this.prepare,
    DateTime Function()? now,
    this.maxEntries = 32,
    this.maxBytes = 64 * 1024 * 1024,
  }) : now = now ?? DateTime.now;

  final Future<Json> Function(Json arguments) fetch;

  /// Native-only opaque digest; raw Cookie/Set-Cookie never crosses this bridge.
  final Future<Json> Function(Json arguments)? prepare;
  final DateTime Function() now;
  final int maxEntries, maxBytes;
  final _entries = <(String, String), _ResponseEntry>{};
  int _bytes = 0;
  int get entryCount => _entries.length;
  int get storedBytes => _bytes;

  void clear() {
    _entries.clear();
    _bytes = 0;
  }

  Future<Json> load(
    Json arguments, {
    required bool Function() isCurrent,
    bool revalidate = false,
    bool hardReload = false,
  }) async {
    if (!isCurrent()) throw StateError(tr("Document request was superseded."));
    final method = '${arguments['method'] ?? 'GET'}'.toUpperCase();
    final resource = '${arguments['resourceType'] ?? 'document'}';
    final url = '${arguments['url']}';
    final key = (_representationUrl(url), resource);
    final referrer = resource == 'document'
        ? NativeDocumentReferrer.fromRequest(arguments)
        : const NativeDocumentReferrer('', 'no-referrer');
    final origin = resource == 'document'
        ? nativeDocumentOrigin(
            arguments['originUrl'] as String? ??
                arguments['referrerUrl'] as String? ??
                '',
          )
        : 'null';
    final outgoingReferrer = referrer.forTarget(url);
    final requestHeaders = <String, String>{
      'accept': resource == 'stylesheet'
          ? 'text/css,*/*;q=0.1'
          : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    };
    if (outgoingReferrer.isNotEmpty) {
      requestHeaders['referer'] = outgoingReferrer;
    }
    if (prepare != null) {
      final prepared = await prepare!(arguments);
      if (!isCurrent()) {
        throw StateError(tr("Document request was superseded."));
      }
      final cookieKey = _cookieKey(prepared);
      if (cookieKey == null) {
        throw StateError(tr("Native cookie request state is unavailable."));
      }
      requestHeaders['cookie'] = cookieKey;
    }
    if (method != 'GET') {
      // Once a mutation starts, its outcome might be unknown. Do not keep
      // serving a representation that the mutation might already have changed.
      _removeUrl(key.$1);
    }
    final old = method == 'GET' ? _entries[key] : null;
    final decision = old?.policy.decision(
      now: now(),
      requestReload: revalidate || hardReload,
      requestHeaders: requestHeaders,
    );
    if (old != null &&
        decision == NativeDocumentCacheDecision.fresh &&
        !hardReload) {
      if (!isCurrent()) {
        throw StateError(tr("Document request was superseded."));
      }
      _entries.remove(key);
      _entries[key] = old;
      return {
        ...old.response,
        ...referrer.requestMetadata(url),
        'requestOrigin': null,
        'requestOriginSource': origin,
        'finalUrl': url,
        'nativeCookieRequestKey': requestHeaders['cookie'],
        'nativeSetCookieProcessed': false,
        'cacheSource': 'fresh',
      };
    }
    final wire = <String, dynamic>{
      ...arguments,
      'cacheMode': hardReload
          ? 'reload'
          : revalidate
          ? 'revalidate'
          : 'default',
    };
    // These fields are derived from the known stored representation only.
    wire.remove('ifNoneMatch');
    wire.remove('ifModifiedSince');
    final validating =
        old != null &&
        decision == NativeDocumentCacheDecision.revalidate &&
        !hardReload;
    if (validating) {
      wire['cacheMode'] = 'revalidate';
      final validators = old.policy.conditionalHeaders;
      if (validators['if-none-match'] != null) {
        wire['ifNoneMatch'] = validators['if-none-match'];
      }
      if (validators['if-modified-since'] != null) {
        wire['ifModifiedSince'] = validators['if-modified-since'];
      }
    }
    if (!isCurrent()) throw StateError(tr("Document request was superseded."));
    final requestStarted = now();
    final response = await fetch(wire);
    // Referrer is request metadata, never a property of cached body bytes.
    // Use the native final-hop observation after redirects, not the initial URL.
    final networkReferrer = response['requestReferrer'] as String? ?? '';
    final finalRequestHeaders = {...requestHeaders}
      ..remove('referer')
      ..remove('cookie');
    final networkCookieKey = _cookieKey(response);
    if (networkCookieKey != null) {
      finalRequestHeaders['cookie'] = networkCookieKey;
    }
    if (networkReferrer.isNotEmpty) {
      finalRequestHeaders['referer'] = networkReferrer;
    }
    if (!isCurrent()) return response;
    final received = _timestamp(response['receivedAt']) ?? now();
    final sent = _timestamp(response['requestSentAt']) ?? requestStarted;
    final status = response['status'];
    final finalUrl = '${response['finalUrl']}';
    final finalMethod = '${response['finalMethod'] ?? method}'.toUpperCase();
    final responseHeaders = _headers(response['headersRelevant']);
    if (status == 304) {
      if (!validating ||
          _representationUrl(finalUrl) != key.$1 ||
          finalMethod != 'GET') {
        throw StateError(
          tr("Received 304 without a matching cached representation."),
        );
      }
      final mergedHeaders = {
        ..._headers(old.response['headersRelevant']),
        ...responseHeaders,
      };
      // A 304 has no new representation bytes/MIME. Retain those from the
      // validated 200 response, and update its cache metadata and timing.
      final merged = <String, dynamic>{
        ...old.response,
        'requestOrigin': response['requestOrigin'],
        'requestOriginSource': response['requestOriginSource'] ?? origin,
        'requestReferrer': networkReferrer,
        'requestReferrerPolicy':
            response['requestReferrerPolicy'] ?? referrer.policy,
        'nativeCookieRequestKey': networkCookieKey,
        'nativeSetCookieProcessed':
            response['nativeSetCookieProcessed'] == true,
        'status': 200,
        'finalUrl': finalUrl,
        'finalMethod': 'GET',
        'headersRelevant': mergedHeaders,
        'requestSentAt': sent.millisecondsSinceEpoch,
        'receivedAt': received.millisecondsSinceEpoch,
      };
      _store(key, merged, finalRequestHeaders, sent, received);
      return {...merged, 'cacheSource': 'revalidated', 'networkStatus': 304};
    }
    // Replacing a representation with an error/no-store body also invalidates
    // its previous successful cached response.
    if (method == 'GET') _remove(key);
    if (method == 'POST') _removeUrl(_representationUrl(finalUrl));
    if (status == 200 && finalMethod == 'GET') {
      _store(
        (_representationUrl(finalUrl), resource),
        response,
        finalRequestHeaders,
        sent,
        received,
      );
    }
    return {...response, 'cacheSource': 'network'};
  }

  void _store(
    (String, String) key,
    Json response,
    Map<String, String> requestHeaders,
    DateTime sent,
    DateTime received,
  ) {
    _remove(key);
    final headers = _headers(response['headersRelevant']);
    final policy = NativeDocumentCachePolicy.fromHeaders(
      headers,
      receivedAt: received,
      requestSentAt: sent,
      status: 200,
      method: 'GET',
      requestHeaders: requestHeaders,
    );
    final data = response['bytes'];
    final bytes = data is Uint8List
        ? data
        : data is List<int>
        ? Uint8List.fromList(data)
        : null;
    if (!policy.canStore ||
        bytes == null ||
        bytes.length > maxBytes ||
        maxEntries <= 0) {
      return;
    }
    final copy = Uint8List.fromList(bytes).asUnmodifiableView();
    final representation = Map<String, dynamic>.of(response)
      ..remove('requestReferrer')
      ..remove('requestReferrerPolicy')
      ..remove('requestOrigin')
      ..remove('requestOriginSource')
      ..remove('nativeCookieRequestKey')
      ..remove('nativeSetCookieProcessed');
    final stored = Map<String, dynamic>.unmodifiable({
      ...representation,
      'bytes': copy,
      'headersRelevant': Map<String, String>.unmodifiable(headers),
      'requestSentAt': sent.millisecondsSinceEpoch,
      'receivedAt': received.millisecondsSinceEpoch,
    });
    while (_entries.isNotEmpty &&
        (_entries.length >= maxEntries || _bytes + copy.length > maxBytes)) {
      _remove(_entries.keys.first);
    }
    _entries[key] = _ResponseEntry(stored, policy, copy.length);
    _bytes += copy.length;
  }

  void _remove((String, String) key) {
    final old = _entries.remove(key);
    if (old != null) _bytes -= old.bytes;
  }

  void _removeUrl(String url) {
    for (final key in _entries.keys.where((k) => k.$1 == url).toList()) {
      _remove(key);
    }
  }

  static String? _cookieKey(Json response) {
    final key = response['nativeCookieRequestKey'];
    return key is String && RegExp(r'^[a-f0-9]{64}$').hasMatch(key)
        ? key
        : null;
  }

  static DateTime? _timestamp(dynamic value) =>
      value is num && value.isFinite && value > 0
      ? DateTime.fromMillisecondsSinceEpoch(value.toInt(), isUtc: true)
      : null;
  static Map<String, String> _headers(dynamic value) => {
    for (final entry in obj(value).entries)
      if (entry.value is String &&
          !{'set-cookie', 'set-cookie2'}.contains(entry.key.toLowerCase()))
        entry.key.toLowerCase(): entry.value as String,
  };
  static String _representationUrl(String url) => url.split('#').first;
}

class _ResponseEntry {
  const _ResponseEntry(this.response, this.policy, this.bytes);
  final Json response;
  final NativeDocumentCachePolicy policy;
  final int bytes;
}
