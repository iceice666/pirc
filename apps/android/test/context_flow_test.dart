import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/context_pane.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'live_test.dart' show FakeGateway, theme;
import '../tool/parity/capture_fonts.dart' show loadParityFonts;

void main() {
  for (final scale in [1.0, 2.0]) {
    testWidgets('Context UA margin flow matches pinned source at 650px/$scale', (
      t,
    ) async {
      await t.runAsync(loadParityFonts);
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = const Size(650, 1200);
      addTearDown(t.view.reset);
      final fixture =
          jsonDecode(
                File(
                  '../../fixtures/mobile-parity/side-panel.json',
                ).readAsStringSync(),
              )
              as Map;
      final reference =
          jsonDecode(
                File(
                  '../../fixtures/mobile-parity/context-flow-expected.json',
                ).readAsStringSync(),
              )
              as Map;
      final caseId = '650-context-light-scale${scale.toInt()}';
      final expected = (reference['cases'] as Map)[caseId] as Map;
      final paneTop = (expected['activePanelRectY'] as num).toDouble();
      final gateway = FakeGateway();
      gateway.handler = (_, _) async => fixture['context'];
      final controller = LiveController(gateway)..sessionId = 's';
      await t.pumpWidget(
        MaterialApp(
          theme: theme
              .build(Brightness.light)
              .copyWith(
                textTheme: theme
                    .build(Brightness.light)
                    .textTheme
                    .apply(fontFamily: 'Arial'),
              ),
          home: MediaQuery(
            data: MediaQueryData(
              size: const Size(650, 1200),
              textScaler: TextScaler.linear(scale),
            ),
            child: Scaffold(
              body: ContextPane(controller: controller, onFile: (_) {}),
            ),
          ),
        ),
      );
      await t.pumpAndSettle();
      final nodes = expected['textNodes'] as List;
      for (final label in ['Context', 'Saved snapshot', 'System sections']) {
        final source =
            nodes.firstWhere((node) => node['label'] == label) as Map;
        final target = label == 'Saved snapshot'
            ? find.textContaining(label)
            : find.text(label);
        final y = t.getTopLeft(target).dy;
        // Source stale <p> has 8px content padding; other source nodes are text boxes.
        final sourceY =
            (source['rectY'] as num).toDouble() -
            paneTop +
            (label == 'Saved snapshot' ? 8 : 0);
        expect(y, closeTo(sourceY, 1), reason: '$label at $scale');
      }
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    });
  }
}
