import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/document_cache_policy.dart';

final DateTime _receivedAt = DateTime.utc(2026, 1, 1, 12);
final DateTime _now = DateTime.utc(2026, 1, 1, 12, 0, 10);

NativeDocumentCachePolicy _policy(
  Map<String, String> headers, {
  int status = 200,
  String method = 'GET',
  DateTime? receivedAt,
  DateTime? requestSentAt,
  Map<String, String> requestHeaders = const <String, String>{},
}) => NativeDocumentCachePolicy.fromHeaders(
  headers,
  receivedAt: receivedAt ?? _receivedAt,
  status: status,
  method: method,
  requestSentAt: requestSentAt,
  requestHeaders: requestHeaders,
);

void main() {
  group('NativeDocumentCachePolicy', () {
    test('uses max-age before Expires and computes corrected current age', () {
      final policy = _policy(<String, String>{
        'dAtE': 'Thu, 01 Jan 2026 12:00:00 GMT',
        'Age': '4',
        'Cache-Control': 'private, max-age="30"',
        'Expires': 'Thu, 01 Jan 2026 12:00:20 GMT',
        'ETag': '"doc-v1"',
      }, requestSentAt: DateTime.utc(2026, 1, 1, 11, 59, 58));

      expect(policy.canStore, isTrue);
      expect(policy.currentAgeAt(_now), const Duration(seconds: 16));
      expect(
        policy.decision(now: DateTime.utc(2026, 1, 1, 12, 0, 22)),
        NativeDocumentCacheDecision.fresh,
      );
      expect(policy.conditionalHeaders, <String, String>{
        'if-none-match': '"doc-v1"',
      });
    });

    test('valid max-age wins over invalid or repeated Expires values', () {
      final invalidAndRepeatedExpires = <Map<String, String>>[
        <String, String>{'Expires': 'not an HTTP date'},
        <String, String>{'Expires': 'Wed, 31 Dec 2025 23:59:59 GMT'},
        <String, String>{
          'Expires': 'not an HTTP date',
          'expires': 'also not an HTTP date',
        },
      ];

      for (final expiresHeaders in invalidAndRepeatedExpires) {
        final policy = _policy(<String, String>{
          ...expiresHeaders,
          'Cache-Control': 'max-age=60',
          'ETag': '"v1"',
        });
        expect(
          policy.decision(now: _now),
          NativeDocumentCacheDecision.fresh,
          reason: expiresHeaders.toString(),
        );
      }
    });

    test('uses Age plus request delay when it exceeds apparent age', () {
      final policy = _policy(<String, String>{
        'Date': 'Thu, 01 Jan 2026 12:00:08 GMT',
        'Age': '8',
        'Cache-Control': 'max-age=30',
        'ETag': '"v1"',
      }, requestSentAt: DateTime.utc(2026, 1, 1, 11, 59, 58));

      expect(policy.currentAgeAt(_now), const Duration(seconds: 20));
      expect(policy.decision(now: _now), NativeDocumentCacheDecision.fresh);
      expect(
        policy.decision(now: DateTime.utc(2026, 1, 1, 12, 0, 20)),
        NativeDocumentCacheDecision.revalidate,
      );
    });

    test('uses Expires relative to Date and falls back to receipt time', () {
      final basedOnDate = _policy(<String, String>{
        'Date': 'Thu, 01 Jan 2026 12:00:00 GMT',
        'Expires': 'Thu, 01 Jan 2026 12:00:30 GMT',
        'ETag': '"v1"',
      });
      expect(
        basedOnDate.decision(now: _now),
        NativeDocumentCacheDecision.fresh,
      );
      expect(
        basedOnDate.decision(now: DateTime.utc(2026, 1, 1, 12, 0, 31)),
        NativeDocumentCacheDecision.revalidate,
      );

      final withoutDate = _policy(<String, String>{
        'Expires': 'Thu, 01 Jan 2026 12:00:30 GMT',
      });
      expect(
        withoutDate.decision(now: DateTime.utc(2026, 1, 1, 12, 0, 20)),
        NativeDocumentCacheDecision.fresh,
      );
    });

    test('uses a ten percent Last-Modified heuristic capped at one day', () {
      final ordinary = _policy(<String, String>{
        'Date': 'Thu, 01 Jan 2026 12:00:00 GMT',
        'Last-Modified': 'Thu, 01 Jan 2026 10:00:00 GMT',
        'ETag': '"v1"',
      });
      expect(
        ordinary.decision(now: DateTime.utc(2026, 1, 1, 12, 0, 11)),
        NativeDocumentCacheDecision.fresh,
      );
      expect(
        ordinary.decision(now: DateTime.utc(2026, 1, 1, 12, 12)),
        NativeDocumentCacheDecision.revalidate,
      );

      final capped = _policy(<String, String>{
        'Date': 'Thu, 01 Jan 2026 12:00:00 GMT',
        'Last-Modified': 'Thu, 01 Jan 2025 12:00:00 GMT',
        'ETag': '"v2"',
      });
      expect(
        capped.decision(now: DateTime.utc(2026, 1, 2, 11, 59, 59)),
        NativeDocumentCacheDecision.fresh,
      );
      expect(
        capped.decision(now: DateTime.utc(2026, 1, 2, 12)),
        NativeDocumentCacheDecision.revalidate,
      );
    });

    test('a response without explicit freshness or Last-Modified is stale', () {
      final policy = _policy(<String, String>{'ETag': '"v1"'});
      expect(
        policy.decision(now: _now),
        NativeDocumentCacheDecision.revalidate,
      );
      expect(
        _policy(<String, String>{}).decision(now: _now),
        NativeDocumentCacheDecision.fetch,
      );
    });

    test('no-cache always validates and no-store cannot enter the cache', () {
      final mustValidate = _policy(<String, String>{
        'Cache-Control': 'max-age=3600, no-cache',
        'Last-Modified': 'Thu, 01 Jan 2026 11:00:00 GMT',
      });
      expect(mustValidate.canStore, isTrue);
      expect(
        mustValidate.decision(now: _now),
        NativeDocumentCacheDecision.revalidate,
      );

      final doNotStore = _policy(<String, String>{
        'Cache-Control': 'private, max-age=3600, no-store',
        'ETag': '"v1"',
      });
      expect(doNotStore.canStore, isFalse);
      expect(doNotStore.decision(now: _now), NativeDocumentCacheDecision.fetch);
    });

    test('quoted commas and escaped quotes do not split directives', () {
      final policy = _policy(<String, String>{
        'Cache-Control':
            r'private="Set-Cookie, X-Foo", max-age="60", foo="a\",b"',
      });
      expect(policy.canStore, isTrue);
      expect(policy.decision(now: _now), NativeDocumentCacheDecision.fresh);
    });

    test('duplicate, malformed, or conflicting freshness is treated stale', () {
      for (final value in <String>[
        'max-age=60, max-age=60',
        'max-age=60, max-age=5',
        'max-age=sixty',
        'max-age="60',
        'max-age=60, no-cache',
      ]) {
        final policy = _policy(<String, String>{
          'Cache-Control': value,
          'ETag': '"v1"',
        });
        expect(
          policy.decision(now: _now),
          NativeDocumentCacheDecision.revalidate,
          reason: value,
        );
      }
    });

    test('sends both safe validators and omits malformed values', () {
      expect(
        _policy(<String, String>{
          'Cache-Control': 'no-cache',
          'ETag': 'W/"weak"',
          'Last-Modified': 'Thu, 01 Jan 2026 11:00:00 GMT',
        }).conditionalHeaders,
        <String, String>{
          'if-none-match': 'W/"weak"',
          'if-modified-since': 'Thu, 01 Jan 2026 11:00:00 GMT',
        },
      );
      expect(
        _policy(<String, String>{
          'Cache-Control': 'no-cache',
          'Last-Modified': 'Thu, 01 Jan 2026 11:00:00 GMT',
        }).conditionalHeaders,
        <String, String>{'if-modified-since': 'Thu, 01 Jan 2026 11:00:00 GMT'},
      );
      expect(
        _policy(<String, String>{
          'Cache-Control': 'no-cache',
          'ETag': '"v1"',
          'Last-Modified': 'not an HTTP date',
        }).conditionalHeaders,
        <String, String>{'if-none-match': '"v1"'},
      );
      expect(
        _policy(<String, String>{
          'Cache-Control': 'no-cache',
          'ETag': '"unsafe\r\nInjected: yes"',
          'Last-Modified': 'Thu, 01 Jan 2026 11:00:00 GMT',
        }).conditionalHeaders,
        <String, String>{'if-modified-since': 'Thu, 01 Jan 2026 11:00:00 GMT'},
      );
      expect(
        _policy(<String, String>{
          'Cache-Control': 'no-cache',
          'ETag': '"unsafe\r\nInjected: yes"',
        }).conditionalHeaders,
        isEmpty,
      );
    });

    test('matches supported Vary fields against original request values', () {
      final policy = _policy(
        <String, String>{
          'Cache-Control': 'max-age=3600',
          'Vary': 'Accept, Accept-Language',
        },
        requestHeaders: <String, String>{
          'accept': 'text/html, application/xhtml+xml',
          'Accept-Language': 'zh-TW,en;q=0.8',
        },
      );

      expect(policy.decision(now: _now), NativeDocumentCacheDecision.fresh);
      expect(
        policy.decision(
          now: _now,
          requestHeaders: <String, String>{
            'Accept': 'application/json',
            'Accept-Language': 'zh-TW,en;q=0.8',
          },
        ),
        NativeDocumentCacheDecision.fetch,
      );
    });

    test('matches Vary Origin when the native GET field is absent', () {
      final policy = _policy(<String, String>{
        'Cache-Control': 'max-age=3600',
        'Vary': 'Origin',
      });

      expect(policy.canStore, isTrue);
      expect(policy.varyFields, <String>['origin']);
      expect(policy.decision(now: _now), NativeDocumentCacheDecision.fresh);
      expect(
        policy.decision(
          now: _now,
          requestHeaders: <String, String>{'Accept': 'text/html'},
        ),
        NativeDocumentCacheDecision.fresh,
        reason: 'an omitted Origin remains absent on the next native GET',
      );
    });

    test(
      'a changed explicit Origin value cannot reuse a Vary Origin entry',
      () {
        final policy = _policy(
          <String, String>{'Cache-Control': 'max-age=3600', 'Vary': 'Origin'},
          requestHeaders: <String, String>{'Origin': 'https://gateway.example'},
        );

        expect(
          policy.decision(
            now: _now,
            requestHeaders: <String, String>{
              'origin': 'https://gateway.example',
            },
          ),
          NativeDocumentCacheDecision.fresh,
        );
        expect(
          policy.decision(
            now: _now,
            requestHeaders: <String, String>{'Origin': 'https://other.example'},
          ),
          NativeDocumentCacheDecision.fetch,
        );
      },
    );

    test('unknown Vary and Vary star cannot be reused', () {
      final unknown = _policy(<String, String>{
        'Cache-Control': 'max-age=3600',
        'Vary': 'User-Agent',
      });
      expect(unknown.canStore, isTrue);
      expect(unknown.decision(now: _now), NativeDocumentCacheDecision.fetch);

      final star = _policy(<String, String>{
        'Cache-Control': 'max-age=3600',
        'Vary': '*',
      });
      expect(star.canStore, isFalse);
      expect(star.varyFields, isEmpty);
      expect(star.decision(now: _now), NativeDocumentCacheDecision.fetch);
    });

    test(
      'private is allowed and s-maxage does not override private max-age',
      () {
        final policy = _policy(<String, String>{
          'Cache-Control': 'private, s-maxage=0, max-age=60',
        });
        expect(policy.canStore, isTrue);
        expect(policy.decision(now: _now), NativeDocumentCacheDecision.fresh);
      },
    );

    test(
      'reload ignores freshness and immutable but still validates if possible',
      () {
        final withValidator = _policy(<String, String>{
          'Cache-Control': 'max-age=3600, immutable',
          'ETag': '"v1"',
        });
        expect(
          withValidator.decision(now: _now, requestReload: true),
          NativeDocumentCacheDecision.revalidate,
        );

        final withoutValidator = _policy(<String, String>{
          'Cache-Control': 'max-age=3600, immutable',
        });
        expect(
          withoutValidator.decision(now: _now, requestReload: true),
          NativeDocumentCacheDecision.fetch,
        );
      },
    );

    test('only GET 2xx responses are storable by this document policy', () {
      expect(
        _policy(<String, String>{
          'Cache-Control': 'max-age=3600',
        }, method: 'POST').canStore,
        isFalse,
      );
      expect(
        _policy(<String, String>{
          'Cache-Control': 'max-age=3600',
        }, status: 404).canStore,
        isFalse,
      );
      expect(
        _policy(<String, String>{
          'Cache-Control': 'max-age=3600',
        }, status: 204).canStore,
        isTrue,
      );
    });
  });
}
