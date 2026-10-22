import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/side_panel.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/tasks_pane.dart';
import 'package:pirc_mobile/theme.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'real Android background task output follows completion',
    (t) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      const id = String.fromEnvironment('PIRC_FILES_SESSION');
      expect(
        id.isNotEmpty,
        isTrue,
        reason: 'Run the isolated helper with --files.',
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
        expect(ready(), isTrue, reason: step);
        expect(t.takeException(), isNull, reason: step);
      }

      Future<void> tap(Finder target) async {
        await t.ensureVisible(target);
        await t.pumpAndSettle();
        expect(target.hitTestable(), findsOneWidget);
        await t.tap(target);
        await t.pumpAndSettle();
      }

      const command =
          'echo PARITY_TASK_STARTED; sleep 8; echo PARITY_TASK_FINISHED; exit 7';
      try {
        await t.pumpWidget(MobileApp(theme: theme, controller: c));
        await until(
          () => !c.booting && c.sessions.any((s) => s['id'] == id),
          'boot fixture',
        );
        await tap(find.text('Native files fixture'));
        await until(
          () =>
              c.sessionId == id &&
              c.canWrite &&
              find.byType(NativeSidePanel).evaluate().isNotEmpty,
          'open writable fixture',
        );
        c.editDraft('/bg start $command');
        await c.send('prompt');
        await tap(find.byKey(const ValueKey('panel-tab-tasks')));
        await until(
          () =>
              find.byType(TasksPane).evaluate().isNotEmpty &&
              find.text(command).evaluate().isNotEmpty,
          'background task row',
        );
        await tap(find.text(command));
        await until(
          () => find.byTooltip('Refresh output').evaluate().isNotEmpty,
          'output detail',
        );
        await until(
          () => find
              .textContaining('PARITY_TASK_STARTED\n')
              .evaluate()
              .isNotEmpty,
          'actual process output',
        );
        await until(
          () =>
              find.text('failed').evaluate().isNotEmpty &&
              find
                  .textContaining('PARITY_TASK_STARTED\nPARITY_TASK_FINISHED')
                  .evaluate()
                  .isNotEmpty,
          'status event refreshes output',
        );
        await tap(find.byTooltip('Back'));
        await until(
          () => find
              .textContaining('exit 7', findRichText: true)
              .evaluate()
              .isNotEmpty,
          'exit code retained in list',
        );
        expect(find.text('failed'), findsOneWidget);
        debugPrint('REAL_GATEWAY:tasks-native-process-output-status-and-exit');
      } finally {
        await t.pumpWidget(const SizedBox());
        await g.call('unwatch');
      }
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
