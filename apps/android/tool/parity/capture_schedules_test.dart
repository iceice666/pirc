import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/schedules_page.dart';
import '../../test/live_test.dart' show FakeGateway, theme;
import 'capture_fonts.dart';

class FixtureGateway extends FakeGateway {
  FixtureGateway(this.fixture);
  final Json fixture;
  @override
  dynamic normal(String method, Json args) {
    if (method == 'timeZoneInfo') {
      return {
        'default': 'UTC',
        'zones': ['UTC'],
      };
    }
    if (method == 'wallInput') {
      return DateTime.fromMillisecondsSinceEpoch(
        (args['at'] as num).toInt(),
        isUtc: true,
      ).toIso8601String().substring(0, 16);
    }
    if (method == 'request') {
      if (args['path'] == '/api/schedules') {
        return {'schedules': fixture['schedules']};
      }
      if (args['path'] == '/api/schedules/daily') {
        return {
          'schedule': rows(fixture['schedules']).first,
          'runs': fixture['runs'],
        };
      }
      if (args['path'] == '/api/models') return {'models': fixture['models']};
    }
    return super.normal(method, args);
  }
}

void main() {
  final f = obj(
    jsonDecode(
      File('../../fixtures/mobile-parity/schedules.json').readAsStringSync(),
    ),
  );
  for (final width in f['widths'] as List) {
    for (final view in f['views'] as List) {
      for (final brightness in Brightness.values) {
        testWidgets('schedules $width $view ${brightness.name}', (t) async {
          await t.runAsync(loadParityFonts);
          t.view.devicePixelRatio = 1;
          t.view.physicalSize = Size(
            (width as num).toDouble(),
            (f['height'] as num).toDouble(),
          );
          addTearDown(t.view.reset);
          final g = FixtureGateway(f),
              c = LiveController(g)..workspaces = rows(f['workspaces']);
          final key = GlobalKey();
          await t.pumpWidget(
            RepaintBoundary(
              key: key,
              child: MaterialApp(
                debugShowCheckedModeBanner: false,
                theme: theme.build(brightness),
                home: Scaffold(
                  body: SchedulesPage(
                    controller: c,
                    now: () =>
                        DateTime.fromMillisecondsSinceEpoch(f['now'] as int),
                  ),
                ),
              ),
            ),
          );
          await t.pumpAndSettle();
          if (view == 'runs') {
            await t.tap(find.widgetWithText(TextButton, 'Runs').first);
            await t.pumpAndSettle();
            await t.tap(find.text('Prompt'));
            await t.pumpAndSettle();
          }
          if (view == 'editor') {
            await t.tap(find.widgetWithText(TextButton, 'Edit').first);
            await t.pumpAndSettle();
          }
          expect(t.takeException(), isNull);
          await t.runAsync(() async {
            final capture =
                await (key.currentContext!.findRenderObject()
                        as RenderRepaintBoundary)
                    .toImage();
            final bytes = await capture.toByteData(
              format: ui.ImageByteFormat.png,
            );
            final file = File(
              'build/parity/schedules-native-$width-$view-${brightness.name}.png',
            );
            await file.parent.create(recursive: true);
            await file.writeAsBytes(bytes!.buffer.asUint8List());
            capture.dispose();
          });
          await t.pumpWidget(const SizedBox());
          c.dispose();
          await g.stream.close();
        });
      }
    }
  }
}
