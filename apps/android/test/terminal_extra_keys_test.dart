import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/terminal_input.dart';
import 'package:pirc_mobile/live/terminal_pane.dart';
import 'package:xterm/xterm.dart';
import 'terminal_zoom_test.dart' show withTerminal;

void main() {
  test(
    'one-shot modifiers affect keys and IME commits, not terminal replies or paste',
    () {
      final sent = <String>[];
      final terminal = NativeTerminalInput(
        onOutput: sent.add,
        onResize: (_, _, _, _) {},
        onModifiersChanged: () {},
      );
      terminal.toggleControl();
      terminal.keyInput(TerminalKey.keyC);
      expect(sent.removeLast(), '\x03');
      expect(terminal.controlArmed, isFalse);
      terminal.textInput('c');
      expect(sent.removeLast(), 'c');
      terminal.toggleControl();
      terminal.textInput('C');
      expect(sent.removeLast(), '\x03');
      terminal.toggleAlt();
      terminal.textInput('x中文');
      expect(sent.removeLast(), '\x1bx中文');
      expect(terminal.altArmed, isFalse);
      terminal.toggleControl();
      terminal.write('\x1b[6n');
      expect(sent.removeLast(), matches(r'^\x1b\[\d+;\d+R$'));
      expect(terminal.controlArmed, isTrue);
      terminal.textInput('d');
      expect(sent.removeLast(), '\x04');
      terminal.toggleControl();
      terminal.paste('c中文');
      expect(sent.removeLast(), 'c中文');
      expect(terminal.controlArmed, isFalse);
      terminal.write('\x1b[?2004h');
      terminal.toggleAlt();
      terminal.paste('c中文');
      expect(sent.removeLast(), '\x1b[200~c中文\x1b[201~');
      expect(terminal.altArmed, isFalse);
    },
  );
  testWidgets('mobile extra keys send VT sequences and keep IME focus', (
    t,
  ) async {
    await withTerminal(t, (g) async {
      TerminalView view() => t.widget<TerminalView>(find.byType(TerminalView));
      List<String> inputs() => g.calls
          .where((c) => c.$1 == 'socketSend' && c.$2['data']['type'] == 'input')
          .map((c) => c.$2['data']['data'] as String)
          .toList();
      await t.tap(find.byType(TerminalView));
      // xterm keeps a 300 ms double-tap window without scheduling a frame.
      await t.pump(const Duration(milliseconds: 350));
      await t.pumpAndSettle();
      expect(t.testTextInput.hasAnyClients, isTrue);
      final expected = {
        'ESC': '\x1b',
        'TAB': '\t',
        '/': '/',
        '-': '-',
        'HOME': '\x1b[H',
        'END': '\x1b[F',
        '↑': '\x1b[A',
        '↓': '\x1b[B',
        '←': '\x1b[D',
        '→': '\x1b[C',
        'PGUP': '\x1b[5~',
        'PGDN': '\x1b[6~',
      };
      for (final e in expected.entries) {
        await t.tap(find.byKey(ValueKey('terminal-key-${e.key}')));
        await t.pump();
        expect(inputs().last, e.value, reason: e.key);
        expect(view().focusNode!.hasPrimaryFocus, isTrue);
        expect(t.testTextInput.hasAnyClients, isTrue);
      }
      expect(inputs().length, expected.length);
      await t.tap(find.byKey(const ValueKey('terminal-key-CTRL')));
      await t.pump();
      expect((view().terminal as NativeTerminalInput).controlArmed, isTrue);
      expect(t.testTextInput.hasAnyClients, isTrue);
      t.testTextInput.enterText('c');
      await t.pump();
      expect(inputs().last, '\x03');
      expect((view().terminal as NativeTerminalInput).controlArmed, isFalse);
      t.testTextInput.enterText('d');
      await t.pump();
      expect(inputs().last, 'd');
      await t.tap(find.byKey(const ValueKey('terminal-key-ALT')));
      await t.pump();
      t.testTextInput.enterText('x');
      await t.pump();
      expect(inputs().last, '\x1bx');
      await t.tap(find.byKey(const ValueKey('terminal-key-CTRL')));
      await t.pump();
      final c = t
          .widget<NativeTerminalView>(find.byType(NativeTerminalView))
          .controller;
      c.control = {'held': false};
      c.changed();
      await t.pump();
      expect((view().terminal as NativeTerminalInput).controlArmed, isFalse);
      expect(
        t
            .widget<TextButton>(find.byKey(const ValueKey('terminal-key-ESC')))
            .onPressed,
        isNull,
      );
    });
  });
  testWidgets(
    'terminal reconnect restores focused IME input on the new replay',
    (t) async {
      await withTerminal(t, (g) async {
        TerminalView view() =>
            t.widget<TerminalView>(find.byType(TerminalView));
        await t.tap(find.byType(TerminalView));
        await t.pump(const Duration(milliseconds: 350));
        await t.pumpAndSettle();
        expect(view().focusNode!.hasPrimaryFocus, isTrue);
        expect(t.testTextInput.hasAnyClients, isTrue);
        t.view.viewInsets = const FakeViewPadding(bottom: 280);
        await t.pumpAndSettle();
        final oldTerminal = view().terminal;
        final oldTag = g.calls
            .lastWhere((call) => call.$1 == 'socketOpen')
            .$2['tag'];
        g.stream.add({
          'type': 'socketClosed',
          'data': {'tag': oldTag, 'code': 1006},
        });
        await t.pump();
        await t.pump(const Duration(milliseconds: 550));
        await t.pump();
        final newTag = g.calls
            .lastWhere((call) => call.$1 == 'socketOpen')
            .$2['tag'];
        expect(newTag, isNot(oldTag));
        g.stream.add({
          'type': 'socket',
          'data': {
            'tag': newTag,
            'frame': {'type': 'ready', 'replay': 'restored\r\n'},
          },
        });
        await t.pumpAndSettle();
        expect(identical(view().terminal, oldTerminal), isFalse);
        expect(view().focusNode!.hasPrimaryFocus, isTrue);
        expect(t.testTextInput.hasAnyClients, isTrue);
        final before = g.calls
            .where(
              (call) =>
                  call.$1 == 'socketSend' && call.$2['data']['type'] == 'input',
            )
            .length;
        t.testTextInput.enterText('中文 after reconnect');
        await t.pump();
        final inputs = g.calls
            .where(
              (call) =>
                  call.$1 == 'socketSend' && call.$2['data']['type'] == 'input',
            )
            .toList();
        expect(inputs.length, before + 1);
        expect(inputs.last.$2['tag'], newTag);
        expect(inputs.last.$2['data']['data'], '中文 after reconnect');
      });
    },
  );
  testWidgets('extra keys adapt to keyboard-sized and landscape viewports', (
    t,
  ) async {
    await withTerminal(t, (g) async {
      for (final height in [160.0, 80.0, 50.0]) {
        t.view.physicalSize = Size(390, height);
        await t.pumpAndSettle();
        expect(find.byType(TerminalView), findsOneWidget);
        expect(t.takeException(), isNull, reason: 'available height $height');
        expect(
          find.byKey(const ValueKey('terminal-extra-keys')),
          height >= 80 ? findsOneWidget : findsNothing,
        );
      }
    });
  });
}
