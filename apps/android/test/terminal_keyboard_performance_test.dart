import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/terminal_pane.dart';
import 'package:xterm/xterm.dart';
import 'live_test.dart' show FakeGateway, theme;
import 'terminal_parity_test.dart' show terminalInfo;

void main() {
  testWidgets(
    'keyboard metrics and conversation ticks retain terminal glyph caches',
    (t) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = const Size(390, 800);
      addTearDown(t.view.reset);
      final g = FakeGateway(),
          c = LiveController(g)
            ..sessionId = 's'
            ..clientId = 'phone'
            ..control = {'held': true, 'generation': 3};
      g.handler = (method, args) async => method == 'request'
          ? {
              'terminals': [terminalInfo('a')],
            }
          : null;
      final brightness = ValueNotifier(Brightness.light);
      try {
        await t.pumpWidget(
          ValueListenableBuilder(
            valueListenable: brightness,
            builder: (context, b, _) => MaterialApp(
              theme: theme.build(b),
              home: Scaffold(
                body: LayoutBuilder(
                  builder: (context, box) =>
                      TerminalPane(controller: c, touch: true),
                ),
              ),
            ),
          ),
        );
        await t.pumpAndSettle();
        final tag = g.calls.singleWhere((x) => x.$1 == 'socketOpen').$2['tag'];
        final replay = List.generate(
          3000,
          (i) =>
              '\x1b[38;2;${i % 256};${(i * 7) % 256};${(i * 11) % 256}mline $i 中文 terminal output 0123456789\x1b[0m\r\n',
        ).join();
        g.stream.add({
          'type': 'socket',
          'data': {
            'tag': tag,
            'frame': {'type': 'ready', 'replay': replay},
          },
        });
        await t.pumpAndSettle();
        TerminalView view() =>
            t.widget<TerminalView>(find.byType(TerminalView));
        final terminal = view().terminal,
            style = view().textStyle,
            palette = view().theme;
        final styles = <int>{}, palettes = <int>{}, micros = <int>[];
        for (var cycle = 0; cycle < 2; cycle++) {
          for (var step = 0; step < 24; step++) {
            t.view.viewInsets = FakeViewPadding(
              bottom: (step < 12 ? step : 23 - step) * 24,
            );
            c.changed();
            g.stream.add({
              'type': 'socket',
              'data': {
                'tag': tag,
                'frame': {'type': 'output', 'data': 'frame $cycle:$step\r\n'},
              },
            });
            final watch = Stopwatch()..start();
            await t.pump(const Duration(milliseconds: 16));
            watch.stop();
            micros.add(watch.elapsedMicroseconds);
            styles.add(identityHashCode(view().textStyle));
            palettes.add(identityHashCode(view().theme));
            expect(identical(view().terminal, terminal), isTrue);
          }
        }
        await t.pumpAndSettle();
        micros.sort();
        // Diagnostic times are comparable locally, not a physical-device FPS claim.
        debugPrint(
          'TERMINAL_KEYBOARD ${jsonEncode({'frames': micros.length, 'medianUs': micros[micros.length ~/ 2], 'p95Us': micros[(micros.length * .95).floor()], 'styles': styles.length, 'palettes': palettes.length})}',
        );
        expect(
          styles.length,
          1,
          reason: 'Style identity changes flush xterm paragraph layouts.',
        );
        expect(
          palettes.length,
          1,
          reason: 'Theme identity changes flush xterm paragraph layouts.',
        );
        expect(identical(view().textStyle, style), isTrue);
        expect(identical(view().theme, palette), isTrue);
        expect(g.calls.where((x) => x.$1 == 'socketOpen').length, 1);
        expect(terminal.buffer.getText(), contains('frame 1:23'));
        brightness.value = Brightness.dark;
        await t.pumpAndSettle();
        expect(identical(view().theme, palette), isFalse);
        expect(identical(view().textStyle, style), isTrue);
        final width = terminal.viewWidth;
        t.platformDispatcher.textScaleFactorTestValue = 1.3;
        addTearDown(t.platformDispatcher.clearTextScaleFactorTestValue);
        await t.pumpAndSettle();
        expect(identical(view().textStyle, style), isFalse);
        expect(terminal.viewWidth, lessThan(width));
        expect(t.takeException(), isNull);
      } finally {
        await t.pumpWidget(const SizedBox.shrink());
        brightness.dispose();
        c.dispose();
        await g.stream.close();
        await t.pump();
      }
    },
  );
}
