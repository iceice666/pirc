import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/schedules_page.dart';
import 'package:pirc_mobile/theme.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'Android schedules UI creates, edits, pauses, runs and deletes on real gateway',
    (t) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      final g = Gateway();
      await g.call('pair', {
        'link': const String.fromEnvironment('PIRC_PAIR_LINK'),
      });
      await g.call('completeOnboarding');
      final preferences = obj(await g.call('preferences'));
      await g.call('savePreferences', {'appearance': 'light', 'mode': 'chat'});
      final c = LiveController(g), theme = await PircTheme.load();
      String? scheduleId;
      final sessions = <String>{};
      Future<void> until(bool Function() ready, String step) async {
        for (var i = 0; i < 150 && !ready(); i++) {
          await t.pump(const Duration(milliseconds: 200));
        }
        expect(ready(), isTrue, reason: step);
        expect(t.takeException(), isNull, reason: step);
      }

      Future<void> tap(Finder f) async {
        FocusManager.instance.primaryFocus?.unfocus();
        await t.pumpAndSettle();
        await t.ensureVisible(f);
        await t.pumpAndSettle();
        expect(f.hitTestable(), findsOneWidget);
        await t.tap(f);
        await t.pumpAndSettle();
      }

      Future<void> button(String label) async =>
          tap(find.widgetWithText(TextButton, label));
      Future<Json> current() async => obj(
        (await g.request('/api/schedules/${enc(scheduleId!)}'))['schedule'],
      );
      try {
        await t.pumpWidget(MobileApp(theme: theme, controller: c));
        await until(
          () => !c.booting && c.workspaces.isNotEmpty,
          'boot paired gateway',
        );
        await tap(find.text('Schedules'));
        await until(
          () => find.text('New schedule').evaluate().isNotEmpty,
          'load schedule page',
        );
        await button('New schedule');
        await until(
          () => find.byType(ScheduleForm).evaluate().isNotEmpty,
          'inline editor',
        );
        Future<void> field(String name, String value) async {
          final f = find.byKey(ValueKey('schedule-field-$name'));
          await t.ensureVisible(f);
          await t.pumpAndSettle();
          await t.enterText(f, value);
          await t.pumpAndSettle();
        }

        await field('Title', 'Native schedule UI');
        await field('Prompt', 'Inspect this isolated test workspace.');
        await field('Time zone', 'Asia/Taipei');
        await button('Create');
        await until(
          () => find.byType(ScheduleForm).evaluate().isEmpty,
          'create acknowledged',
        );
        final listed = rows((await g.request('/api/schedules'))['schedules']);
        scheduleId =
            '${listed.singleWhere((s) => s['title'] == 'Native schedule UI')['id']}';
        expect((await current())['cron'], '0 9 * * *');
        expect((await current())['timezone'], 'Asia/Taipei');
        await button('Pause');
        await until(
          () => find.text('Resume').evaluate().isNotEmpty,
          'pause acknowledged',
        );
        expect((await current())['status'], 'paused');
        await button('Resume');
        await until(
          () => find.text('Pause').evaluate().isNotEmpty,
          'resume acknowledged',
        );
        expect((await current())['status'], 'active');
        await button('Edit');
        await field('Title', 'Edited native schedule');
        await tap(find.text('Once'));
        final wall = await g.call('wallInput', {
          'at': DateTime.now().millisecondsSinceEpoch + 86400000,
          'timezone': 'Asia/Taipei',
        });
        await field('Time', '$wall');
        await button('Save');
        await until(
          () => find.byType(ScheduleForm).evaluate().isEmpty,
          'save acknowledged',
        );
        final saved = await current();
        expect(saved['title'], 'Edited native schedule');
        expect(saved['cron'], isNull);
        expect(saved['runAt'], isA<num>());
        final savedWall = await g.call('wallInput', {
          'at': saved['runAt'],
          'timezone': 'Asia/Taipei',
        });
        expect(savedWall, wall);
        await button('Run now');
        await button('Runs');
        List<Json> runs = [];
        for (var i = 0; i < 100 && runs.isEmpty; i++) {
          runs = rows(
            (await g.request('/api/schedules/${enc(scheduleId)}'))['runs'],
          );
          await t.pump(const Duration(milliseconds: 200));
        }
        expect(runs, isNotEmpty);
        for (final run in runs) {
          if (run['sessionId'] != null) sessions.add('${run['sessionId']}');
        }
        await until(
          () => find.text('Open session').evaluate().isNotEmpty,
          'native run history',
        );
        await button('Delete');
        expect((await current())['id'], scheduleId);
        await button('Delete for good');
        await until(
          () => find.byKey(ValueKey('schedule-$scheduleId')).evaluate().isEmpty,
          'delete acknowledged',
        );
        expect(
          rows(
            (await g.request('/api/schedules'))['schedules'],
          ).any((s) => s['id'] == scheduleId),
          isFalse,
        );
        scheduleId = null;
        debugPrint(
          'SCHEDULES:real Android create/edit/once timezone/pause/resume/run/history/delete passed',
        );
      } finally {
        if (scheduleId != null) {
          final data = await g.request('/api/schedules/${enc(scheduleId)}');
          for (final run in rows(data['runs'])) {
            if (run['sessionId'] != null) sessions.add('${run['sessionId']}');
          }
          await g.request(
            '/api/schedules/${enc(scheduleId)}',
            method: 'DELETE',
          );
        }
        for (final session in sessions) {
          await g.request('/api/sessions/${enc(session)}', method: 'DELETE');
        }
        await t.pumpWidget(const SizedBox());
        await g.call('savePreferences', preferences);
        await g.call('unpair');
      }
    },
  );
}
