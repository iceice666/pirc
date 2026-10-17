import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/document_response_cache.dart';
import 'package:pirc_mobile/live/gateway.dart';

const url = 'https://example.test/page';
final keyA = 'a' * 64, keyB = 'b' * 64;
final arguments = <String, dynamic>{'url': url, 'method': 'GET'};
Json response(String key, {int status = 200, String cache = 'max-age=60'}) => {
  'bytes': Uint8List.fromList([status == 200 ? 1 : 0]),
  'status': status,
  'finalUrl': url,
  'finalMethod': 'GET',
  'nativeCookieRequestKey': key,
  'nativeSetCookieProcessed': true,
  'headersRelevant': {'vary': 'Cookie', 'cache-control': cache, 'etag': '"a"'},
};

void main() {
  test('Vary Cookie reuses only the actual opaque request identity', () async {
    var currentKey = keyA, fetched = 0;
    final cache = NativeDocumentResponseCache(
      prepare: (_) async => {'nativeCookieRequestKey': currentKey},
      fetch: (_) async {
        fetched++;
        return response(currentKey);
      },
    );
    await cache.load(arguments, isCurrent: () => true);
    final hit = await cache.load(arguments, isCurrent: () => true);
    expect(hit['cacheSource'], 'fresh');
    expect(hit['nativeSetCookieProcessed'], false);
    expect(fetched, 1);
    currentKey = keyB;
    expect(
      (await cache.load(arguments, isCurrent: () => true))['cacheSource'],
      'network',
    );
    expect(fetched, 2);
  });
  test(
    'redirect final-hop identity wins over prepared initial identity',
    () async {
      var prepared = keyA, fetched = 0;
      final cache = NativeDocumentResponseCache(
        prepare: (_) async => {'nativeCookieRequestKey': prepared},
        fetch: (_) async {
          fetched++;
          return response(keyB);
        },
      );
      await cache.load(arguments, isCurrent: () => true);
      await cache.load(arguments, isCurrent: () => true);
      expect(fetched, 2);
      prepared = keyB;
      expect(
        (await cache.load(arguments, isCurrent: () => true))['cacheSource'],
        'fresh',
      );
      expect(fetched, 2);
    },
  );
  test(
    '304 updates state once and never replays Set-Cookie on a hit',
    () async {
      final requests = <Json>[];
      final cache = NativeDocumentResponseCache(
        prepare: (_) async => {'nativeCookieRequestKey': keyA},
        fetch: (args) async {
          requests.add(args);
          return response(
            keyA,
            status: requests.length == 1 ? 200 : 304,
            cache: requests.length == 1 ? 'no-cache' : 'max-age=60',
          )..['headersRelevant']['set-cookie'] = 'httpOnlySecret=never-export';
        },
      );
      await cache.load(arguments, isCurrent: () => true);
      final validated = await cache.load(arguments, isCurrent: () => true);
      expect(requests.last['ifNoneMatch'], '"a"');
      expect(validated['cacheSource'], 'revalidated');
      expect(validated['nativeSetCookieProcessed'], true);
      expect(
        validated['headersRelevant'].toString(),
        isNot(contains('never-export')),
      );
      final hit = await cache.load(arguments, isCurrent: () => true);
      expect(hit['nativeSetCookieProcessed'], false);
      expect(requests.length, 2);
    },
  );
  test(
    'unknown native Cookie identity cannot match a Vary Cookie response',
    () async {
      var fetched = 0;
      final cache = NativeDocumentResponseCache(
        fetch: (_) async {
          fetched++;
          return response(keyA)..remove('nativeCookieRequestKey');
        },
      );
      await cache.load(arguments, isCurrent: () => true);
      await cache.load(arguments, isCurrent: () => true);
      expect(fetched, 2);
    },
  );
  test(
    'account retirement during prepare cannot return a stored response',
    () async {
      var current = true, fetched = 0;
      final cache = NativeDocumentResponseCache(
        prepare: (_) async {
          current = false;
          return {'nativeCookieRequestKey': keyA};
        },
        fetch: (_) async {
          fetched++;
          return response(keyA);
        },
      );
      await expectLater(
        cache.load(arguments, isCurrent: () => current),
        throwsStateError,
      );
      expect(fetched, 0);
    },
  );
  test(
    'missing native identity fails visibly instead of assuming an empty jar',
    () async {
      final cache = NativeDocumentResponseCache(
        prepare: (_) async => {},
        fetch: (_) async => response(keyA),
      );
      await expectLater(
        cache.load(arguments, isCurrent: () => true),
        throwsStateError,
      );
    },
  );
}
