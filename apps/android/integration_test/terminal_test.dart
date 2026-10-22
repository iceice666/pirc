import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/terminal_pane.dart';
import 'package:pirc_mobile/theme.dart';
import 'package:xterm/xterm.dart';

String terminalText(Terminal terminal) => List.generate(
  terminal.buffer.lines.length,
  (i) => terminal.buffer.lines[i].getText(),
).join('\n');
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('real Android native PTY input, retained tab, replay and exit', (
    t,
  ) async {
    expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), true);
    const id = String.fromEnvironment('PIRC_TERMINAL_SESSION');
    expect(
      id.isNotEmpty,
      true,
      reason: 'Start isolated helper with --terminal.',
    );
    final g = Gateway();
    await g.call('pair', {
      'link': const String.fromEnvironment('PIRC_PAIR_LINK'),
    });
    await g.call('completeOnboarding');
    final c = LiveController(g, showing: 'engine'),
        theme = await PircTheme.load();
    Future<void> until(bool Function() ready, String step) async {
      for (var i = 0; i < 150 && !ready(); i++) {
        await t.pump(const Duration(milliseconds: 200));
      }
      expect(ready(), true, reason: step);
      await t.pump();
      expect(t.takeException(), isNull, reason: step);
    }

    Future<void> tap(Finder f) async {
      await t.ensureVisible(f);
      await t.pump(const Duration(milliseconds: 100));
      await t.tap(f);
      await t.pump(const Duration(milliseconds: 300));
    }

    Terminal current() =>
        t.widget<TerminalView>(find.byType(TerminalView)).terminal;
    try {
      await t.pumpWidget(MobileApp(theme: theme, controller: c));
      await until(
        () => !c.booting && c.workspaces.any((w) => w['id'] == 'git:fixture'),
        'boot workspace',
      );
      await tap(find.text('Work'));
      await tap(find.text('Native Git workspace').first);
      await until(
        () => find.text('Native Git fixture').evaluate().isNotEmpty,
        'fixture visible',
      );
      await tap(find.text('Native Git fixture'));
      await until(
        () => c.sessionId == id && c.state.isNotEmpty,
        'open session',
      );
      await c.takeControl();
      await until(() => c.control['held'] == true, 'control lease');
      await tap(find.byTooltip('Show side panel'));
      await tap(find.byKey(const ValueKey('panel-tab-terminals')));
      await until(
        () =>
            find.byType(TerminalPane).evaluate().isNotEmpty &&
            find.text('Open terminal').evaluate().isNotEmpty,
        'terminal empty',
      );
      await tap(find.text('Open terminal'));
      await until(
        () =>
            find.byType(TerminalView).evaluate().isNotEmpty &&
            terminalText(current()).contains(r'$ '),
        'real shell ready',
      );
      current().paste("printf '\\nNATIVE_%s\\n' PTY_OK\n");
      await until(
        () => terminalText(current()).contains('NATIVE_PTY_OK'),
        'real PTY output',
      );
      final retained = current();
      await tap(find.byKey(const ValueKey('panel-tab-files')));
      await tap(find.byKey(const ValueKey('panel-tab-terminals')));
      expect(identical(retained, current()), true);
      expect(terminalText(current()), contains('NATIVE_PTY_OK'));
      // Exercise the same lifecycle callbacks used by the actual native app.
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await t.pump(const Duration(milliseconds: 200));
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await until(
        () =>
            !identical(retained, current()) &&
            terminalText(current()).contains('NATIVE_PTY_OK'),
        'real reconnect replay',
      );
      current().paste('exit 7\n');
      await until(
        () => terminalText(current()).contains('[process exited with code 7]'),
        'exit frame',
      );
      await tap(find.byTooltip('Close terminal 1'));
      await until(
        () => find.text('Open terminal').evaluate().isNotEmpty,
        'remove exited tab',
      );
      debugPrint('REAL_GATEWAY:terminal-native-input-retention-replay-exit');
    } finally {
      await t.pumpWidget(const SizedBox());
      await g.call('unwatch');
    }
  });
}
