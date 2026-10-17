import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/provider_editor.dart';
import 'package:pirc_mobile/live/settings_dialog.dart';
import '../../test/live_test.dart' show FakeGateway, theme;
import 'capture_fonts.dart';

class _CaptureBinding extends AutomatedTestWidgetsFlutterBinding {
  @override
  bool get disableShadows => false;
}

void main() {
  _CaptureBinding();
  final textScale = double.parse(
    const String.fromEnvironment('PARITY_TEXT_SCALE', defaultValue: '1'),
  );
  final keyboard = double.parse(
    const String.fromEnvironment('PARITY_KEYBOARD_HEIGHT', defaultValue: '0'),
  );
  const recordKnownOverflow = bool.fromEnvironment(
    'PARITY_RECORD_KNOWN_OVERFLOW',
  );
  const fontFamily = String.fromEnvironment('PARITY_FONT_FAMILY');
  final suffix =
      (textScale == 1 && keyboard == 0
          ? ''
          : '-scale$textScale-keyboard$keyboard') +
      (fontFamily.isEmpty ? '' : '-font$fontFamily');
  for (final width in [390, 768]) {
    for (final brightness in Brightness.values) {
      testWidgets('provider editor dialog $width ${brightness.name}', (
        t,
      ) async {
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
        late ScrollController scroll;
        g.handler = (_, args) async {
          if (args['path'] == '/api/providers') return fixture['settings'];
          if (args['path'] == '/api/providers/presets') {
            return {'presets': fixture['presets'] ?? []};
          }
          return <String, dynamic>{};
        };
        final key = GlobalKey();
        final baseTheme = theme.build(brightness);
        final captureTheme = fontFamily.isEmpty
            ? baseTheme
            : baseTheme.copyWith(
                textTheme: baseTheme.textTheme.apply(fontFamily: fontFamily),
                primaryTextTheme: baseTheme.primaryTextTheme.apply(
                  fontFamily: fontFamily,
                ),
              );
        await t.pumpWidget(
          RepaintBoundary(
            key: key,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: captureTheme,
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context).copyWith(
                  textScaler: TextScaler.linear(textScale),
                  viewInsets: EdgeInsets.only(bottom: keyboard),
                ),
                child: child!,
              ),
              home: Scaffold(
                body: Builder(
                  builder: (context) => Center(
                    child: TextButton(
                      onPressed: () => showNativeSettings(
                        context,
                        controller: c,
                        onResetLayout: () {},
                        onOpenChat: (_) {},
                        onAppOptions: () {},
                        initialTab: 'Models',
                      ),
                      child: const Text('Open settings'),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        await t.pumpAndSettle();
        await t.tap(find.text('Open settings'));
        await t.pumpAndSettle();
        await t.ensureVisible(find.widgetWithText(TextButton, 'Edit custom'));
        await t.pumpAndSettle();
        await t.tap(find.widgetWithText(TextButton, 'Edit custom'));
        await t.pumpAndSettle();
        final panel = find
            .ancestor(
              of: find.byType(ProviderEditor),
              matching: find.byType(SingleChildScrollView),
            )
            .first;
        scroll = t.widget<SingleChildScrollView>(panel).controller!;
        scroll.jumpTo(0);
        await t.pumpAndSettle();
        for (final phase in [
          'collapsed',
          'expanded',
          'expanded-bottom',
          if (textScale != 1 || keyboard != 0) 'focused-base-url',
        ]) {
          if (phase == 'expanded') {
            await t.ensureVisible(find.text('Details'));
            await t.pumpAndSettle();
            await t.tap(find.text('Details'));
            await t.pumpAndSettle();
            scroll.jumpTo(0);
            await t.pump();
          } else if (phase == 'focused-base-url') {
            final input = find.descendant(
              of: find.byKey(const ValueKey('provider-editor-base-url')),
              matching: find.byType(TextField),
            );
            await t.showKeyboard(input);
            await t.ensureVisible(input);
            await t.pumpAndSettle();
          } else if (phase == 'expanded-bottom') {
            scroll.jumpTo(scroll.position.maxScrollExtent);
            await t.pump();
          }
          final layoutError = t.takeException();
          if (recordKnownOverflow &&
              width == 390 &&
              textScale == 2 &&
              layoutError != null) {
            // The same fixed-width browser model row overflows by 19.219px
            // under the controlled 2x text oracle. Record, do not hide, this state.
            expect(
              layoutError.toString(),
              'A RenderFlex overflowed by 19 pixels on the right.',
            );
          } else {
            expect(layoutError, isNull);
          }
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

          final inputState = t.state<EditableTextState>(
            find.descendant(
              of: find.byKey(const ValueKey('provider-editor-base-url')),
              matching: find.byType(EditableText),
            ),
          );
          final inputRender = inputState.renderEditable;
          final inputOrigin = inputRender.localToGlobal(Offset.zero);
          final startCaret = inputRender.getLocalRectForCaret(
            const TextPosition(offset: 0),
          );
          final geometry = <String, dynamic>{
            'inputTypography': {
              'family': inputState.widget.style.fontFamily,
              'weight': inputState.widget.style.fontWeight?.value,
              'size': inputState.widget.style.fontSize,
              'editableX': inputOrigin.dx,
              'caretStartX': inputOrigin.dx + startCaret.left,
              'editableHeight': inputRender.size.height,
            },
            'layoutErrors': [if (layoutError != null) layoutError.toString()],
            'textScale': textScale,
            'keyboardHeight': keyboard,
            'scrollY': scroll.offset,
            'frame': rect(find.byKey(const Key('settings-frame'))),
            'panel': rect(panel),
            'card': rect(
              find
                  .descendant(
                    of: find.byType(ProviderEditor),
                    matching: find.byType(DecoratedBox),
                  )
                  .first,
            ),
            'summary': rect(find.widgetWithText(TextButton, 'Details')),
            'contentHeight':
                scroll.position.maxScrollExtent +
                scroll.position.viewportDimension,
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
                label: rect(
                  find.descendant(
                    of: find.byType(ProviderEditor),
                    matching: find.text(label),
                  ),
                ),
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
                '${dir.path}/provider-editor-dialog-native-$width-${brightness.name}-$phase$suffix';
            File('$name.png').writeAsBytesSync(bytes!.buffer.asUint8List());
            File('$name.json').writeAsStringSync(
              const JsonEncoder.withIndent('  ').convert(geometry),
            );
            capture.dispose();
          });
        }
        await t.pumpWidget(const SizedBox());
        c.dispose();
        await g.stream.close();
      });
    }
  }
}
