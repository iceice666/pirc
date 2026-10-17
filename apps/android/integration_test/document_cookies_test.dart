import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter/widgets.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:html/parser.dart' as html;
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/document_response_cache.dart';
import 'package:pirc_mobile/live/document_scripts.dart';
import 'package:pirc_mobile/live/gateway.dart';

const source = r'''<p id="result">WAITING</p><script>
(async () => {
  try {
    const before = document.cookie;
    document.cookie = 'script=one; Path=/';
    const immediate = document.cookie;
    const first = await (await fetch('/echo?stage=first')).json();
    const afterResponse = document.cookie;
    document.cookie = 'sequence=a; Path=/'; const p1 = fetch('/echo?stage=a');
    document.cookie = 'sequence=b; Path=/'; const p2 = fetch('/echo?stage=b');
    const sameTurn = await Promise.all([p1.then(r=>r.json()),p2.then(r=>r.json())]);
    const omitted = await (await fetch('/echo?stage=omit',{credentials:'omit'})).json();
    const afterOmit = document.cookie;
    history.pushState({}, '', '/outside/page');
    document.cookie = 'default_path=nested';
    document.cookie = 'outside_only=outside; Path=/outside';
    const afterPush = document.cookie;
    const outside = await (await fetch('/outside/echo')).json();
    const nested = await (await fetch('/nested/echo')).json();
    document.querySelector('#result').textContent = JSON.stringify({before,immediate,first,afterResponse,sameTurn,omitted,afterOmit,afterPush,outside,nested});
  } catch(error) { document.querySelector('#result').textContent = 'ERROR:'+error.message; }
})();</script>''';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'native cookies cover document, scripts, fetch, history, images and Vary cache',
    (t) async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final origin = 'http://127.0.0.1:${server.port}';
      final token = 'pirc_dev_${'A' * 43}';
      final receipts = <Json>[];
      final failures = <Object>[];
      var cacheRequests = 0;
      final listener = server.listen((request) async {
        try {
          final path = request.uri.path;
          final cookie = request.headers.value('cookie') ?? '';
          receipts.add({
            'path': path,
            'stage': request.uri.queryParameters['stage'],
            'cookie': cookie,
          });
          final response = request.response;
          if (path == '/api/sessions') {
            expect(request.headers.value('authorization'), 'Bearer $token');
            response.headers.contentType = ContentType.json;
            response.write('{"sessions":[]}');
          } else if (path == '/nested/page') {
            for (final cookie in [
              'server=plain; Path=/',
              'secret=synthetic-http-only; HttpOnly; Path=/',
              'nested=n; Path=/nested',
              'outside=o; Path=/outside',
            ]) {
              response.headers.add('set-cookie', cookie);
            }
            response.headers.contentType = ContentType.html;
            response.write(source);
          } else if (path == '/cross-seed') {
            response.headers.contentType = ContentType.html;
            response.headers.add(
              'set-cookie',
              'localhost_none=available; SameSite=None; Secure; Path=/',
            );
            response.write('<p>Cross-site cookie seeded</p>');
          } else if (path == '/image.png') {
            response.headers.contentType = ContentType('image', 'png');
            if (request.uri.queryParameters['cors'] == 'allow') {
              response.headers.set('access-control-allow-origin', origin);
              response.headers.set('access-control-allow-credentials', 'true');
            }
            response.add(
              base64Decode(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB4sAAAAASUVORK5CYII=',
              ),
            );
          } else if (path == '/media.wav') {
            response.headers.contentType = ContentType('audio', 'wav');
            final wav = Uint8List(44 + 8000)..fillRange(44, 8044, 128);
            final view = ByteData.sublistView(wav);
            wav.setRange(0, 4, ascii.encode('RIFF'));
            view.setUint32(4, wav.length - 8, Endian.little);
            wav.setRange(8, 16, ascii.encode('WAVEfmt '));
            view.setUint32(16, 16, Endian.little);
            view.setUint16(20, 1, Endian.little);
            view.setUint16(22, 1, Endian.little);
            view.setUint32(24, 8000, Endian.little);
            view.setUint32(28, 8000, Endian.little);
            view.setUint16(32, 1, Endian.little);
            view.setUint16(34, 8, Endian.little);
            wav.setRange(36, 40, ascii.encode('data'));
            view.setUint32(40, 8000, Endian.little);
            response.add(wav);
          } else if (path == '/style.css') {
            response.headers.contentType = ContentType('text', 'css');
            response.headers.add('set-cookie', 'style=accepted; Path=/');
            response.write('body { color: black; }');
          } else if (path == '/cache') {
            cacheRequests++;
            response.headers.set('vary', 'Cookie');
            response.headers.set('cache-control', 'max-age=600');
            response.headers.contentType = ContentType.html;
            if (cacheRequests == 1) {
              response.headers.add('set-cookie', 'cache_changed=one; Path=/');
            }
            response.write('<p>request=$cacheRequests</p>');
          } else if (path.endsWith('/echo')) {
            response.headers.contentType = ContentType.json;
            final stage = request.uri.queryParameters['stage'];
            if (stage == 'first') {
              response.headers.add(
                'set-cookie',
                'fetch_cookie=received; Path=/',
              );
            }
            if (stage == 'omit') {
              response.headers.add('set-cookie', 'omit_leak=blocked; Path=/');
            }
            response.write(jsonEncode({'cookie': cookie}));
          } else {
            throw StateError('Unexpected local request $path');
          }
          await response.close();
        } catch (error) {
          failures.add(error);
          request.response.statusCode = 500;
          await request.response.close();
        }
      });
      final gateway = Gateway();
      NativeDocumentScripts? scripts;
      try {
        await t.pumpWidget(const SizedBox());
        await gateway.call('pair', {
          'link': Uri(
            scheme: 'pirc',
            host: 'pair',
            queryParameters: {'url': origin, 'token': token},
          ).toString(),
        });
        final boot = obj(await gateway.call('boot'));
        final stamp = boot['pairingStamp'];
        final document = obj(
          await gateway.call('document', {
            'url': '$origin/nested/page',
            'method': 'GET',
            'pairingStamp': stamp,
          }),
        );
        expect(document['nativeSetCookieProcessed'], true);
        expect(
          '${document['headersRelevant']}',
          isNot(contains('synthetic-http-only')),
        );
        await gateway.call('document', {
          'url': '$origin/style.css',
          'method': 'GET',
          'resourceType': 'stylesheet',
          'initiatorUrl': '$origin/nested/page',
          'topLevelUrl': '$origin/nested/page',
          'pairingStamp': stamp,
        });
        scripts = NativeDocumentScripts(gateway);
        await scripts.start(
          source: utf8.decode(document['bytes'] as Uint8List),
          url: '$origin/nested/page',
        );
        String result() =>
            html
                .parse(scripts?.content?.text ?? '')
                .querySelector('#result')
                ?.text ??
            '';
        for (
          var i = 0;
          i < 300 &&
              !result().startsWith('{') &&
              !result().startsWith('ERROR:');
          i++
        ) {
          await t.pump(const Duration(milliseconds: 100));
        }
        expect(scripts.ready, true, reason: scripts.diagnostics.join(';'));
        expect(
          result(),
          startsWith('{'),
          reason: '${scripts.diagnostics} ${result()} $failures',
        );
        final data = obj(jsonDecode(result()));
        expect(data['before'], contains('server=plain'));
        expect(data['before'], contains('style=accepted'));
        expect(data['before'], isNot(contains('secret=')));
        expect(data['immediate'], contains('script=one'));
        expect(data['first']['cookie'], contains('secret=synthetic-http-only'));
        expect(data['first']['cookie'], contains('script=one'));
        expect(data['afterResponse'], contains('fetch_cookie=received'));
        for (final echo in data['sameTurn']) {
          expect(echo['cookie'], contains('sequence=b'));
        }
        expect(data['omitted']['cookie'], '');
        expect(data['afterOmit'], isNot(contains('omit_leak')));
        expect(data['afterPush'], contains('default_path=nested'));
        expect(data['afterPush'], isNot(contains('outside_only')));
        expect(data['outside']['cookie'], contains('outside_only=outside'));
        expect(data['outside']['cookie'], isNot(contains('default_path')));
        expect(data['nested']['cookie'], contains('default_path=nested'));
        final image = obj(
          await gateway.call('image', {
            'source': '$origin/image.png',
            'baseUrl': 'http://localhost:${server.port}/wrong-base',
            'documentUrl': '$origin/nested/page',
          }),
        );
        expect(image['bytes'], isNotEmpty);
        expect(receipts.last['cookie'], contains('secret=synthetic-http-only'));
        final media = obj(
          await gateway.call('htmlMediaOpen', {
            'source': '$origin/media.wav',
            'baseUrl': 'http://localhost:${server.port}/wrong-base',
            'documentUrl': '$origin/nested/page',
            'pairingStamp': stamp,
            'kind': 'audio',
            'muted': true,
            'loop': false,
          }),
        );
        try {
          expect(media['id'], isNotNull);
          expect(receipts.last['path'], '/media.wav');
          expect(
            receipts.last['cookie'],
            contains('secret=synthetic-http-only'),
          );
        } finally {
          await gateway.call('htmlMediaClose', {'id': media['id']});
        }
        final crossOrigin = 'http://localhost:${server.port}';
        await gateway.call('document', {
          'url': '$crossOrigin/cross-seed',
          'method': 'GET',
          'pairingStamp': stamp,
        });
        for (final mode in ['anonymous', 'use-credentials']) {
          await gateway.call('image', {
            'source': '$crossOrigin/image.png?cors=allow',
            'documentUrl': '$origin/nested/page',
            'crossOrigin': mode,
          });
          expect(
            receipts.last['cookie'],
            mode == 'anonymous' ? '' : 'localhost_none=available',
          );
        }
        await expectLater(
          gateway.call('image', {
            'source': '$crossOrigin/image.png?cors=block',
            'documentUrl': '$origin/nested/page',
            'crossOrigin': 'use-credentials',
          }),
          throwsA(isA<PlatformException>()),
        );
        final cache = NativeDocumentResponseCache(
          prepare: (args) async =>
              obj(await gateway.call('documentPrepareRequest', args)),
          fetch: (args) async => obj(await gateway.call('document', args)),
        );
        final args = <String, dynamic>{
          'url': '$origin/cache',
          'method': 'GET',
          'pairingStamp': stamp,
        };
        expect(
          (await cache.load(args, isCurrent: () => true))['cacheSource'],
          'network',
        );
        expect(
          (await cache.load(args, isCurrent: () => true))['cacheSource'],
          'network',
        );
        expect(
          (await cache.load(args, isCurrent: () => true))['cacheSource'],
          'fresh',
        );
        expect(cacheRequests, 2);
        expect(failures, isEmpty);
        debugPrint(
          'DOCUMENT_COOKIES: native HTTP + HttpOnly + synchronous setter + fetch response + credentials omit + same-turn b/b + pushState default path + stylesheet + image + media + CORS image credentials + Vary Cookie PASS',
        );
      } finally {
        scripts?.dispose();
        if (scripts != null) await scripts.closed;
        await gateway.call('unpair');
        await listener.cancel();
        await server.close(force: true);
      }
    },
  );
}
