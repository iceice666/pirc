// Only the disposable real_gateway.ts environment; the host stops its owned
// chat process before release, as the production warning instructs.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/assistant_settings.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/theme.dart';

class _ReleaseGateway extends Gateway {
  final releases = <Json>[];
  @override
  Future<dynamic> call(String method, [Json args = const {}]) {
    if (method == 'request' &&
        args['method'] == 'POST' &&
        args['path'] == '/api/assistant/node/release') {
      releases.add(Map<String, dynamic>.from(args));
    }
    return super.call(method, args);
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'Android Assistant cancel preserves binding and confirmed release detaches exact node',
    (t) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      expect(
        const bool.fromEnvironment('PIRC_ASSISTANT_RELEASE_NODE'),
        isTrue,
        reason:
            'Use the isolated host driver to stop only its owned chat node.',
      );
      const link = String.fromEnvironment('PIRC_PAIR_LINK');
      expect(link, isNotEmpty);
      final g = _ReleaseGateway();
      await g.call('pair', {'link': link});
      await g.call('completeOnboarding');
      final preferences = obj(await g.call('preferences'));
      await g.call('savePreferences', {'appearance': 'light', 'mode': 'chat'});
      final initial = await g.request('/api/assistant/node');
      expect(initial['nodeId'], 'chat');
      expect(initial['online'], true);
      final c = LiveController(g);
      final theme = await PircTheme.load();
      Future<void> until(bool Function() ready, String step) async {
        for (var i = 0; i < 200 && !ready(); i++) {
          await t.pump(const Duration(milliseconds: 100));
        }
        expect(ready(), isTrue, reason: step);
        expect(t.takeException(), isNull, reason: step);
      }

      Future<void> tap(String label) async {
        final button = find.widgetWithText(TextButton, label);
        await t.ensureVisible(button);
        await t.pumpAndSettle();
        expect(button.hitTestable(), findsOneWidget);
        await t.tap(button);
        await t.pumpAndSettle();
      }

      try {
        await t.pumpWidget(MobileApp(theme: theme, controller: c));
        await until(
          () => !c.booting && c.workspaces.isNotEmpty,
          'app bootstrap',
        );
        await t.tap(find.text('Settings'));
        await t.pumpAndSettle();
        final assistantTab = find.byKey(
          const ValueKey('settings-tab-Assistant'),
        );
        await t.ensureVisible(assistantTab);
        await t.tap(assistantTab);
        await until(
          () => find.byType(AssistantPromptEditor).evaluate().length == 2,
          'Assistant node and prompts loaded',
        );
        await tap('Release chat node binding');
        expect(find.textContaining('Stop the old chat node'), findsOneWidget);
        expect(g.releases, isEmpty);
        await tap('Cancel');
        expect(g.releases, isEmpty);
        final unchanged = await g.request('/api/assistant/node');
        expect(unchanged, initial);
        expect(find.byType(AssistantPromptEditor), findsNWidgets(2));
        debugPrint('ASSISTANT_RELEASE_CANCEL_PRESERVED');

        await tap('Release chat node binding');
        expect(find.textContaining('Stop the old chat node'), findsOneWidget);
        debugPrint('ASSISTANT_RELEASE_STOP_NODE');
        var offline = false;
        for (var i = 0; i < 200 && !offline; i++) {
          final binding = await g.request('/api/assistant/node');
          expect(binding['nodeId'], initial['nodeId']);
          offline = binding['online'] == false;
          if (!offline) await t.pump(const Duration(milliseconds: 100));
        }
        expect(
          offline,
          isTrue,
          reason: 'Host must stop its own node before release',
        );
        await tap('Confirm release');
        await until(
          () => find
              .text('No chat node is bound. Start a chat node to register it.')
              .evaluate()
              .isNotEmpty,
          'release state visible',
        );
        expect(g.releases, hasLength(1));
        expect(g.releases.single['body'], {'nodeId': initial['nodeId']});
        expect(find.byType(AssistantPromptEditor), findsNothing);
        final released = await g.request('/api/assistant/node');
        expect(released, {'nodeId': null, 'online': false});
        await tap('Refresh');
        expect(
          find.text('No chat node is bound. Start a chat node to register it.'),
          findsOneWidget,
        );
        expect(
          g.releases,
          hasLength(1),
          reason: 'Refresh must not replay the release',
        );
        expect(await g.request('/api/assistant/node'), released);
        expect(t.takeException(), isNull);
        debugPrint('ASSISTANT_RELEASE_CONFIRMED_NO_REPLAY');
      } finally {
        await t.pumpWidget(const SizedBox());
        await g.call('unwatch');
        await g.call('savePreferences', preferences);
      }
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
