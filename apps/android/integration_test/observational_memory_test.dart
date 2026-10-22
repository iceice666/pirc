import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/side_panel.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/observational_memory_pane.dart';
import 'package:pirc_mobile/theme.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'real Android observational memory ledger, filters and expansion',
    (t) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      const id = String.fromEnvironment('PIRC_FILES_SESSION');
      expect(
        id.isNotEmpty,
        isTrue,
        reason: 'Run helper with --observational-memory.',
      );
      final g = Gateway();
      await g.call('pair', {
        'link': const String.fromEnvironment('PIRC_PAIR_LINK'),
      });
      await g.call('completeOnboarding');
      final preferences = obj(await g.call('preferences'));
      await g.call('savePreferences', {...preferences, 'mode': 'chat'});
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
        await t.pumpAndSettle();
        expect(target, findsOneWidget);
        await t.ensureVisible(target);
        await t.pumpAndSettle();
        expect(target.hitTestable(), findsOneWidget);
        await t.tap(target);
        await t.pumpAndSettle();
      }

      try {
        await t.pumpWidget(MobileApp(theme: theme, controller: c));
        await until(
          () =>
              !c.booting &&
              !c.initializing &&
              c.sessions.any((s) => s['id'] == id),
          'boot fixture',
        );
        await t.pumpAndSettle();
        final backToList = find.byTooltip('Back to the list');
        if (backToList.evaluate().isNotEmpty) await tap(backToList);
        final fixtureSession = c.sessions.singleWhere(
          (session) => session['id'] == id,
        );
        await tap(find.text('${fixtureSession['name']}'));
        await until(
          () =>
              c.sessionId == id &&
              c.state.isNotEmpty &&
              find.byType(NativeSidePanel).evaluate().isNotEmpty,
          'open fixture',
        );
        await tap(find.byKey(const ValueKey('panel-tab-memory')));
        await until(
          () =>
              find.byType(ObservationalMemoryPane).evaluate().isNotEmpty &&
              find
                  .byKey(const ValueKey('memory-filter-all'))
                  .evaluate()
                  .isNotEmpty,
          'real memory state',
        );
        final panel = await g.request('${sessionPath(id)}/panel/state'),
            memory = obj(panel['memory']);
        expect(memory['enabled'], true);
        expect(obj(memory['counts'])['active'], 2);
        expect(obj(memory['counts'])['dropped'], 1);
        expect(obj(memory['counts'])['reflections'], 2);
        final observations = rows(memory['observations']);
        final longObservation = observations.singleWhere(
          (entry) => '${entry['content']}'.contains('**plain text**'),
        );
        final droppedObservation = observations.singleWhere(
          (entry) => entry['dropped'] == true,
        );
        expect(longObservation['dropped'], isNot(true));
        expect('${longObservation['id']}', matches(RegExp(r'^[a-f0-9]{12}$')));
        expect(
          '${droppedObservation['id']}',
          matches(RegExp(r'^[a-f0-9]{12}$')),
        );
        if (memory['passive'] == true) {
          expect(
            find.byKey(const ValueKey('memory-status-chip-Passive')),
            findsOneWidget,
          );
        }

        final all = find.byKey(const ValueKey('memory-filter-all'));
        await t.scrollUntilVisible(
          all,
          250,
          scrollable: find
              .descendant(
                of: find.byType(ObservationalMemoryPane),
                matching: find.byType(Scrollable),
              )
              .first,
        );
        await tap(all);
        final dropped = find.byKey(
          ValueKey('memory-entry-${droppedObservation['id']}'),
        );
        await tap(dropped);
        expect(
          find.textContaining('· dropped', findRichText: true),
          findsOneWidget,
        );
        await tap(find.byKey(const ValueKey('memory-filter-active')));
        final long = find.byKey(
          ValueKey('memory-entry-${longObservation['id']}'),
        );
        await tap(long);
        final body = find
            .descendant(of: long, matching: find.byType(Text))
            .first;
        expect(t.widget<Text>(body).maxLines, isNull);
        expect(
          t.widget<Text>(body).textSpan!.toPlainText(),
          contains('**plain text**'),
        );
        await tap(find.byKey(const ValueKey('panel-tab-context')));
        await tap(find.byKey(const ValueKey('panel-tab-memory')));
        await until(
          () => find
              .byKey(ValueKey('memory-entry-${longObservation['id']}'))
              .evaluate()
              .isNotEmpty,
          'return to memory',
        );
        expect(t.widget<Text>(body).maxLines, isNull);
        debugPrint(
          'REAL_GATEWAY:observational-memory-native-ledger-filter-expand-preserve',
        );
      } finally {
        await t.pumpWidget(const SizedBox());
        await g.call('unwatch');
      }
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
