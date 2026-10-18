import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show debugPrintSynchronously;
import 'package:flutter_test/flutter_test.dart';
import 'package:html/parser.dart' as html;
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/document_navigation.dart';
import 'package:pirc_mobile/live/document_navigation_state.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/rendering/html_document_content.dart';
import 'package:pirc_mobile/theme.dart';

const fixtureOrigin = String.fromEnvironment('PIRC_CHART_FIXTURE_ORIGIN');
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'ordered native scroll execution matches Chromium settled positions',
    (tester) async {
      final origin = Uri.parse(fixtureOrigin);
      expect(origin.host, '127.0.0.1');
      expect(origin.scheme, 'http');
      final client = HttpClient();
      late Json fixture;
      try {
        final response = await (await client.getUrl(
          origin.resolve('/scroll-commands.json'),
        )).close();
        expect(response.statusCode, 200);
        fixture = obj(jsonDecode(await utf8.decoder.bind(response).join()));
      } finally {
        client.close(force: true);
      }
      expect(fixture['browserVersion'], '153.0.8010.12');
      expect(fixture['cases'], hasLength(160));
      final gateway = Gateway(),
          theme = await PircTheme.load(),
          accepted = <Json>[];
      for (final raw in fixture['cases'] as List) {
        final row = obj(raw),
            viewport = obj(row['viewport']),
            dpr = (row['dpr'] as num).toDouble();
        tester.view.devicePixelRatio = dpr;
        tester.view.physicalSize =
            Size(
              (viewport['width'] as num).toDouble(),
              (viewport['height'] as num).toDouble(),
            ) *
            dpr;
        final source = (fixture['html'] as String).replaceFirst(
              '</body>',
              '<script>${row['driverSource']}</script></body>',
            ),
            bytes = utf8.encode(source);
        final document = NativeFetchedDocument(
          id: 1,
          url: 'https://example.test/scroll-commands',
          status: 200,
          bytes: bytes,
          mimeType: 'text/html',
          content: NativeHtmlDocumentContent.fromBytes(
            bytes,
            mimeType: 'text/html',
            charset: 'utf-8',
          ),
          headers: {},
        );
        try {
          await tester.pumpWidget(
            MaterialApp(
              theme: theme.build(
                row['theme'] == 'dark' ? Brightness.dark : Brightness.light,
              ),
              home: Scaffold(
                body: NativeFetchedDocumentView(
                  document: document,
                  gateway: gateway,
                  onLink: (_) {},
                  onSubmit: (_) {},
                ),
              ),
            ),
          );
          for (var attempt = 0; attempt < 200; attempt++) {
            await tester.pump(const Duration(milliseconds: 30));
            if (document.scripts?.ready == true) {
              break;
            }
          }
          expect(
            document.scripts?.ready,
            isTrue,
            reason: '${document.scripts?.diagnostics}',
          );
          await tester.pump(const Duration(milliseconds: 30));
          await tester.tap(find.text('Run', findRichText: true));
          Json report = {};
          for (var attempt = 0; attempt < 250; attempt++) {
            await tester.pump(const Duration(milliseconds: 30));
            final text =
                html
                    .parse(document.scripts?.content?.text ?? '')
                    .getElementById('probe')
                    ?.text ??
                '';
            if (text.startsWith('{')) {
              report = obj(jsonDecode(text));
              break;
            }
          }
          expect(
            report,
            isNotEmpty,
            reason:
                '${row['mode']} ${row['target']} ${document.scripts?.diagnostics}',
          );
          final expected = obj(obj(row['result'])['settled']),
              actual = obj(report['settled']);
          for (final target in ['root', 'element']) {
            for (final axis in ['left', 'top']) {
              expect(
                obj(actual[target])[axis],
                closeTo((obj(expected[target])[axis] as num).toDouble(), .01),
                reason: '${row['mode']} ${row['target']} $target.$axis',
              );
            }
          }
          expect(document.scripts!.diagnostics, isEmpty);
          expect(tester.takeException(), isNull);
          // Preserve synchronous-read differences as evidence; they are a separate
          // remaining gate, never certified by these settled-position assertions.
          accepted.add({
            'mode': row['mode'],
            'target': row['target'],
            'viewport': viewport,
            'dpr': dpr,
            'theme': row['theme'],
            'settled': actual,
            'immediate': report['immediate'],
            'browserImmediate': obj(row['result'])['immediate'],
          });
          if (accepted.length % 20 == 0) {
            debugPrintSynchronously(
              'PIRC_SCROLL_COMMAND_PROGRESS ${accepted.length}/160',
            );
          }
        } finally {
          await tester.pumpWidget(const SizedBox());
          document.dispose();
          if (document.scripts != null) {
            await document.scripts!.closed;
          }
          tester.view.reset();
        }
      }
      debugPrintSynchronously(
        'PIRC_NATIVE_SCROLL_COMMAND_ACCEPTANCE ${jsonEncode(accepted)}',
      );
    },
    skip: fixtureOrigin.isEmpty,
  );
}
