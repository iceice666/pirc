import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/assistant_settings.dart';
import 'package:pirc_mobile/live/gateway.dart';
import '../../test/live_test.dart' show FakeGateway, theme;
import 'capture_fonts.dart';

void main() {
  testWidgets('assistant editor font and wrapping probe', (tester) async {
    final fixture =
        jsonDecode(
              File(
                '../../fixtures/mobile-parity/assistant-settings.json',
              ).readAsStringSync(),
            )
            as Map<String, dynamic>;
    await tester.runAsync(loadParityFonts);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 1150);
    addTearDown(tester.view.reset);

    final gateway = FakeGateway();
    final controller = LiveController(gateway)
      ..state = {'messages': fixture['messages']};
    gateway.handler = (_, args) async => '${args['path']}'.endsWith('/node')
        ? fixture['binding']
        : fixture['prompts'];

    final result = <String, dynamic>{
      'viewport': {'width': 390, 'height': 1150, 'devicePixelRatio': 1},
      'textScale': 2,
      'phrase': 'Be curious and precise.',
      'fontAliases': <String, dynamic>{},
      'captures': <String, dynamic>{},
    };

    for (final family in ['Arial', 'Roboto', 'Ahem']) {
      final byWeight = <String, dynamic>{};
      for (final weight in [FontWeight.w400, FontWeight.w500]) {
        final noScale = _measure(
          family: family,
          weight: weight,
          fontSize: 32,
          scaler: TextScaler.noScaling,
        );
        final scaled16 = _measure(
          family: family,
          weight: weight,
          fontSize: 16,
          scaler: TextScaler.linear(2),
        );
        byWeight['w${weight.value}'] = {
          'fontSize32NoScale': noScale,
          'fontSize16Scale2': scaled16,
        };
      }
      result['fontAliases'][family] = byWeight;
    }

    final baseTheme = theme.build(Brightness.light);
    for (final variant in ['platformTheme', 'forcedArialTheme']) {
      final selectedTheme = variant == 'forcedArialTheme'
          ? baseTheme.copyWith(
              textTheme: baseTheme.textTheme.apply(fontFamily: 'Arial'),
            )
          : baseTheme;
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: selectedTheme,
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

      final fields = <String, dynamic>{};
      for (final name in ['soul', 'chat']) {
        final field = find.byKey(ValueKey('assistant-$name-text'));
        final editableFinder = find.descendant(
          of: field,
          matching: find.byType(EditableText),
        );
        final state = tester.state<EditableTextState>(editableFinder);
        final element = tester.element(field);
        final scaler = MediaQuery.textScalerOf(element);
        final render = state.renderEditable;
        final span = render.text!;
        final phrase = result['phrase'] as String;
        final firstLineSelection = TextSelection(
          baseOffset: 0,
          extentOffset: phrase.length,
        );
        final firstLineBoxes = render.getBoxesForSelection(firstLineSelection);
        final actualPainter = TextPainter(
          text: span,
          textDirection: TextDirection.ltr,
          textScaler: scaler,
        )..layout(maxWidth: render.size.width);
        final phrasePainter = TextPainter(
          text: TextSpan(text: phrase, style: state.widget.style),
          textDirection: TextDirection.ltr,
          textScaler: scaler,
        )..layout();
        fields[name] = {
          'fieldRect': _rect(tester.getRect(field)),
          'renderEditableSize': {
            'width': render.size.width,
            'height': render.size.height,
          },
          'editableTextStyle': _style(state.widget.style),
          'renderedTextSpan': _span(span),
          'plainText': span.toPlainText(),
          'actualRenderEditableFirstLineSelection': {
            'text': state.widget.controller.text.substring(
              firstLineSelection.start,
              firstLineSelection.end,
            ),
            'selection': {
              'start': firstLineSelection.start,
              'end': firstLineSelection.end,
            },
            'boxes': [
              for (final box in firstLineBoxes)
                {
                  'left': box.left,
                  'top': box.top,
                  'right': box.right,
                  'bottom': box.bottom,
                  'width': box.right - box.left,
                  'height': box.bottom - box.top,
                  'direction': box.direction.name,
                },
            ],
          },
          'actualEditableParagraph': _paragraph(actualPainter),
          'phraseUsingEditableStyle': _paragraph(phrasePainter),
          'textScaler': scaler.toString(),
          'scaledEditableFontSize': scaler.scale(
            state.widget.style.fontSize ?? 0,
          ),
        };
      }
      result['captures'][variant] = {
        'themeBodyMediumFontFamily':
            selectedTheme.textTheme.bodyMedium?.fontFamily,
        'fields': fields,
      };
    }

    await tester.runAsync(() async {
      final output = File('build/parity/assistant-font-probe-native.json');
      output.parent.createSync(recursive: true);
      output.writeAsStringSync(
        const JsonEncoder.withIndent('  ').convert(result),
      );
    });

    await tester.pumpWidget(const SizedBox());
    controller.dispose();
    await gateway.stream.close();
  });
}

Map<String, Object?> _measure({
  required String family,
  required FontWeight weight,
  required double fontSize,
  required TextScaler scaler,
}) {
  final painter = TextPainter(
    text: TextSpan(
      text: 'Be curious and precise.',
      style: TextStyle(
        fontFamily: family,
        fontSize: fontSize,
        fontWeight: weight,
      ),
    ),
    textDirection: TextDirection.ltr,
    textScaler: scaler,
  )..layout();
  return {
    'fontFamily': family,
    'weight': weight.toString(),
    'fontSize': fontSize,
    'effectiveFontSize': scaler.scale(fontSize),
    ..._paragraph(painter),
  };
}

Map<String, Object?> _paragraph(TextPainter painter) => {
  'width': painter.width,
  'height': painter.height,
  'lineCount': painter.computeLineMetrics().length,
  'lines': [
    for (final line in painter.computeLineMetrics())
      {'width': line.width, 'height': line.height, 'baseline': line.baseline},
  ],
};

Map<String, Object?> _style(TextStyle? style) => {
  'fontFamily': style?.fontFamily,
  'fontFamilyFallback': style?.fontFamilyFallback,
  'fontSize': style?.fontSize,
  'fontWeight': style?.fontWeight?.toString(),
  'fontWeightValue': style?.fontWeight?.value,
  'height': style?.height,
  'letterSpacing': style?.letterSpacing,
  'wordSpacing': style?.wordSpacing,
  'fontStyle': style?.fontStyle?.name,
  'inherit': style?.inherit,
};

Map<String, Object?> _span(InlineSpan span) {
  if (span is! TextSpan) return {'type': span.runtimeType.toString()};
  return {
    'type': 'TextSpan',
    'text': span.text,
    'style': _style(span.style),
    'children': [
      for (final child in span.children ?? const <InlineSpan>[]) _span(child),
    ],
  };
}

Map<String, double> _rect(Rect rect) => {
  'x': rect.left,
  'y': rect.top,
  'width': rect.width,
  'height': rect.height,
};
