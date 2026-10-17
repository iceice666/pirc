import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/conversation_composer.dart';
import '../../test/live_test.dart' show FakeGateway, theme;
import 'capture_fonts.dart';

void main() {
  for (final kind in ['composer', 'docks']) {
    for (final brightness in Brightness.values) {
      testWidgets('$kind shared fixture ${brightness.name}', (t) async {
        final fixture = obj(
          jsonDecode(
            File('../../fixtures/mobile-parity/$kind.json').readAsStringSync(),
          ),
        );
        await t.runAsync(loadParityFonts);
        t.view.devicePixelRatio = 1;
        t.view.physicalSize = Size(
          (fixture['width'] as num).toDouble(),
          (fixture['height'] as num).toDouble(),
        );
        addTearDown(t.view.reset);
        final g = FakeGateway(),
            c = LiveController(g)
              ..sessionId = 's'
              ..connection = 'live'
              ..control = {'held': true}
              ..preferences = obj(fixture['preferences'])
              ..state = obj(fixture['state'])
              ..models = rows(fixture['models'])
              ..attachments = rows(fixture['attachments']);
        final text = TextEditingController(text: '${fixture['draft']}');
        final key = GlobalKey();
        await t.pumpWidget(
          RepaintBoundary(
            key: key,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: theme.build(brightness),
              home: Scaffold(
                body: Column(
                  children: [
                    const Spacer(),
                    ConversationComposer(controller: c, text: text),
                  ],
                ),
              ),
            ),
          ),
        );
        await t.pumpAndSettle();
        expect(t.takeException(), isNull);
        await t.runAsync(() async {
          final capture =
              await (key.currentContext!.findRenderObject()
                      as RenderRepaintBoundary)
                  .toImage(pixelRatio: 1);
          final bytes = await capture.toByteData(
            format: ui.ImageByteFormat.png,
          );
          final dir = Directory('build/parity')..createSync(recursive: true);
          File(
            '${dir.path}/$kind-native-${brightness.name}.png',
          ).writeAsBytesSync(bytes!.buffer.asUint8List());
          capture.dispose();
        });
        await t.pumpWidget(const SizedBox());
        text.dispose();
        c.dispose();
        await g.stream.close();
      });
    }
  }
}
