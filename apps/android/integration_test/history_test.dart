// Original idle fixture: --history (not currently constructible on public Rust).
// Public Rust stopped variant: --history-stopped via rust_history_stop_test.dart.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/conversation_earlier_messages.dart';
import 'package:pirc_mobile/live/conversation_timeline.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/theme.dart';

void main() => registerHistoryReadingTest();

// Keep the original 145-message baseline separate from the public Rust stopped
// run variant, which legitimately persists an extra aborted assistant entry.
void registerHistoryReadingTest({bool stopped = false}) {
  final count = stopped ? 146 : 145;
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    stopped
        ? 'real Android stopped history preserves pinned prefix and reading position'
        : 'real Android history pages preserve reading position',
    (t) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      const id = String.fromEnvironment('PIRC_HISTORY_SESSION');
      expect(
        id.isNotEmpty,
        isTrue,
        reason: stopped
            ? 'Start helper with --history-stopped.'
            : 'The original --history idle fixture is required.',
      );
      expect(
        const int.fromEnvironment('PIRC_HISTORY_COUNT', defaultValue: 145),
        count,
      );
      expect(const bool.fromEnvironment('PIRC_HISTORY_STOPPED'), stopped);
      final g = Gateway();
      await g.call('pair', {
        'link': const String.fromEnvironment('PIRC_PAIR_LINK'),
      });
      await g.call('completeOnboarding');
      final original = obj(await g.call('preferences'));
      await g.call('savePreferences', {
        ...original,
        'appearance': 'light',
        'mode': 'chat',
      });
      final c = LiveController(g), theme = await PircTheme.load();
      Future<void> until(bool Function() ready, String step) async {
        for (var i = 0; i < 150 && !ready(); i++) {
          await t.pump(const Duration(milliseconds: 200));
        }
        expect(ready(), isTrue, reason: '$step: ${c.error ?? c.connection}');
        expect(t.takeException(), isNull, reason: step);
      }

      try {
        await expectLater(
          g.request('/api/devices'),
          throwsA(
            isA<PlatformException>().having((e) => e.code, 'code', 'HTTP_403'),
          ),
        );
        await t.pumpWidget(MobileApp(theme: theme, controller: c));
        await until(
          () => !c.booting && c.sessions.any((s) => s['id'] == id),
          'boot',
        );
        await c.open(id);
        await until(() => c.messages.length == count, 'real ledger snapshot');
        await t.pumpAndSettle();
        expect(c.messages.map((m) => m['id']).toSet(), hasLength(count));
        for (var i = 0; i < 145; i++) {
          expect('${c.messages[i]['content']}', contains('History entry $i.'));
        }
        if (stopped) {
          expect(c.messages.last['role'], 'assistant');
          expect(c.messages.last['stopReason'], 'aborted');
          expect('${c.messages.last['content']}', isEmpty);
          expect(
            find.textContaining('Stopped', findRichText: true),
            findsOneWidget,
          );
        }
        debugPrint(
          'REAL_HISTORY:logical viewport=${t.view.physicalSize / t.view.devicePixelRatio} dpr=${t.view.devicePixelRatio}',
        );
        expect(c.hiddenMessages, count - 60);
        expect(find.byType(TimelineMessage), findsNWidgets(60));
        final scroll = t
            .widget<CustomScrollView>(find.byType(CustomScrollView))
            .controller!;
        expect(scroll.position.extentAfter, closeTo(0, .1));
        final retained = find.byKey(ValueKey('${c.messages[90]['id']}'));
        final retainedState = t.state(retained);
        final control = t.widget<ConversationEarlierMessages>(
          find.byType(ConversationEarlierMessages),
        );
        final buttonBottom =
            t.getRect(find.byKey(control.buttonKey!)).bottom -
            t.getRect(find.byType(CustomScrollView)).top +
            scroll.offset;
        scroll.jumpTo(buttonBottom + 201);
        await t.pumpAndSettle();
        expect(c.hiddenMessages, count - 60);
        scroll.jumpTo(buttonBottom + 199);
        await t.pump();
        final before = t.getRect(retained).top;
        await until(
          () => c.hiddenMessages == count - 120,
          'observer reveals next 60',
        );
        await t.pumpAndSettle();
        expect(find.byType(TimelineMessage), findsNWidgets(120));
        expect(t.getRect(retained).top, closeTo(before, .1));
        expect(t.state(retained), same(retainedState));
        // Read until the actual earlier control intersects the viewport margin.
        // This uses the production observer path, not a direct page mutation.
        final next = t.widget<ConversationEarlierMessages>(
          find.byType(ConversationEarlierMessages),
        );
        final nextBottom =
            t.getRect(find.byKey(next.buttonKey!)).bottom -
            t.getRect(find.byType(CustomScrollView)).top +
            scroll.offset;
        scroll.jumpTo(nextBottom + 199);
        await t.pump();
        final beforeFinal = t.getRect(retained).top;
        await until(
          () => c.hiddenMessages == 0,
          'observer reveals final ${count - 120}',
        );
        await t.pumpAndSettle();
        expect(find.byType(TimelineMessage), findsNWidgets(count));
        expect(find.byType(ConversationEarlierMessages), findsNothing);
        expect(t.getRect(retained).top, closeTo(beforeFinal, .1));
        expect(t.state(retained), same(retainedState));
        await c.open(id);
        expect(c.hiddenMessages, 0);
        await c.home();
        await t.pumpAndSettle();
        await c.open(id);
        await until(() => c.messages.length == count, 'reopen history');
        await t.pumpAndSettle();
        expect(c.hiddenMessages, count - 60);
        expect(find.byType(TimelineMessage), findsNWidgets(60));
        expect(scroll.position.extentAfter, closeTo(0, .1));
        debugPrint(
          'REAL_HISTORY:$count messages, 60/120/$count pages; anchors preserved; reopen reset; stopped=$stopped.',
        );
      } finally {
        await g.call('savePreferences', original);
        await t.pumpWidget(const SizedBox());
        await g.call('unwatch');
        await g.call('unpair');
      }
    },
  );
}
