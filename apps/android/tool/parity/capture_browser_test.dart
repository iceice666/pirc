import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/browser_pane.dart';
import '../../test/browser_parity_test.dart' show browserFixture, browserFrame;
import '../../test/live_test.dart' show FakeGateway, theme;
import 'capture_fonts.dart';

void main() {
  final f = browserFixture;
  for (final width in f['widths']) {
    for (final view in f['views']) {
      for (final brightness in Brightness.values) {
        testWidgets('browser $width $view ${brightness.name}', (t) async {
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
                ..control = {'held': true, 'generation': 2};
          g.handler = (method, a) async {
            if (method == 'socketSend' && a['data']['type'] == 'log_image') {
              browserFrame(g, a['tag'], {
                'type': 'log_image',
                'index': a['data']['index'],
                'data': f['image'],
              });
            }
            return null;
          };
          final key = GlobalKey();
          await t.pumpWidget(
            RepaintBoundary(
              key: key,
              child: MaterialApp(
                debugShowCheckedModeBanner: false,
                theme: theme.build(brightness),
                home: Scaffold(body: BrowserPane(controller: c)),
              ),
            ),
          );
          await t.pump();
          final tag = g.calls.lastWhere((x) => x.$1 == 'socketOpen').$2['tag'];
          if (view == 'unavailable') {
            g.stream.add({
              'type': 'socketClosed',
              'data': {
                'tag': tag,
                'code': 4403,
                'message': 'The browser is disabled on this node.',
              },
            });
          } else {
            browserFrame(g, tag, {
              'type': 'state',
              'state': {
                ...obj(f['state']),
                'active': view != 'empty',
                'mode': view == 'user' ? 'user' : 'agent',
                'handoff': view == 'user' ? 'Please finish the form.' : null,
                'agentWaiting': view == 'user',
              },
            });
            browserFrame(g, tag, {'type': 'log', 'entries': f['log']});
            if (view != 'empty') {
              browserFrame(g, tag, {
                'type': 'frame',
                'data': f['image'],
                'width': 640,
                'height': 400,
              });
            }
          }
          await t.pumpAndSettle();
          if (view == 'activity' || view == 'replay') {
            await t.tap(find.byTooltip('Activity and replay'));
            await t.pumpAndSettle();
          }
          if (view == 'replay') {
            await t.tap(find.byKey(const ValueKey('browser-log-3')));
            await t.pumpAndSettle();
          }
          for (final item in find.byType(Image).evaluate()) {
            final provider = (item.widget as Image).image;
            await t.runAsync(() async {
              final done = Completer<void>();
              final stream = provider.resolve(const ImageConfiguration());
              late ImageStreamListener listener;
              listener = ImageStreamListener(
                (_, _) {
                  if (!done.isCompleted) done.complete();
                },
                onError: (Object e, StackTrace? s) {
                  if (!done.isCompleted) done.completeError(e, s);
                },
              );
              stream.addListener(listener);
              try {
                await done.future;
              } finally {
                stream.removeListener(listener);
              }
            });
          }
          await t.pump();
          expect(t.takeException(), isNull);
          await t.runAsync(() async {
            final img =
                await (key.currentContext!.findRenderObject()
                        as RenderRepaintBoundary)
                    .toImage(pixelRatio: 1);
            final bytes = await img.toByteData(format: ui.ImageByteFormat.png);
            File(
              'build/parity/browser-native-$width-$view-${brightness.name}.png',
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
