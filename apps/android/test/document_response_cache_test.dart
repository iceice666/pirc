import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/document_response_cache.dart';
import 'package:pirc_mobile/live/gateway.dart';

final DateTime _initialTime = DateTime.utc(2026, 4, 1, 12);
const String _documentUrl = 'https://gateway.example/document';

class _CacheHarness {
  _CacheHarness({int maxEntries = 32, int maxBytes = 64 * 1024 * 1024}) {
    cache = NativeDocumentResponseCache(
      fetch: _fetch,
      now: () => now,
      maxEntries: maxEntries,
      maxBytes: maxBytes,
    );
  }

  DateTime now = _initialTime;
  final requests = <Json>[];
  final responses = <Json>[];
  late final NativeDocumentResponseCache cache;

  Future<Json> _fetch(Json arguments) async {
    requests.add(Map<String, dynamic>.of(arguments));
    if (responses.isEmpty) {
      throw StateError('No fake response queued for ${arguments['url']}');
    }
    return responses.removeAt(0);
  }

  void respond(
    String body, {
    String? finalUrl,
    String finalMethod = 'GET',
    int status = 200,
    String mimeType = 'text/html',
    String? charset = 'utf-8',
    Map<String, String> headers = const <String, String>{
      'Cache-Control': 'max-age=60',
      'Content-Type': 'text/html; charset=utf-8',
    },
    DateTime? receivedAt,
    DateTime? requestSentAt,
  }) {
    responses.add(<String, dynamic>{
      'bytes': Uint8List.fromList(utf8.encode(body)),
      'status': status,
      'finalUrl': finalUrl ?? _documentUrl,
      'finalMethod': finalMethod,
      'mimeType': mimeType,
      'charset': charset,
      'headersRelevant': headers,
      'receivedAt': (receivedAt ?? now).millisecondsSinceEpoch,
      'requestSentAt': (requestSentAt ?? now).millisecondsSinceEpoch,
    });
  }

  void respond304({
    required String finalUrl,
    Map<String, String> headers = const <String, String>{},
    DateTime? receivedAt,
    DateTime? requestSentAt,
  }) {
    responses.add(<String, dynamic>{
      'status': 304,
      'finalUrl': finalUrl,
      'finalMethod': 'GET',
      'headersRelevant': headers,
      'receivedAt': (receivedAt ?? now).millisecondsSinceEpoch,
      'requestSentAt': (requestSentAt ?? now).millisecondsSinceEpoch,
    });
  }
}

Json _request(
  String url, {
  String method = 'GET',
  String resourceType = 'document',
  Map<String, dynamic> extra = const <String, dynamic>{},
}) => <String, dynamic>{
  'url': url,
  'method': method,
  'resourceType': resourceType,
  ...extra,
};

Uint8List _bytes(Json response) => response['bytes'] as Uint8List;
String _body(Json response) => utf8.decode(_bytes(response));

void main() {
  group('NativeDocumentResponseCache', () {
    test('reuses raw response bytes by URL without the fragment', () async {
      final harness = _CacheHarness();
      final firstUrl = '$_documentUrl#first';
      final nextUrl = '$_documentUrl#next';
      harness.respond('first raw response');

      final first = await harness.cache.load(
        _request(firstUrl),
        isCurrent: () => true,
      );
      expect(first['cacheSource'], 'network');
      expect(_body(first), 'first raw response');
      expect(harness.cache.entryCount, 1);

      final cached = await harness.cache.load(
        _request(nextUrl),
        isCurrent: () => true,
      );
      expect(harness.requests, hasLength(1));
      expect(cached['cacheSource'], 'fresh');
      expect(cached['finalUrl'], nextUrl);
      expect(_body(cached), 'first raw response');
    });

    test(
      'merges 304 metadata while preserving the cached body and MIME data',
      () async {
        final harness = _CacheHarness();
        harness.respond(
          '<h1>original bytes</h1>',
          mimeType: 'text/html',
          charset: 'windows-1252',
          headers: const <String, String>{
            'Cache-Control': 'no-cache',
            'Content-Type': 'text/html; charset=windows-1252',
            'ETag': '"stable-v1"',
            'Last-Modified': 'Wed, 01 Apr 2026 11:00:00 GMT',
            'X-Original': 'keep',
          },
        );
        final first = await harness.cache.load(
          _request(_documentUrl),
          isCurrent: () => true,
        );
        expect(first['charset'], 'windows-1252');

        harness.now = _initialTime.add(const Duration(seconds: 5));
        harness.respond304(
          finalUrl: _documentUrl,
          headers: const <String, String>{
            'Cache-Control': 'max-age=120',
            'ETag': '"stable-v1"',
            'X-Validated': 'yes',
          },
        );
        final validated = await harness.cache.load(
          _request(_documentUrl),
          isCurrent: () => true,
        );

        expect(harness.requests, hasLength(2));
        expect(harness.requests.last['ifNoneMatch'], '"stable-v1"');
        expect(
          harness.requests.last['ifModifiedSince'],
          'Wed, 01 Apr 2026 11:00:00 GMT',
        );
        expect(harness.requests.last['cacheMode'], 'revalidate');
        expect(validated['cacheSource'], 'revalidated');
        expect(validated['networkStatus'], 304);
        expect(validated['status'], 200);
        expect(validated['finalMethod'], 'GET');
        expect(_body(validated), '<h1>original bytes</h1>');
        expect(validated['mimeType'], 'text/html');
        expect(validated['charset'], 'windows-1252');
        expect(
          validated['headersRelevant'],
          containsPair('content-type', 'text/html; charset=windows-1252'),
        );
        expect(
          validated['headersRelevant'],
          containsPair('x-original', 'keep'),
        );
        expect(
          validated['headersRelevant'],
          containsPair('x-validated', 'yes'),
        );

        harness.now = harness.now.add(const Duration(seconds: 1));
        final cachedAgain = await harness.cache.load(
          _request(_documentUrl),
          isCurrent: () => true,
        );
        expect(cachedAgain['cacheSource'], 'fresh');
        expect(_body(cachedAgain), '<h1>original bytes</h1>');
        expect(harness.requests, hasLength(2));
      },
    );

    test(
      'revalidates an expired entry with Last-Modified and accepts 304',
      () async {
        final harness = _CacheHarness();
        harness.respond(
          'last-modified body',
          headers: const <String, String>{
            'Cache-Control': 'max-age=1',
            'Last-Modified': 'Wed, 01 Apr 2026 11:00:00 GMT',
          },
        );
        await harness.cache.load(_request(_documentUrl), isCurrent: () => true);

        harness.now = _initialTime.add(const Duration(seconds: 2));
        harness.respond304(
          finalUrl: _documentUrl,
          headers: const <String, String>{'Cache-Control': 'max-age=60'},
        );
        final response = await harness.cache.load(
          _request(_documentUrl),
          isCurrent: () => true,
        );

        expect(
          harness.requests.last['ifModifiedSince'],
          'Wed, 01 Apr 2026 11:00:00 GMT',
        );
        expect(harness.requests.last['cacheMode'], 'revalidate');
        expect(response['networkStatus'], 304);
        expect(_body(response), 'last-modified body');
      },
    );

    test('rejects 304 without a matching stored representation', () async {
      final harness = _CacheHarness();
      harness.respond304(finalUrl: _documentUrl);

      await expectLater(
        harness.cache.load(_request(_documentUrl), isCurrent: () => true),
        throwsStateError,
      );
      expect(harness.cache.entryCount, 0);
    });

    test('a changed 200 body replaces the stale representation', () async {
      final harness = _CacheHarness();
      harness.respond(
        'version one',
        headers: const <String, String>{
          'Cache-Control': 'no-cache',
          'ETag': '"v1"',
        },
      );
      await harness.cache.load(_request(_documentUrl), isCurrent: () => true);

      harness.respond(
        'version two',
        headers: const <String, String>{
          'Cache-Control': 'max-age=60',
          'ETag': '"v2"',
        },
      );
      final updated = await harness.cache.load(
        _request(_documentUrl),
        isCurrent: () => true,
      );
      expect(harness.requests.last['ifNoneMatch'], '"v1"');
      expect(updated['cacheSource'], 'network');
      expect(_body(updated), 'version two');

      final cached = await harness.cache.load(
        _request(_documentUrl),
        isCurrent: () => true,
      );
      expect(cached['cacheSource'], 'fresh');
      expect(_body(cached), 'version two');
      expect(harness.requests, hasLength(2));
    });

    test(
      'no-store response purges an existing cached representation',
      () async {
        final harness = _CacheHarness();
        harness.respond(
          'cached body',
          headers: const <String, String>{
            'Cache-Control': 'max-age=600',
            'ETag': '"old"',
          },
        );
        await harness.cache.load(_request(_documentUrl), isCurrent: () => true);
        expect(harness.cache.entryCount, 1);

        harness.respond(
          'private response',
          headers: const <String, String>{
            'Cache-Control': 'no-store',
            'ETag': '"new"',
          },
        );
        final noStore = await harness.cache.load(
          _request(_documentUrl),
          isCurrent: () => true,
          revalidate: true,
        );
        expect(noStore['cacheSource'], 'network');
        expect(harness.cache.entryCount, 0);

        harness.respond('after no-store');
        final next = await harness.cache.load(
          _request(_documentUrl),
          isCurrent: () => true,
        );
        expect(harness.requests, hasLength(3));
        expect(_body(next), 'after no-store');
      },
    );

    test('Vary star and unsupported Vary fields are never reused', () async {
      for (final vary in <String>['*', 'User-Agent']) {
        final harness = _CacheHarness();
        harness.respond(
          'vary $vary one',
          headers: <String, String>{
            'Cache-Control': 'max-age=3600',
            'Vary': vary,
          },
        );
        await harness.cache.load(_request(_documentUrl), isCurrent: () => true);
        harness.respond('vary $vary two');
        final next = await harness.cache.load(
          _request(_documentUrl),
          isCurrent: () => true,
        );
        expect(harness.requests, hasLength(2), reason: vary);
        expect(_body(next), 'vary $vary two', reason: vary);
      }
    });

    test('POST bypasses GET cache and its response is not cached', () async {
      final harness = _CacheHarness();
      harness.respond(
        'old GET',
        headers: const <String, String>{'Cache-Control': 'max-age=600'},
      );
      await harness.cache.load(_request(_documentUrl), isCurrent: () => true);

      harness.respond(
        'POST result',
        finalMethod: 'POST',
        headers: const <String, String>{
          'Cache-Control': 'max-age=600',
          'ETag': '"post"',
        },
      );
      final post = await harness.cache.load(
        _request(_documentUrl, method: 'POST'),
        isCurrent: () => true,
      );
      expect(post['cacheSource'], 'network');
      expect(harness.requests.last['ifNoneMatch'], isNull);
      expect(harness.cache.entryCount, 0);

      harness.respond('new GET');
      final get = await harness.cache.load(
        _request(_documentUrl),
        isCurrent: () => true,
      );
      expect(harness.requests, hasLength(3));
      expect(_body(get), 'new GET');
    });

    test(
      'a POST redirected to GET is cached under only the final URL',
      () async {
        const formUrl = 'https://gateway.example/form';
        const resultUrl = 'https://gateway.example/result';
        final harness = _CacheHarness();
        harness.respond(
          'redirected GET body',
          finalUrl: resultUrl,
          finalMethod: 'GET',
          headers: const <String, String>{'Cache-Control': 'max-age=600'},
        );
        await harness.cache.load(
          _request(formUrl, method: 'POST'),
          isCurrent: () => true,
        );

        harness.respond('form endpoint GET', finalUrl: formUrl);
        final formGet = await harness.cache.load(
          _request(formUrl),
          isCurrent: () => true,
        );
        expect(_body(formGet), 'form endpoint GET');

        final resultGet = await harness.cache.load(
          _request(resultUrl),
          isCurrent: () => true,
        );
        expect(resultGet['cacheSource'], 'fresh');
        expect(_body(resultGet), 'redirected GET body');
        expect(harness.requests, hasLength(2));
      },
    );

    test(
      'automatic stale validation, reload, and hard reload use distinct modes',
      () async {
        final harness = _CacheHarness();
        harness.respond(
          'zero age one',
          headers: const <String, String>{
            'Cache-Control': 'max-age=0',
            'ETag': '"zero-v1"',
          },
        );
        await harness.cache.load(_request(_documentUrl), isCurrent: () => true);

        harness.respond304(finalUrl: _documentUrl);
        await harness.cache.load(_request(_documentUrl), isCurrent: () => true);
        expect(harness.requests.last['cacheMode'], 'revalidate');
        expect(harness.requests.last['ifNoneMatch'], '"zero-v1"');

        harness.respond(
          'normal reload result',
          headers: const <String, String>{
            'Cache-Control': 'max-age=60',
            'ETag': '"v2"',
          },
        );
        final normalReload = await harness.cache.load(
          _request(_documentUrl),
          isCurrent: () => true,
          revalidate: true,
        );
        expect(harness.requests.last['cacheMode'], 'revalidate');
        expect(harness.requests.last['ifNoneMatch'], '"zero-v1"');
        expect(_body(normalReload), 'normal reload result');

        harness.respond('hard reload result');
        final hardReload = await harness.cache.load(
          _request(
            _documentUrl,
            extra: const <String, dynamic>{
              'ifNoneMatch': 'caller-supplied-validator',
            },
          ),
          isCurrent: () => true,
          hardReload: true,
        );
        expect(harness.requests.last['cacheMode'], 'reload');
        expect(harness.requests.last.containsKey('ifNoneMatch'), isFalse);
        expect(harness.requests.last.containsKey('ifModifiedSince'), isFalse);
        expect(_body(hardReload), 'hard reload result');
      },
    );

    test(
      'resource type separates stylesheet Accept variation from documents',
      () async {
        final harness = _CacheHarness();
        harness.respond(
          'document body',
          headers: const <String, String>{
            'Cache-Control': 'max-age=600',
            'Vary': 'Accept',
          },
        );
        await harness.cache.load(_request(_documentUrl), isCurrent: () => true);

        harness.respond(
          'body { color: red; }',
          mimeType: 'text/css',
          charset: 'utf-8',
          headers: const <String, String>{
            'Cache-Control': 'max-age=600',
            'Content-Type': 'text/css; charset=utf-8',
            'Vary': 'Accept',
          },
        );
        final stylesheet = await harness.cache.load(
          _request(_documentUrl, resourceType: 'stylesheet'),
          isCurrent: () => true,
        );
        expect(_body(stylesheet), 'body { color: red; }');
        expect(harness.cache.entryCount, 2);
        expect(harness.requests.last['resourceType'], 'stylesheet');

        final cachedStyle = await harness.cache.load(
          _request(_documentUrl, resourceType: 'stylesheet'),
          isCurrent: () => true,
        );
        expect(cachedStyle['cacheSource'], 'fresh');
        expect(_body(cachedStyle), 'body { color: red; }');
        expect(harness.requests, hasLength(2));
      },
    );

    test(
      'cached bytes are immutable copies and entries obey LRU bounds',
      () async {
        final mutableBytes = Uint8List.fromList(utf8.encode('one'));
        final harness = _CacheHarness(maxEntries: 1, maxBytes: 3);
        harness.responses.add(<String, dynamic>{
          'bytes': mutableBytes,
          'status': 200,
          'finalUrl': _documentUrl,
          'finalMethod': 'GET',
          'mimeType': 'text/html',
          'charset': 'utf-8',
          'headersRelevant': <String, String>{'Cache-Control': 'max-age=600'},
        });
        await harness.cache.load(_request(_documentUrl), isCurrent: () => true);
        mutableBytes[0] = 0;

        final cached = await harness.cache.load(
          _request(_documentUrl),
          isCurrent: () => true,
        );
        expect(_body(cached), 'one');
        expect(() => _bytes(cached)[0] = 0, throwsUnsupportedError);
        expect(harness.cache.storedBytes, 3);

        const secondUrl = 'https://gateway.example/second';
        harness.respond('two', finalUrl: secondUrl);
        await harness.cache.load(_request(secondUrl), isCurrent: () => true);
        expect(harness.cache.entryCount, 1);
        expect(harness.cache.storedBytes, 3);

        harness.respond('one-again');
        final fetchedAgain = await harness.cache.load(
          _request(_documentUrl),
          isCurrent: () => true,
        );
        expect(harness.requests, hasLength(3));
        expect(_body(fetchedAgain), 'one-again');
        expect(harness.cache.entryCount, 1);
        expect(harness.cache.storedBytes, 3);
        final cachedSecond = await harness.cache.load(
          _request(secondUrl),
          isCurrent: () => true,
        );
        expect(cachedSecond['cacheSource'], 'fresh');
        expect(_body(cachedSecond), 'two');
        expect(harness.requests, hasLength(3));

        harness.cache.clear();
        expect(harness.cache.entryCount, 0);
        expect(harness.cache.storedBytes, 0);
      },
    );

    test('a response from a stale account generation is not stored', () async {
      var isCurrent = true;
      final calls = <Json>[];
      final delayed = Completer<Json>();
      var firstFetch = true;
      final cache = NativeDocumentResponseCache(
        now: () => _initialTime,
        fetch: (arguments) {
          calls.add(Map<String, dynamic>.of(arguments));
          if (firstFetch) {
            firstFetch = false;
            return delayed.future;
          }
          return Future<Json>.value(<String, dynamic>{
            'bytes': Uint8List.fromList(utf8.encode('current account')),
            'status': 200,
            'finalUrl': _documentUrl,
            'finalMethod': 'GET',
            'mimeType': 'text/html',
            'charset': 'utf-8',
            'headersRelevant': <String, String>{'Cache-Control': 'max-age=600'},
          });
        },
      );

      final oldRequest = cache.load(
        _request(_documentUrl),
        isCurrent: () => isCurrent,
      );
      isCurrent = false;
      delayed.complete(<String, dynamic>{
        'bytes': Uint8List.fromList(utf8.encode('old account')),
        'status': 200,
        'finalUrl': _documentUrl,
        'finalMethod': 'GET',
        'mimeType': 'text/html',
        'charset': 'utf-8',
        'headersRelevant': <String, String>{'Cache-Control': 'max-age=600'},
      });
      final staleResult = await oldRequest;
      expect(_body(staleResult), 'old account');
      expect(cache.entryCount, 0);

      isCurrent = true;
      final current = await cache.load(
        _request(_documentUrl),
        isCurrent: () => isCurrent,
      );
      expect(calls, hasLength(2));
      expect(_body(current), 'current account');
      expect(cache.entryCount, 1);
    });

    test(
      'a stale-account POST cannot evict the current account cache',
      () async {
        final harness = _CacheHarness();
        harness.respond(
          'current account cached body',
          headers: const <String, String>{'Cache-Control': 'max-age=600'},
        );
        await harness.cache.load(_request(_documentUrl), isCurrent: () => true);
        expect(harness.cache.entryCount, 1);

        await expectLater(
          harness.cache.load(
            _request(_documentUrl, method: 'POST'),
            isCurrent: () => false,
          ),
          throwsStateError,
        );
        expect(harness.requests, hasLength(1));
        expect(harness.cache.entryCount, 1);
        expect(
          harness.cache.storedBytes,
          utf8.encode('current account cached body').length,
        );

        final cached = await harness.cache.load(
          _request(_documentUrl),
          isCurrent: () => true,
        );
        expect(cached['cacheSource'], 'fresh');
        expect(_body(cached), 'current account cached body');
        expect(harness.requests, hasLength(1));
      },
    );
  });
}
