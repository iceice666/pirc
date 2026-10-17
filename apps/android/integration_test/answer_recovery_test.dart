// Real native HTTP with the private helper's explicit answer-fault mode.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/interaction_card.dart';
import 'package:pirc_mobile/theme.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('real Android uncertain answers require deliberate reconciliation', (
    t,
  ) async {
    expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
    expect(const bool.fromEnvironment('PIRC_ANSWER_RECOVERY'), isTrue);
    final g = Gateway();
    await g.call('pair', {
      'link': const String.fromEnvironment('PIRC_PAIR_LINK'),
    });
    await g.call('completeOnboarding');
    final c = LiveController(g), theme = await PircTheme.load();
    String? created;
    Future<void> until(bool Function() ready, String step) async {
      for (var i = 0; i < 200 && !ready(); i++) {
        await t.pump(const Duration(milliseconds: 200));
      }
      expect(
        ready(),
        isTrue,
        reason: '$step: ${c.error ?? c.actionError ?? c.connection}',
      );
      expect(t.takeException(), isNull, reason: step);
    }

    Future<void> tap(Finder f) async {
      await t.ensureVisible(f);
      await t.pump();
      expect(f.hitTestable(), findsOneWidget);
      await t.tap(f);
      await t.pump();
    }

    Future<Json> faultStatus() async =>
        obj(await g.request('/api/parity/answer-fault'));
    Future<void> arm(String mode) async {
      final armed = obj(
        await g.request('/api/parity/answer-fault?mode=$mode', method: 'POST'),
      );
      expect(armed, {'armed': mode, 'forwards': 0, 'faults': 0});
    }

    Future<void> beginQuestion() async {
      await until(() => c.canWrite, 'control available');
      c.editDraft('/parity-question');
      await c.send('prompt');
      await until(
        () => c.canWrite && c.questions.any((q) => q['kind'] == 'select'),
        'select ready',
      );
    }

    Future<void> finishQuestion() async {
      await until(
        () => c.canWrite && c.questions.any((q) => q['kind'] == 'input'),
        'input ready',
      );
      final field = find.descendant(
        of: find.byType(NativeInteractionCard),
        matching: find.byType(TextField),
      );
      await t.ensureVisible(field);
      await t.enterText(field, 'Deliberate native retry');
      await tap(find.widgetWithText(TextButton, 'Submit'));
      await until(() => !c.running && c.questions.isEmpty, 'run finished');
    }

    try {
      await t.pumpWidget(MobileApp(theme: theme, controller: c));
      await until(
        () => !c.booting && !c.initializing && c.workspaces.isNotEmpty,
        'boot',
      );
      final workspace = c.workspaces.firstWhere((w) => w['kind'] == 'chat');
      final result = await g.request(
        '/api/sessions',
        method: 'POST',
        body: {'workspaceId': workspace['id']},
      );
      created = '${obj(result['session'])['id']}';
      await c.refreshList();
      await c.open(created);
      await beginQuestion();
      await tap(find.text('Tablet'));
      await arm('before-forward');
      await tap(find.widgetWithText(TextButton, 'Submit'));
      await until(
        () => find
            .textContaining('The answer may have been received')
            .evaluate()
            .isNotEmpty,
        'unknown delivery',
      );
      expect((await faultStatus())['forwards'], 0);
      expect((await faultStatus())['faults'], 1);
      expect(
        t
            .widget<TextButton>(find.widgetWithText(TextButton, 'Submit'))
            .onPressed,
        isNull,
      );
      await t.pump(const Duration(milliseconds: 600));
      expect(
        (await faultStatus())['forwards'],
        0,
        reason: 'No automatic replay',
      );
      await tap(find.widgetWithText(TextButton, 'Check latest state'));
      await until(
        () =>
            t
                .widget<TextButton>(find.widgetWithText(TextButton, 'Submit'))
                .onPressed !=
            null,
        'pending reconciliation unlocks explicit retry',
      );
      expect(
        (await faultStatus())['forwards'],
        0,
        reason: 'Reconciliation is read-only',
      );
      await tap(find.widgetWithText(TextButton, 'Submit'));
      await until(
        () => c.questions.any((q) => q['kind'] == 'input'),
        'explicit retry accepted',
      );
      expect((await faultStatus())['forwards'], 1);
      await finishQuestion();

      await beginQuestion();
      final q = c.questions.firstWhere((q) => q['kind'] == 'select');
      final args = <String, dynamic>{
        'sessionId': created,
        'interactionId': q['id'],
        'epoch': q['epoch'],
        'origin': c.origin,
        'pairingStamp': c.pairingStamp,
        'answer': {
          'values': [
            rows(
              q['options'],
            ).firstWhere((o) => o['label'] == 'Tablet')['value'],
          ],
        },
      };
      await arm('after-accept');
      await expectLater(
        g.call('answer', args),
        throwsA(isA<PlatformException>()),
      );
      await until(
        () => c.questions.any((q) => q['kind'] == 'input'),
        'accepted response lost still advances server',
      );
      expect((await faultStatus())['forwards'], 1);
      expect((await faultStatus())['faults'], 1);
      // Reopening a stale card/call still sees the persisted marker before the
      // now-absent question is validated, so the user can reconcile it.
      await expectLater(
        g.call('answer', args),
        throwsA(
          isA<PlatformException>().having(
            (e) => obj(e.details)['code'],
            'code',
            'outcome_unknown',
          ),
        ),
      );
      expect((await faultStatus())['forwards'], 1);
      final reconciled = obj(await g.call('reconcileAnswer', args));
      expect(reconciled['sessionId'], created);
      expect(reconciled['status'], 'resolved');
      expect(
        (await faultStatus())['forwards'],
        1,
        reason: 'Accepted answer never replayed',
      );
      await finishQuestion();
      debugPrint(
        'REAL_ANSWER_RECOVERY: unaccepted/accepted response loss; explicit reconciliation; no automatic POST.',
      );
    } finally {
      if (created != null) {
        await c.home();
        await g.request(sessionPath(created), method: 'DELETE');
      }
      await t.pumpWidget(const SizedBox());
      await g.call('unwatch');
      await g.call('unpair');
    }
  });
}
