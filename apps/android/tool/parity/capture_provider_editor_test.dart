import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/provider_editor.dart';
import '../../test/live_test.dart' show FakeGateway, theme;
import 'capture_fonts.dart';

void main() {
  for (final width in [390, 768]) {
    for (final brightness in Brightness.values) {
      testWidgets('provider editor $width ${brightness.name}', (t) async {
        final fixture = obj(
          jsonDecode(
            File(
              '../../fixtures/mobile-parity/provider-editor.json',
            ).readAsStringSync(),
          ),
        );
        await t.runAsync(loadParityFonts);
        t.view.devicePixelRatio = 1;
        t.view.physicalSize = Size(width.toDouble(), 1200);
        addTearDown(t.view.reset);
        final g = FakeGateway(), c = LiveController(g);
        final scroll = ScrollController();
        g.handler = (_, args) async => {'presets': fixture['presets'] ?? []};
        final key = GlobalKey();
        await t.pumpWidget(
          RepaintBoundary(
            key: key,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: theme.build(brightness),
              home: Scaffold(
                body: SingleChildScrollView(
                  controller: scroll,
                  padding: const EdgeInsets.all(24),
                  child: ProviderEditor(
                    controller: c,
                    provider: obj(
                      (obj(fixture['settings'])['providers'] as List).first,
                    ),
                    onSave: (_, _, _) async {},
                    onCancel: () {},
                  ),
                ),
              ),
            ),
          ),
        );
        await t.pumpAndSettle();
        for (final phase in ['collapsed', 'expanded', 'expanded-bottom']) {
          if (phase == 'expanded') {
            await t.tap(find.text('Details'));
            await t.pumpAndSettle();
            scroll.jumpTo(0);
            await t.pump();
          } else if (phase == 'expanded-bottom') {
            scroll.jumpTo(scroll.position.maxScrollExtent);
            await t.pump();
          }
          expect(t.takeException(), isNull);
          Map<String, double> rect(Finder finder) {
            final r = t.getRect(finder);
            return {
              'x': r.left,
              'y': r.top,
              'documentY': r.top + scroll.offset,
              'width': r.width,
              'height': r.height,
            };
          }

          final geometry = <String, dynamic>{
            'scrollY': scroll.offset,
            'card': rect(
              find
                  .descendant(
                    of: find.byType(ProviderEditor),
                    matching: find.byType(DecoratedBox),
                  )
                  .first,
            ),
            'summary': rect(find.widgetWithText(TextButton, 'Details')),
            'contentHeight': scroll.position.maxScrollExtent + 1200,
            'labels': {
              for (final label in [
                'Edit custom',
                'Backend ID',
                'API',
                'Base URL',
                'API key (optional)',
                'Models',
                'Details',
                'Model ID',
                if (phase != 'collapsed') ...[
                  'Display name',
                  'Context window (tokens)',
                  'Maximum output tokens',
                ],
              ])
                label: rect(find.text(label)),
            },
            'fields': {
              for (final id in [
                'provider-editor-id',
                'provider-editor-base-url',
                'provider-editor-api-key',
                'provider-editor-manual-model-id',
                if (phase != 'collapsed') ...[
                  'provider-model-local-model-name',
                  'provider-model-local-model-context',
                  'provider-model-local-model-max-tokens',
                ],
              ])
                id: rect(
                  find.descendant(
                    of: find.byKey(ValueKey(id)),
                    matching: find.byType(TextField),
                  ),
                ),
            },
            'buttons': {
              for (final label in [
                'Fetch models from endpoint',
                'Remove local-model',
                'Add model',
                'Test connection',
                'Save backend',
                'Cancel editing',
              ])
                label: rect(find.widgetWithText(TextButton, label)),
            },
          };
          await t.runAsync(() async {
            final capture =
                await (key.currentContext!.findRenderObject()
                        as RenderRepaintBoundary)
                    .toImage(pixelRatio: 1);
            final bytes = await capture.toByteData(
              format: ui.ImageByteFormat.png,
            );
            final dir = Directory('build/parity')..createSync(recursive: true);
            final name =
                '${dir.path}/provider-editor-native-$width-${brightness.name}-$phase';
            File('$name.png').writeAsBytesSync(bytes!.buffer.asUint8List());
            File('$name.json').writeAsStringSync(
              const JsonEncoder.withIndent('  ').convert(geometry),
            );
            capture.dispose();
          });
        }
        await t.pumpWidget(const SizedBox());
        scroll.dispose();
        c.dispose();
        await g.stream.close();
      });
    }
  }
}
