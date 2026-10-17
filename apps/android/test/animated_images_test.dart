import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/markdown_image.dart';
import 'package:pirc_mobile/live/timeline_attachment_image.dart';
import 'live_test.dart' show FakeGateway, theme;

final fixture =
    jsonDecode(
          File(
            '../../fixtures/mobile-parity/animated-images.json',
          ).readAsStringSync(),
        )
        as Map;
final cases = (fixture['cases'] as List).cast<Map>();

Future<List<int>> pixel(ui.Image image) async {
  final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
  return data!.buffer.asUint8List().take(4).toList();
}

bool red(List<int> p) => p[0] > 200 && p[1] < 20 && p[2] < 20 && p[3] == 255;
bool blue(List<int> p) => p[2] > 200 && p[0] < 20 && p[1] < 20 && p[3] == 255;

Future<List<int>> displayed(
  WidgetTester t, {
  Duration step = Duration.zero,
}) async {
  await t.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 10)),
  );
  await t.pump(step);
  final images = t
      .widgetList<RawImage>(find.byType(RawImage))
      .where((w) => w.image != null)
      .toList();
  if (images.isEmpty) return [];
  expect(images, hasLength(1));
  final image = images.single.image!;
  expect(image.width, 4);
  expect(image.height, 4);
  return (await t.runAsync(() => pixel(image)))!;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  for (final item in cases) {
    final bytes = base64Decode(item['base64'] as String);
    test(
      '${item['id']} codec retains two composited frames and timing',
      () async {
        final codec = await ui.instantiateImageCodec(bytes);
        try {
          expect(codec.frameCount, 2);
          expect(codec.repetitionCount, -1);
          final first = await codec.getNextFrame();
          try {
            expect(red(await pixel(first.image)), isTrue);
            expect(first.duration, const Duration(milliseconds: 200));
          } finally {
            first.image.dispose();
          }
          final second = await codec.getNextFrame();
          try {
            expect(blue(await pixel(second.image)), isTrue);
            expect(second.duration, const Duration(milliseconds: 200));
          } finally {
            second.image.dispose();
          }
        } finally {
          codec.dispose();
        }
      },
    );
    for (final path in ['markdown', 'attachment']) {
      testWidgets('${item['id']} $path displays the next animation frame', (
        t,
      ) async {
        final g = FakeGateway();
        Widget content = path == 'markdown'
            ? NativeMarkdownImage(
                gateway: g,
                source: Uri.dataFromBytes(
                  bytes,
                  mimeType: item['mimeType'] as String,
                ),
                alt: 'animated fixture',
                borderRadius: 0,
              )
            : TimelineAttachmentImage(
                entry: {
                  'kind': 'image',
                  'mimeType': item['mimeType'],
                  'base64': item['base64'],
                },
                label: 'animated fixture',
                gateway: g,
              );
        await t.pumpWidget(
          MaterialApp(
            theme: theme.build(Brightness.light),
            home: Scaffold(body: content),
          ),
        );
        var firstSeen = false;
        for (var i = 0; i < 60 && !firstSeen; i++) {
          final p = await displayed(t);
          firstSeen = p.isNotEmpty && red(p);
        }
        expect(firstSeen, isTrue, reason: 'first frame is actually displayed');
        var secondSeen = false;
        for (var i = 0; i < 30 && !secondSeen; i++) {
          final p = await displayed(t, step: const Duration(milliseconds: 20));
          secondSeen = p.isNotEmpty && blue(p);
        }
        expect(
          secondSeen,
          isTrue,
          reason: 'widget playback must not freeze at first frame',
        );
        expect(t.takeException(), isNull);
        await t.pumpWidget(const SizedBox());
        await t.pump();
        await g.stream.close();
      });
    }
  }
}
