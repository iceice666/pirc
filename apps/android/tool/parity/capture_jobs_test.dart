import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/jobs_menu.dart';
import '../../test/live_test.dart' show FakeGateway, theme;
import 'capture_fonts.dart';

void main() {
  for (final brightness in Brightness.values) {
    testWidgets('jobs ${brightness.name}', (t) async {
      debugDisableShadows = false;
      addTearDown(() => debugDisableShadows = true);
      final f = obj(
        jsonDecode(
          File('../../fixtures/mobile-parity/jobs.json').readAsStringSync(),
        ),
      );
      await t.runAsync(loadParityFonts);
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = Size(
        (f['width'] as num).toDouble(),
        (f['height'] as num).toDouble(),
      );
      addTearDown(t.view.reset);
      final g = FakeGateway(),
          c = LiveController(g)
            ..sessionId = 's'
            ..origin = 'test'
            ..connection = 'live'
            ..control = {'held': true, 'generation': 3};
      g.handler = (_, args) async => '${args['path']}'.contains('/background/')
          ? {'output': f['output']}
          : f;
      final key = GlobalKey();
      await t.pumpWidget(
        RepaintBoundary(
          key: key,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: theme.build(brightness),
            home: Scaffold(
              body: SizedBox(
                height: 56,
                child: Padding(
                  padding: const EdgeInsets.only(right: 46),
                  child: Align(
                    alignment: Alignment.centerRight,
                    child: JobsMenu(controller: c),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await t.pump(const Duration(milliseconds: 100));
      await t.pump();
      await t.tap(find.byTooltip('Background jobs'));
      await t.pump();
      await t.pump();
      await t.tap(find.text('bun run dev'));
      await t.pump();
      await t.tap(find.text('Finished 2'));
      await t.pump();
      final list = t.widget<JobsList>(find.byType(JobsList));
      list.jobs.now = DateTime.fromMillisecondsSinceEpoch(f['now'] as int);
      c.changed();
      await t.pump();
      await t.pump();
      expect(t.takeException(), isNull);
      await t.runAsync(() async {
        final image =
            await (key.currentContext!.findRenderObject()
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 1);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        Directory('build/parity').createSync(recursive: true);
        File(
          'build/parity/jobs-native-${brightness.name}.png',
        ).writeAsBytesSync(bytes!.buffer.asUint8List());
        image.dispose();
      });
      debugDisableShadows = true;
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    });
  }
}
