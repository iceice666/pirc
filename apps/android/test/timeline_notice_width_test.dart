import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/conversation_timeline.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'live_test.dart' show FakeGateway, theme;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    // Use the app's Android font metrics, rather than Ahem's square glyphs.
    await (FontLoader('Roboto')..addFont(
          File(
            'tool/parity/vendor/canvas-text-fixture-font/Roboto-Regular.ttf',
          ).readAsBytes().then(ByteData.sublistView),
        ))
        .load();
  });
  for (final width in [320.0, 390.0, 768.0]) {
    for (final scale in [1.0, 1.3]) {
      for (final brightness in [Brightness.light, Brightness.dark]) {
        testWidgets(
          'complete stopped-turn warning at $width scale$scale $brightness',
          (t) async {
            t.view.devicePixelRatio = 1;
            t.view.physicalSize = Size(width, 600);
            addTearDown(t.view.reset);
            final g = FakeGateway(), c = LiveController(g);
            const warning = 'Stopped after 200 turns';
            c.state = {
              'messages': [
                {
                  'id': 'stopped',
                  'role': 'system',
                  'systemKind': 'notice',
                  'level': 'warning',
                  'label': 'Warning',
                  'content': warning,
                  'createdAt': '2026-10-20T08:25:00Z',
                },
              ],
            };
            try {
              await t.pumpWidget(
                MaterialApp(
                  theme: theme.build(brightness),
                  builder: (context, child) => MediaQuery(
                    data: MediaQuery.of(
                      context,
                    ).copyWith(textScaler: TextScaler.linear(scale)),
                    child: child!,
                  ),
                  home: Scaffold(
                    body: SingleChildScrollView(
                      padding: const EdgeInsets.all(14),
                      child: ConversationTimeline(controller: c),
                    ),
                  ),
                ),
              );
              await t.pumpAndSettle();
              final text = find.descendant(
                of: find.text(warning),
                matching: find.byType(RichText),
              );
              final paragraph = t.renderObject<RenderParagraph>(text);
              expect(
                paragraph.didExceedMaxLines,
                isFalse,
                reason:
                    'The entire warning fits in the available timeline width.',
              );
              expect(t.takeException(), isNull);
            } finally {
              await t.pumpWidget(const SizedBox.shrink());
              c.dispose();
              await g.stream.close();
            }
          },
        );
      }
    }
  }
}
