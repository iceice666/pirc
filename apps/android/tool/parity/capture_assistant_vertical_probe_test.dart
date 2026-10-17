import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/assistant_settings.dart';
import 'package:pirc_mobile/live/gateway.dart';

import '../../test/live_test.dart' show FakeGateway, theme;
import 'capture_fonts.dart';

void main() {
  testWidgets('capture Assistant settings vertical layout at phone scale 2', (
    tester,
  ) async {
    final fixture =
        jsonDecode(
              File(
                '../../fixtures/mobile-parity/assistant-settings.json',
              ).readAsStringSync(),
            )
            as Map<String, dynamic>;
    await tester.runAsync(loadParityFonts);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 2500);
    addTearDown(tester.view.reset);

    final gateway = FakeGateway();
    final controller = LiveController(gateway);
    gateway.handler = (_, args) async => '${args['path']}'.endsWith('/node')
        ? fixture['binding']
        : fixture['prompts'];
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: theme.build(Brightness.light),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(2)),
          child: child!,
        ),
        home: Scaffold(
          body: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: AssistantSettings(controller: controller),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);

    Map<String, double> rect(Finder finder) {
      final value = tester.getRect(finder);
      return {
        'x': value.left,
        'y': value.top,
        'width': value.width,
        'height': value.height,
      };
    }

    Map<String, Object?> paragraphMetrics(
      Finder richTextFinder, {
      String? inlineCode,
    }) {
      final render = tester.renderObject<RenderParagraph>(richTextFinder);
      final fullText = render.text.toPlainText(includeSemanticsLabels: false);
      final codeStart = inlineCode == null ? -1 : fullText.indexOf(inlineCode);
      final codeBoxes = codeStart < 0
          ? const <TextBox>[]
          : render.getBoxesForSelection(
              TextSelection(
                baseOffset: codeStart,
                extentOffset: codeStart + inlineCode!.length,
              ),
            );
      final lineBoxes = render.getBoxesForSelection(
        TextSelection(baseOffset: 0, extentOffset: fullText.length),
      );
      final visualLines = <List<TextBox>>[];
      for (final box in lineBoxes.where((box) => box.bottom > box.top)) {
        final index = visualLines.indexWhere(
          (line) => line.any(
            (part) => box.top < part.bottom && box.bottom > part.top,
          ),
        );
        if (index < 0) {
          visualLines.add([box]);
        } else {
          visualLines[index].add(box);
        }
      }
      visualLines.sort((a, b) => a.first.top.compareTo(b.first.top));
      return {
        'rect': rect(richTextFinder),
        'plainText': fullText.replaceAll('\uFFFC', ''),
        'fontSize': render.text.style?.fontSize,
        'lineHeight': render.text.style?.height,
        'lineCount': visualLines.length,
        'inlineCodeBoxes': [
          for (final box in codeBoxes)
            {
              'left': box.left,
              'top': box.top,
              'right': box.right,
              'bottom': box.bottom,
            },
        ],
        'lineBoxes': [
          for (final line in visualLines)
            {
              'top': line.first.top,
              'boxes': [
                for (final box in line)
                  {'left': box.left, 'right': box.right, 'bottom': box.bottom},
              ],
            },
        ],
      };
    }

    final paragraphs = <Map<String, Object?>>[];
    for (final element in find.byType(AssistantParagraph).evaluate()) {
      final widget = element.widget as AssistantParagraph;
      final owner = find.byWidget(widget);
      final richText = find.descendant(
        of: owner,
        matching: find.byType(RichText),
      );
      final selectable = find.descendant(
        of: owner,
        matching: find.byType(SelectableText),
      );
      if (widget.text.isNotEmpty && richText.evaluate().isNotEmpty) {
        paragraphs.add({
          'text': widget.text,
          'inlineCode': widget.inlineCode,
          'metrics': paragraphMetrics(
            richText.first,
            inlineCode: widget.inlineCode,
          ),
        });
      } else if (widget.text.isNotEmpty && selectable.evaluate().isNotEmpty) {
        final editable = find.descendant(
          of: selectable.first,
          matching: find.byType(EditableText),
        );
        final state = tester.state<EditableTextState>(editable);
        final render = state.renderEditable;
        final painter = TextPainter(
          text: render.text,
          textDirection: render.textDirection,
          textScaler: render.textScaler,
          textAlign: render.textAlign,
          textWidthBasis: render.textWidthBasis,
          textHeightBehavior: render.textHeightBehavior,
          strutStyle: render.strutStyle,
        )..layout(maxWidth: render.size.width);
        final lines = painter.computeLineMetrics();
        final inlineCode = widget.inlineCode;
        final inlineCodeBoxes = inlineCode == null
            ? const <TextBox>[]
            : render.getBoxesForSelection(
                TextSelection(
                  baseOffset: widget.text.indexOf(inlineCode),
                  extentOffset:
                      widget.text.indexOf(inlineCode) + inlineCode.length,
                ),
              );
        paragraphs.add({
          'text': widget.text,
          'inlineCode': widget.inlineCode,
          'metrics': {
            'rect': {
              'x': render.localToGlobal(Offset.zero).dx,
              'y': render.localToGlobal(Offset.zero).dy,
              'width': render.size.width,
              'height': render.size.height,
            },
            'preferredLineHeight': painter.preferredLineHeight,
            'lineCount': lines.length,
            'inlineCodeBoxes': [
              for (final box in inlineCodeBoxes)
                {
                  'left': box.left,
                  'top': box.top,
                  'right': box.right,
                  'bottom': box.bottom,
                },
            ],
            'lines': [
              for (final line in lines)
                {
                  'width': line.width,
                  'height': line.height,
                  'ascent': line.ascent,
                  'descent': line.descent,
                  'unscaledAscent': line.unscaledAscent,
                  'baseline': line.baseline,
                },
            ],
          },
        });
      }
    }

    final managedMetrics =
        paragraphs.singleWhere(
              (paragraph) =>
                  paragraph['text'] ==
                  'Managed by Nix: edit services.pirc.chatPrompt.',
            )['metrics']!
            as Map<String, Object?>;
    final managedCodeBoxes =
        managedMetrics['inlineCodeBoxes']! as List<Map<String, Object?>>;
    expect(managedMetrics['lineCount'], 3);
    expect(managedCodeBoxes, hasLength(2));
    expect(managedCodeBoxes[0]['left'], closeTo(0, 1));
    expect(managedCodeBoxes[1]['left'], closeTo(0, 1));

    final nodeMetrics =
        paragraphs.singleWhere(
              (paragraph) =>
                  paragraph['text'] == 'Chat node: chat-node — online',
            )['metrics']!
            as Map<String, Object?>;
    final nodeCodeBoxes =
        nodeMetrics['inlineCodeBoxes']! as List<Map<String, Object?>>;
    expect(nodeCodeBoxes, hasLength(1));
    expect(nodeCodeBoxes.single['left'], greaterThan(0));

    final headings = <String, Map<String, double>>{};
    for (final title in ['Assistant', 'Soul', 'Chat rules']) {
      final text = find.byWidgetPredicate(
        (widget) => widget is Text && widget.data == title.toUpperCase(),
      );
      final richText = find.descendant(
        of: text,
        matching: find.byType(RichText),
      );
      if (text.evaluate().isNotEmpty && richText.evaluate().isNotEmpty) {
        headings[title] = rect(richText.first);
      }
    }

    final introButtons = <String, Map<String, double>>{};
    for (final label in ['Release chat node binding', 'Refresh']) {
      final button = find.descendant(
        of: find.byType(AssistantSection).first,
        matching: find.widgetWithText(TextButton, label),
      );
      if (button.evaluate().isNotEmpty) introButtons[label] = rect(button);
    }

    final editors = <String, Object?>{};
    for (final name in ['soul', 'chat']) {
      final field = find.byKey(ValueKey('assistant-$name-text'));
      final editor = find.ancestor(
        of: field,
        matching: find.byType(AssistantPromptEditor),
      );
      final title = name == 'soul' ? 'Soul' : 'Chat rules';
      final captionText = find.descendant(
        of: editor,
        matching: find.byWidgetPredicate(
          (widget) => widget is Text && widget.data == title,
        ),
      );
      final captionRichText = find.descendant(
        of: captionText,
        matching: find.byType(RichText),
      );
      final count = find.descendant(
        of: editor,
        matching: find.byWidgetPredicate(
          (widget) =>
              widget is Text && (widget.data?.endsWith(' characters') ?? false),
        ),
      );
      final countRichText = find.descendant(
        of: count,
        matching: find.byType(RichText),
      );
      final buttons = <String, Map<String, double>>{};
      for (final label in ['Revert', 'Save']) {
        buttons[label] = rect(
          find.descendant(
            of: editor,
            matching: find.widgetWithText(TextButton, label),
          ),
        );
      }
      editors[name] = {
        'field': rect(field),
        'caption': captionRichText.evaluate().isEmpty
            ? null
            : paragraphMetrics(captionRichText.first),
        'count': countRichText.evaluate().isEmpty
            ? null
            : paragraphMetrics(countRichText.first),
        'buttons': buttons,
      };
    }

    final output = {
      'viewport': {'width': 390, 'height': 2500, 'textScale': 2},
      'headings': headings,
      'introButtons': introButtons,
      'paragraphs': paragraphs,
      'editors': editors,
    };
    await tester.runAsync(() async {
      final file = File('build/parity/assistant-vertical-probe-native.json');
      file.parent.createSync(recursive: true);
      file.writeAsStringSync(
        const JsonEncoder.withIndent('  ').convert(output),
      );
    });

    await tester.pumpWidget(const SizedBox());
    controller.dispose();
    await gateway.stream.close();
  });
}
