import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/terminal_pane.dart';
import 'package:xterm/xterm.dart';
import 'live_test.dart' show FakeGateway, theme;
import 'terminal_parity_test.dart' show terminalInfo;

Future<void> withTerminal(
  WidgetTester t,
  Future<void> Function(FakeGateway) body,
) async {
  t.view.devicePixelRatio = 1;
  t.view.physicalSize = const Size(390, 800);
  addTearDown(t.view.reset);
  final g = FakeGateway(),
      c = LiveController(g)
        ..sessionId = 's'
        ..clientId = 'phone'
        ..control = {'held': true, 'generation': 3};
  g.handler = (_, _) async => null;
  try {
    await t.pumpWidget(
      MaterialApp(
        theme: theme.build(Brightness.light),
        home: Scaffold(
          body: NativeTerminalView(
            controller: c,
            info: terminalInfo('a'),
            tabLabel: 'bash 1',
            visible: true,
            onExit: (_) {},
          ),
        ),
      ),
    );
    await t.pumpAndSettle();
    final tag = g.calls.singleWhere((x) => x.$1 == 'socketOpen').$2['tag'];
    g.stream.add({
      'type': 'socket',
      'data': {
        'tag': tag,
        'frame': {
          'type': 'ready',
          'replay': List.generate(300, (i) => 'line $i 中文 output\r\n').join(),
        },
      },
    });
    await t.pumpAndSettle();
    await body(g);
    expect(t.takeException(), isNull);
  } finally {
    await t.pumpWidget(const SizedBox.shrink());
    c.dispose();
    await g.stream.close();
    await t.pump();
  }
}

void main() {
  testWidgets(
    'Ctrl zoom resizes the same PTY without sending shortcut characters',
    (t) async {
      await withTerminal(t, (g) async {
        TerminalView view() =>
            t.widget<TerminalView>(find.byType(TerminalView));
        final terminal = view().terminal, cols = terminal.viewWidth;
        List<dynamic> input() => g.calls
            .where(
              (c) => c.$1 == 'socketSend' && c.$2['data']['type'] == 'input',
            )
            .toList();
        final count = input().length;
        await t.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
        await t.sendKeyEvent(LogicalKeyboardKey.equal);
        await t.pumpAndSettle();
        expect(view().textStyle.fontSize, 13.5);
        expect(terminal.viewWidth, lessThan(cols));
        await t.sendKeyEvent(LogicalKeyboardKey.minus);
        await t.pumpAndSettle();
        expect(view().textStyle.fontSize, 12.5);
        for (var i = 0; i < 40; i++) {
          await t.sendKeyEvent(LogicalKeyboardKey.minus);
        }
        await t.pumpAndSettle();
        expect(view().textStyle.fontSize, 8);
        await t.sendKeyEvent(LogicalKeyboardKey.digit0);
        await t.pumpAndSettle();
        expect(view().textStyle.fontSize, 12.5);
        await t.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
        expect(input().length, count);
        expect(identical(view().terminal, terminal), isTrue);
        expect(terminal.buffer.getText(), contains('line 299'));
        expect(g.calls.where((c) => c.$1 == 'socketOpen').length, 1);
      });
    },
  );
  testWidgets('two-finger pinch zoom keeps one-finger history scrolling', (
    t,
  ) async {
    await withTerminal(t, (g) async {
      final finder = find.byType(TerminalView);
      TerminalView view() => t.widget<TerminalView>(finder);
      final terminal = view().terminal;
      final scroll = t.state<ScrollableState>(
        find.descendant(of: finder, matching: find.byType(Scrollable)),
      );
      final before = scroll.position.pixels;
      await t.drag(finder, const Offset(0, 160));
      await t.pumpAndSettle();
      expect(scroll.position.pixels, lessThan(before));
      expect(view().textStyle.fontSize, 12.5);
      final center = t.getCenter(finder);
      final first = await t.createGesture(pointer: 1),
          second = await t.createGesture(pointer: 2);
      await first.down(center - const Offset(40, 0));
      await second.down(center + const Offset(40, 0));
      await t.pump();
      for (var i = 1; i <= 6; i++) {
        await first.moveTo(center - Offset(40 + i * 10, 0));
        await second.moveTo(center + Offset(40 + i * 10, 0));
        await t.pump(const Duration(milliseconds: 16));
      }
      await first.up();
      await second.up();
      await t.pumpAndSettle();
      expect(view().textStyle.fontSize, greaterThan(12.5));
      expect(view().textStyle.fontSize, lessThanOrEqualTo(32));
      expect(identical(view().terminal, terminal), isTrue);
      expect(terminal.buffer.getText(), contains('line 299'));
    });
  });
}
