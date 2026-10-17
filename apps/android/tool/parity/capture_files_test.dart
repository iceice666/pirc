import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/files_pane.dart';
import '../../test/live_test.dart' show FakeGateway, theme;
import 'capture_fonts.dart';

void main() {
  final fixture = obj(
    jsonDecode(
      File('../../fixtures/mobile-parity/files.json').readAsStringSync(),
    ),
  );
  for (final view in fixture['views']) {
    for (final brightness in Brightness.values) {
      testWidgets('files $view ${brightness.name}', (t) async {
        await t.runAsync(loadParityFonts);
        debugDisableShadows = false;
        t.view.devicePixelRatio = 1;
        t.view.physicalSize = Size(
          (fixture['width'] as num).toDouble(),
          (fixture['height'] as num).toDouble(),
        );
        addTearDown(t.view.reset);
        final g = FakeGateway(), c = LiveController(g)..sessionId = 's';
        final file = obj(obj(fixture['files'])[view]);
        g.handler = (_, args) async => '${args['path']}'.contains('/content')
            ? file
            : fixture['directory'];
        final key = GlobalKey();
        await t.pumpWidget(
          RepaintBoundary(
            key: key,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: theme.build(brightness),
              home: Scaffold(
                body: FilesPane(
                  controller: c,
                  initialPath: file.isEmpty
                      ? ''
                      : '${file['path']}${view == 'source' ? '#L2-L4' : ''}',
                ),
              ),
            ),
          ),
        );
        await t.pumpAndSettle();
        await t.runAsync(() async {
          await Future<void>.delayed(const Duration(milliseconds: 150));
        });
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
            '${dir.path}/files-native-$view-${brightness.name}.png',
          ).writeAsBytesSync(bytes!.buffer.asUint8List());
          capture.dispose();
        });
        await t.pumpWidget(const SizedBox());
        c.dispose();
        await g.stream.close();
        debugDisableShadows = true;
      });
    }
  }
}
