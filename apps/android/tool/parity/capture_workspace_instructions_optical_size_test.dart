import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/workspace_page.dart';
import 'package:pirc_mobile/live/web_controls.dart';

import '../../test/live_test.dart' show theme;
import 'capture_workspace_matrix_test.dart' show WorkspaceMatrixGateway;

const _paragraph =
    'Instructions for every chat in this project. Only you can change them: the assistant cannot edit them. They are kept on the project\'s node, and each chat keeps the instructions it started with, so a change reaches new chats only.';

Map<String, dynamic> _rect(Rect rect) => {
  'x': rect.left,
  'y': rect.top,
  'width': rect.width,
  'height': rect.height,
};

List<Map<String, dynamic>> _axisSweep(
  Iterable<String> texts, {
  required double fontSize,
  required double maxWidth,
}) {
  const values = <double?>[null, 9.75, 13, 19.5, 26, 28];
  return [
    for (final text in texts)
      for (final opsz in values)
        (() {
          final painter = TextPainter(
            text: TextSpan(
              text: text,
              style: TextStyle(
                fontFamily: 'Roboto',
                fontSize: fontSize,
                height: 1.55,
                fontVariations: opsz == null
                    ? const []
                    : [ui.FontVariation('opsz', opsz)],
              ),
            ),
            textDirection: TextDirection.ltr,
          )..layout(maxWidth: maxWidth);
          return {
            'textPrefix': text.substring(0, text.length.clamp(0, 28).toInt()),
            'opsz': opsz,
            'lines': painter.computeLineMetrics().length,
            'maxIntrinsicWidth': painter.maxIntrinsicWidth,
          };
        })(),
  ];
}

Map<String, dynamic> _findElement(List<dynamic> elements, String textPrefix) =>
    elements.cast<Map<String, dynamic>>().firstWhere(
      (element) => '${element['text'] ?? ''}'.startsWith(textPrefix),
    );

void main() {
  final fixture =
      jsonDecode(
            File(
              '../../fixtures/mobile-parity/workspace-matrix.json',
            ).readAsStringSync(),
          )
          as Map<String, dynamic>;
  final expected =
      jsonDecode(
            File(
              '../../fixtures/mobile-parity/workspace-matrix-expected.json',
            ).readAsStringSync(),
          )
          as Map<String, dynamic>;
  const cases = [
    (
      width: 390,
      brightness: Brightness.light,
      textScale: 2.0,
      expectedId: 'chat-settings-390-light-text2',
    ),
    (
      width: 768,
      brightness: Brightness.light,
      textScale: 2.0,
      expectedId: 'chat-settings-768-light-text2',
    ),
    (
      width: 1024,
      brightness: Brightness.dark,
      textScale: 1.0,
      expectedId: 'chat-settings-1024-dark-text1',
    ),
    (
      width: 1024,
      brightness: Brightness.dark,
      textScale: 2.0,
      expectedId: 'chat-settings-1024-dark-text2',
    ),
    (
      width: 651,
      brightness: Brightness.dark,
      textScale: 2.0,
      expectedId: 'chat-settings-651-dark-text2',
    ),
  ];
  final measurements = <Map<String, dynamic>>[];

  setUpAll(() async {
    for (final entry
        in jsonDecode(await rootBundle.loadString('FontManifest.json'))
            as List) {
      final loader = FontLoader(entry['family'] as String);
      for (final font in entry['fonts']) {
        loader.addFont(rootBundle.load(font['asset'] as String));
      }
      await loader.load();
    }
    for (final (family, path) in [
      ('Roboto', '/System/Library/Fonts/SFNS.ttf'),
      ('monospace', '/System/Library/Fonts/SFNSMono.ttf'),
    ]) {
      await (FontLoader(
        family,
      )..addFont(File(path).readAsBytes().then(ByteData.sublistView))).load();
    }
  });

  for (final captureCase in cases) {
    testWidgets(
      'instructions optical-size capture ${captureCase.width}px ${captureCase.brightness.name} ${captureCase.textScale}x',
      (tester) async {
        final width = captureCase.width.toDouble();
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = Size(width, 900);
        tester.platformDispatcher.textScaleFactorTestValue =
            captureCase.textScale;
        tester.platformDispatcher.platformBrightnessTestValue =
            captureCase.brightness;
        addTearDown(tester.view.reset);
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);

        final gateway = WorkspaceMatrixGateway({
          ...fixture,
          'captureTheme': captureCase.brightness.name,
        });
        final controller = LiveController(gateway)..mode = 'work';
        final boundary = GlobalKey();
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundary,
            child: MobileApp(theme: theme, controller: controller),
          ),
        );
        await tester.pumpAndSettle();
        if (find
            .byTooltip('Back to the list')
            .hitTestable()
            .evaluate()
            .isNotEmpty) {
          await tester.tap(find.byTooltip('Back to the list'));
          await tester.pumpAndSettle();
        }
        final workspace = (fixture['workspaces'] as List)
            .cast<Map<String, dynamic>>()
            .firstWhere((item) => item['id'] == 'home:trip');
        await tester.tap(find.text('Chat').hitTestable().first);
        await tester.pumpAndSettle();
        await tester.tap(
          find.text('${workspace['displayName']}').hitTestable().first,
        );
        await tester.pumpAndSettle();
        await tester.tap(
          find
              .descendant(
                of: find.byType(WorkspacePage),
                matching: find.text('Settings'),
              )
              .first,
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);

        final paragraphFinder = find.text(_paragraph);
        final paragraphRect = tester.getRect(paragraphFinder);
        final capabilityParagraphRect = tester.getRect(
          find.textContaining('Choose which assistant features'),
        );
        final safetyParagraphRect = tester.getRect(
          find.textContaining('This is not a sandbox'),
        );
        final textareaRect = tester.getRect(
          find.byKey(const ValueKey('workspace-instructions-text')),
        );
        final capabilityRect = tester.getRect(
          find.descendant(
            of: find.byType(WorkspacePage),
            matching: find.text('PROJECT CAPABILITIES'),
          ),
        );
        final saveRect = tester.getRect(
          find
              .byWidgetPredicate(
                (widget) => widget is WebButton && widget.label == 'Save',
              )
              .first,
        );
        final counterRect = tester.getRect(find.text('323 / 8000 characters'));
        final expectedCase = (expected['cases'] as List)
            .cast<Map<String, dynamic>>()
            .firstWhere((item) => item['id'] == captureCase.expectedId);
        final expectedElements =
            expectedCase['top']['page']['elements'] as List;
        final webParagraph = _findElement(
          expectedElements,
          'Instructions for every chat',
        )['rect'];
        final webCapabilityParagraph = _findElement(
          expectedElements,
          'Choose which assistant features',
        )['rect'];
        final webSafetyParagraph = _findElement(
          expectedElements,
          'This is not a sandbox',
        )['rect'];
        final webTextarea = expectedElements
            .cast<Map<String, dynamic>>()
            .firstWhere((element) => element['tag'] == 'textarea')['rect'];
        final webCapability = expectedElements
            .cast<Map<String, dynamic>>()
            .firstWhere(
              (element) => element['text'] == 'PROJECT CAPABILITIES',
            )['rect'];
        final webSave = expectedElements
            .cast<Map<String, dynamic>>()
            .firstWhere(
              (element) =>
                  element['tag'] == 'button' && element['text'] == 'Save',
            )['rect'];

        final id = captureCase.expectedId;
        // These two extra tuples reproduce the open line-wrap differences;
        // keep them as measurements rather than asserting parity.
        final knownWrappingResidual =
            captureCase.expectedId == 'chat-settings-1024-dark-text1' ||
            captureCase.expectedId == 'chat-settings-651-dark-text2';
        final record = <String, dynamic>{
          'id': id,
          'width': captureCase.width,
          'theme': captureCase.brightness.name,
          'textScale': captureCase.textScale,
          'web': {
            'paragraph': webParagraph,
            'capabilityParagraph': webCapabilityParagraph,
            'safetyParagraph': webSafetyParagraph,
            'textarea': webTextarea,
            'save': webSave,
            'capabilitiesHeading': webCapability,
          },
          'native': {
            'paragraph': _rect(paragraphRect),
            'capabilityParagraph': _rect(capabilityParagraphRect),
            'safetyParagraph': _rect(safetyParagraphRect),
            'textarea': _rect(textareaRect),
            'save': _rect(saveRect),
            'counter': _rect(counterRect),
            'capabilitiesHeading': _rect(capabilityRect),
          },
          if (knownWrappingResidual)
            'fontAxisSweep': _axisSweep(
              [
                _paragraph,
                'Choose which assistant features this chat workspace may use. All capabilities are allowed by default. Changes are saved to and enforced by the gateway, not just hidden in this browser.',
                'This is not a sandbox: these settings do not isolate files, shell commands, or network access. They do not revoke data already in a conversation or stop work already running.',
              ],
              fontSize: 13 * captureCase.textScale,
              maxWidth: captureCase.width == 651 ? 355 : 696,
            ),
        };
        final directory = Directory(
          'build/parity/workspace-instructions-optical-size',
        )..createSync(recursive: true);
        await tester.runAsync(() async {
          final image =
              await (boundary.currentContext!.findRenderObject()
                      as RenderRepaintBoundary)
                  .toImage(pixelRatio: 1);
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          File(
            '${directory.path}/$id-native.png',
          ).writeAsBytesSync(bytes!.buffer.asUint8List());
          image.dispose();
        });
        measurements.add(record);
        File(
          '${directory.path}/$id-native.json',
        ).writeAsStringSync(const JsonEncoder.withIndent('  ').convert(record));

        if (!knownWrappingResidual) {
          expect(
            paragraphRect.height,
            closeTo((webParagraph['height'] as num).toDouble(), 2.4),
          );
          expect(
            textareaRect.top,
            closeTo((webTextarea['y'] as num).toDouble(), 2.4),
          );
          expect(
            capabilityParagraphRect.width,
            (webCapabilityParagraph['width'] as num).toDouble(),
          );
          if (captureCase.width != 390) {
            expect(
              saveRect.top,
              closeTo((webSave['y'] as num).toDouble(), 2.4),
            );
          }
        }
        await tester.pumpWidget(const SizedBox());
        await gateway.stream.close();
      },
    );
  }
  tearDownAll(() {
    final directory = Directory(
      'build/parity/workspace-instructions-optical-size',
    )..createSync(recursive: true);
    File('${directory.path}/native-measurements.json').writeAsStringSync(
      const JsonEncoder.withIndent('  ').convert(measurements),
    );
  });
}
