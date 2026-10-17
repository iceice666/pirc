import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/assistant_settings.dart';
import '../../test/live_test.dart' show FakeGateway, theme;
import 'capture_fonts.dart';

void main() {
  for (final brightness in Brightness.values) {
    testWidgets('assistant settings shared fixture ${brightness.name}', (
      t,
    ) async {
      final fixture = obj(
        jsonDecode(
          File(
            '../../fixtures/mobile-parity/assistant-settings.json',
          ).readAsStringSync(),
        ),
      );
      await t.runAsync(loadParityFonts);
      const requestedWidth = int.fromEnvironment('PARITY_ASSISTANT_WIDTH');
      final textScale = double.parse(
        const String.fromEnvironment(
          'PARITY_ASSISTANT_SCALE',
          defaultValue: '1',
        ),
      );
      final width = requestedWidth == 0
          ? (fixture['width'] as num).toDouble()
          : requestedWidth.toDouble();
      final variant = width != fixture['width'] || textScale != 1;
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = Size(width, (fixture['height'] as num).toDouble());
      addTearDown(t.view.reset);
      final g = FakeGateway(),
          c = LiveController(g)..state = {'messages': fixture['messages']};
      g.handler = (_, args) async => '${args['path']}'.endsWith('/node')
          ? fixture['binding']
          : fixture['prompts'];
      final key = GlobalKey();
      await t.pumpWidget(
        RepaintBoundary(
          key: key,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: theme.build(brightness),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(
                context,
              ).copyWith(textScaler: TextScaler.linear(textScale)),
              child: child!,
            ),
            home: Scaffold(
              body: SingleChildScrollView(
                padding: const EdgeInsets.all(24),
                child: AssistantSettings(controller: c),
              ),
            ),
          ),
        ),
      );
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      final inputs = <String, dynamic>{};
      for (final name in ['soul', 'chat']) {
        final field = find.byKey(ValueKey('assistant-$name-text'));
        final state = t.state<EditableTextState>(
          find.descendant(of: field, matching: find.byType(EditableText)),
        );
        final render = state.renderEditable;
        final caret = render.getLocalRectForCaret(
          const TextPosition(offset: 0),
        );
        final box = t.getRect(field);
        final editor = find.ancestor(
          of: field,
          matching: find.byType(AssistantPromptEditor),
        );
        Map<String, double> rect(Finder finder) {
          final r = t.getRect(finder);
          return {
            'x': r.left,
            'y': r.top,
            'width': r.width,
            'height': r.height,
          };
        }

        inputs[name] = {
          'actions': {
            for (final label in ['Revert', 'Save'])
              label: rect(
                find.descendant(
                  of: editor,
                  matching: find.widgetWithText(TextButton, label),
                ),
              ),
            'count': rect(
              find.descendant(
                of: editor,
                matching: find.byWidgetPredicate(
                  (widget) =>
                      widget is Text &&
                      (widget.data?.endsWith(' characters') ?? false),
                ),
              ),
            ),
          },
          'x': box.left,
          'y': box.top,
          'width': box.width,
          'height': box.height,
          'caretInset': render.localToGlobal(caret.topLeft).dx - box.left,
          'editableHeight': render.size.height,
        };
      }
      for (final value in inputs.values) {
        expect(value['actions']['Revert']['height'], 36);
        expect(value['actions']['Save']['height'], 36);
      }
      if (width == 320 && textScale == 1) {
        for (final value in inputs.values) {
          expect(value['actions']['count']['height'], 30);
          expect(
            value['actions']['Save']['x'] + value['actions']['Save']['width'],
            296,
          );
        }
      }
      await t.runAsync(() async {
        final dir = Directory(
          variant
              ? 'build/parity/assistant-${width.toInt()}-scale${textScale.toInt()}'
              : 'build/parity',
        )..createSync(recursive: true);
        File(
          '${dir.path}/assistant-settings-native-inputs-${brightness.name}.json',
        ).writeAsStringSync(const JsonEncoder.withIndent('  ').convert(inputs));
        final capture =
            await (key.currentContext!.findRenderObject()
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 1);
        final bytes = await capture.toByteData(format: ui.ImageByteFormat.png);

        File(
          '${dir.path}/assistant-settings-native-${brightness.name}.png',
        ).writeAsBytesSync(bytes!.buffer.asUint8List());
        capture.dispose();
      });
      if (textScale > 1) {
        final editor = find.byType(AssistantPromptEditor).first;
        await t.ensureVisible(
          find.descendant(
            of: editor,
            matching: find.widgetWithText(TextButton, 'Revert'),
          ),
        );
        await t.pumpAndSettle();
        await t.runAsync(() async {
          final capture =
              await (key.currentContext!.findRenderObject()
                      as RenderRepaintBoundary)
                  .toImage(pixelRatio: 1);
          final bytes = await capture.toByteData(
            format: ui.ImageByteFormat.png,
          );
          File(
            'build/parity/assistant-${width.toInt()}-scale${textScale.toInt()}/assistant-settings-native-actions-${brightness.name}.png',
          ).writeAsBytesSync(bytes!.buffer.asUint8List());
          capture.dispose();
        });
      }
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    });
  }
}
