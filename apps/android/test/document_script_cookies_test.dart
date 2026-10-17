import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/document_scripts.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'document_script_resources_test.dart' as resources;

class CookieGateway extends resources.ResourceGateway {
  bool failCookies = false;
  String canonicalValue = 'native';
  Json get seed => {
    'generation': 7,
    'revision': 1,
    'url': 'https://example.test/nested/page',
    'secureOrigin': true,
    'sameSiteContext': true,
    'cookies': [
      {
        'name': 'visible',
        'value': canonicalValue,
        'domain': 'example.test',
        'path': '/',
        'hostOnly': true,
        'secure': false,
        'sameSite': 'default',
        'creationOrder': 1,
      },
    ],
    'protections': [],
    'allowedDomainSuffixes': ['example.test'],
  };
  @override
  Future<dynamic> call(String method, [Json args = const {}]) async {
    if (method == 'documentScriptOpen') {
      calls.add((method, args));
      return {'id': 42, 'cookieState': seed};
    }
    if (method == 'documentScriptCookies') {
      calls.add((method, args));
      if (failCookies) throw StateError('Cookie scope retired');
      return seed;
    }
    final result = await super.call(method, args);
    if (method == 'documentScriptEvaluate' &&
        '${args['source']}'.startsWith('__pircDocument.init(')) {
      return {
        'value': jsonEncode({
          ...obj(jsonDecode(result['value'] as String)),
          'cookieWrites': [
            {
              'url': 'https://example.test/nested/page',
              'line': 'js=one; Path=/',
              'generation': 7,
            },
          ],
        }),
      };
    }
    return result;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'initial cookie writes are canonicalized before any resource starts',
    () async {
      final g = CookieGateway()..requests = [resources.request('fetch-1')];
      final state = NativeDocumentScripts(
        g,
        loadRuntime: () async => 'runtime',
      );
      try {
        await state.start(source: '', url: 'https://example.test/nested/page');
        await resources.settle();
        expect(state.ready, true);
        final flush = g.calls.indexWhere(
          (c) =>
              c.$1 == 'documentScriptCookies' &&
              (c.$2['writes'] as List).isNotEmpty,
        );
        final sync = g.calls.indexWhere(
          (c) =>
              c.$1 == 'documentScriptEvaluate' &&
              '${c.$2['source']}'.startsWith('__pircDocument.syncCookies('),
        );
        final request = g.calls.indexWhere(
          (c) => c.$1 == 'documentScriptResource',
        );
        expect(flush, greaterThan(-1));
        expect(sync, greaterThan(flush));
        expect(request, greaterThan(sync));
        expect(g.calls[flush].$2['writes'], [
          {
            'url': 'https://example.test/nested/page',
            'line': 'js=one; Path=/',
            'generation': 7,
          },
        ]);
      } finally {
        state.dispose();
        await state.closed;
      }
    },
  );
  test(
    'fetch completion refreshes native response cookies before JS callback',
    () async {
      final g = CookieGateway()..requests = [resources.request('fetch-1')];
      final state = NativeDocumentScripts(
        g,
        loadRuntime: () async => 'runtime',
      );
      try {
        await state.start(source: '', url: 'https://example.test/nested/page');
        await resources.settle();
        final before = g.calls.length;
        g.canonicalValue = 'set-by-response';
        g.pending['fetch-1']!.complete(resources.response('complete'));
        await resources.settle();
        final calls = g.calls.skip(before).toList();
        final fresh = calls.indexWhere((c) => c.$1 == 'documentScriptCookies');
        final sync = calls.indexWhere(
          (c) =>
              c.$1 == 'documentScriptEvaluate' &&
              '${c.$2['source']}'.startsWith('__pircDocument.syncCookies('),
        );
        final callback = calls.indexWhere(
          (c) =>
              c.$1 == 'documentScriptEvaluate' &&
              '${c.$2['source']}'.startsWith(
                '__pircDocument.completeResource(',
              ),
        );
        expect(fresh, greaterThan(-1));
        expect(sync, greaterThan(fresh));
        expect(callback, greaterThan(sync));
        expect('${calls[sync].$2['source']}', contains('set-by-response'));
      } finally {
        state.dispose();
        await state.closed;
      }
    },
  );
  test(
    'retired cookie scope fails visibly and does not launch queued HTTP work',
    () async {
      final g = CookieGateway()
        ..failCookies = true
        ..requests = [resources.request('fetch-1')];
      final state = NativeDocumentScripts(
        g,
        loadRuntime: () async => 'runtime',
      );
      try {
        await state.start(source: '', url: 'https://example.test/nested/page');
        expect(state.ready, false);
        expect(state.diagnostics.join(), contains('Cookie scope retired'));
        expect(g.calls.where((c) => c.$1 == 'documentScriptResource'), isEmpty);
        expect(
          g.calls.where((c) => c.$1 == 'documentScriptClose'),
          hasLength(1),
        );
      } finally {
        state.dispose();
        await state.closed;
      }
    },
  );
}
