import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/timeline_attachment_image.dart';
import 'package:pirc_mobile/live/timeline_tools.dart';
import '../../test/live_test.dart' show FakeGateway, theme;
import '../../test/timeline_images_test.dart'
    show timelineImageFixture, timelineSvg, awaitTimelineImages;
import 'capture_fonts.dart';

void main() {
  final reference = obj(
    jsonDecode(
      File(
        '../../fixtures/mobile-parity/timeline-image-expected.json',
      ).readAsStringSync(),
    ),
  );
  final results = <Json>[];
  for (final config in rows(reference['cases'])) {
    testWidgets('timeline image rows ${config['width']} ${config['theme']}', (
      t,
    ) async {
      final width = (config['width'] as num).toDouble();
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = Size(width, 900);
      addTearDown(t.view.reset);
      await t.runAsync(() async {
        await loadParityFonts();
        await (FontLoader('TimelineParitySystem')..addFont(
              File(
                '/System/Library/Fonts/SFNS.ttf',
              ).readAsBytes().then(ByteData.sublistView),
            ))
            .load();
      });
      final g = FakeGateway(), pending = Completer<Json>();
      g.handler = (_, args) async {
        final source = '${args['source']}';
        if (source.contains('pending')) return pending.future;
        if (source.contains('broken') || source.contains('invalid')) {
          throw StateError('Fixture image unavailable');
        }
        return timelineSvg(
          source.contains('portrait') ? 'portrait' : 'landscape',
        );
      };
      final images = rows(config['initialStates']);
      final messageWidth = (obj(images[0]['containerRect'])['width'] as num)
          .toDouble();
      final toolWidth = (obj(images[5]['containerRect'])['width'] as num)
          .toDouble();
      final captureKey = GlobalKey(),
          messageKey = GlobalKey(),
          toolKey = GlobalKey();
      await t.pumpWidget(
        RepaintBoundary(
          key: captureKey,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: theme
                .build(
                  config['theme'] == 'light'
                      ? Brightness.light
                      : Brightness.dark,
                )
                .copyWith(
                  textTheme: theme
                      .build(
                        config['theme'] == 'light'
                            ? Brightness.light
                            : Brightness.dark,
                      )
                      .textTheme
                      .apply(fontFamily: 'TimelineParitySystem'),
                ),
            home: Scaffold(
              body: SingleChildScrollView(
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Message images'),
                      const SizedBox(height: 8),
                      SizedBox(
                        key: messageKey,
                        width: messageWidth,
                        child: TimelineImages(
                          rows(timelineImageFixture['primaryCases']),
                          gateway: g,
                        ),
                      ),
                      const SizedBox(height: 24),
                      const Text('Tool output'),
                      const SizedBox(height: 8),
                      SizedBox(
                        key: toolKey,
                        width: toolWidth,
                        child: TimelineImages(
                          [
                            obj(timelineImageFixture['toolCase']),
                            obj(timelineImageFixture['toolBrokenCase']),
                          ],
                          gateway: g,
                          label: 'Tool output',
                          retainOnSourceChange: true,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await awaitTimelineImages(
        t,
        () =>
            find.byType(SvgPicture).evaluate().length == 3 &&
            find.text('Attachment').evaluate().length == 2 &&
            find.text('Tool output').evaluate().length == 2,
      );
      final measured = <Json>[];
      for (final (groupKey, offset) in [(messageKey, 0), (toolKey, 5)]) {
        final found = find.descendant(
          of: find.byKey(groupKey),
          matching: find.byType(TimelineAttachmentImage),
        );
        for (var i = 0; i < found.evaluate().length; i++) {
          final size = t.getSize(found.at(i)),
              expected = images[offset + i],
              r = obj(expected['rect']);
          measured.add({
            'id': expected['id'],
            'width': size.width,
            'height': size.height,
            'widthDelta': size.width - (r['width'] as num),
            'heightDelta': size.height - (r['height'] as num),
          });
        }
      }
      await t.runAsync(() async {
        final capture =
            await (captureKey.currentContext!.findRenderObject()
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 1);
        final data = await capture.toByteData(format: ui.ImageByteFormat.png);
        Directory('build/parity').createSync(recursive: true);
        File(
          'build/parity/timeline-image-native-${width.toInt()}-${config['theme']}.png',
        ).writeAsBytesSync(data!.buffer.asUint8List());
        capture.dispose();
      });
      results.add({
        'width': width,
        'theme': config['theme'],
        'images': measured,
      });
      await t.pumpWidget(const SizedBox());
      pending.complete(timelineSvg('landscape'));
      await g.stream.close();
    });
  }
  tearDownAll(() {
    File(
      'build/parity/timeline-image-native-measurements.json',
    ).writeAsStringSync(
      const JsonEncoder.withIndent('  ').convert({
        'reference': reference['reference'],
        'scope':
            'Isolated actual native message/tool image rows; comparison-only host SFNS font. Does not prove whole-App screenshot or Android device equality.',
        'cases': results,
      }),
    );
  });
}
