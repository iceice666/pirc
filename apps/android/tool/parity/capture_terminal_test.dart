import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/terminal_pane.dart';
import '../../test/live_test.dart' show FakeGateway, theme;
import 'capture_fonts.dart';

void main() {
  final f = jsonDecode(
    File('../../fixtures/mobile-parity/terminal.json').readAsStringSync(),
  );
  for (final width in f['widths']) {
    for (final view in f['views']) {
      for (final brightness in Brightness.values) {
        testWidgets('terminal $width $view ${brightness.name}', (t) async {
          await t.runAsync(loadParityFonts);
          debugDisableShadows = false;
          t.view.devicePixelRatio = 1;
          t.view.physicalSize = Size(
            (width as num).toDouble(),
            (f['height'] as num).toDouble(),
          );
          addTearDown(t.view.reset);
          final g = FakeGateway(),
              c = LiveController(g)
                ..sessionId = 's'
                ..control = {'held': view != 'readonly', 'generation': 2};
          final empty = ['empty', 'readonly'].contains(view);
          g.handler = (method, args) async => method == 'request'
              ? {'terminals': empty ? [] : f['terminals']}
              : null;
          final key = GlobalKey();
          await t.pumpWidget(
            RepaintBoundary(
              key: key,
              child: MaterialApp(
                debugShowCheckedModeBanner: false,
                theme: theme.build(brightness),
                home: Scaffold(body: TerminalPane(controller: c, touch: true)),
              ),
            ),
          );
          await t.pump();
          await t.pump(const Duration(milliseconds: 80));
          for (final call
              in g.calls.where((x) => x.$1 == 'socketOpen').toList()) {
            void send(Json message) => g.stream.add({
              'type': 'socket',
              'data': {'tag': call.$2['tag'], 'frame': message},
            });
            send({'type': 'ready', 'replay': f['replay']});
            if (view == 'lost') send({'type': 'error', 'code': 'lost_control'});
            if (view == 'exited') send({'type': 'exit', 'exitCode': 7});
            if (view == 'reconnecting') {
              g.stream.add({
                'type': 'socketClosed',
                'data': {'tag': call.$2['tag'], 'code': 1006},
              });
            }
          }
          await t.pump();
          await t.pump(const Duration(milliseconds: 80));
          expect(t.takeException(), isNull);
          await t.runAsync(() async {
            final img =
                await (key.currentContext!.findRenderObject()
                        as RenderRepaintBoundary)
                    .toImage(pixelRatio: 1);
            final bytes = await img.toByteData(format: ui.ImageByteFormat.png);
            File(
              'build/parity/terminal-native-$width-$view-${brightness.name}.png',
            ).writeAsBytesSync(bytes!.buffer.asUint8List());
            img.dispose();
          });
          await t.pumpWidget(const SizedBox());
          c.dispose();
          await g.stream.close();
          await t.pump();
          debugDisableShadows = true;
        });
      }
    }
  }
}
