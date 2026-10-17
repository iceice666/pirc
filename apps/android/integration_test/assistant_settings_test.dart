// Opt-in: only the disposable real_gateway.ts environment. Restores both files.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/assistant_settings.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/settings_dialog.dart';
import 'package:pirc_mobile/live/provider_editor.dart';
import 'package:pirc_mobile/live/provider_login.dart';
import 'package:pirc_mobile/theme.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'real Android assistant settings read, edit, reload, restore',
    (t) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      const link = String.fromEnvironment('PIRC_PAIR_LINK');
      expect(link.isNotEmpty, isTrue);
      final g = Gateway();
      await g.call('pair', {'link': link});
      await g.call('completeOnboarding');
      final preferences = obj(await g.call('preferences'));
      await g.call('savePreferences', {'appearance': 'light'});
      final c = LiveController(g);
      final theme = await PircTheme.load();
      final initial = await g.request('/api/assistant/prompts');
      final node = initial['nodeId'];
      expect(node, isNotNull);
      final edited = <String>[];
      Future<void> until(bool Function() ready) async {
        for (var i = 0; i < 150 && !ready(); i++) {
          await t.pump(const Duration(milliseconds: 200));
        }
        expect(ready(), isTrue);
        expect(t.takeException(), isNull);
      }

      Future<void> waitForUnauthenticatedManagement() async {
        await until(
          () =>
              find
                  .byKey(const ValueKey('native-management-access'))
                  .evaluate()
                  .isNotEmpty &&
              find
                  .byKey(const ValueKey('native-management-begin'))
                  .evaluate()
                  .isNotEmpty,
        );
        await t.pumpAndSettle();
      }

      try {
        await t.pumpWidget(MobileApp(theme: theme, controller: c));
        await until(() => !c.booting && c.workspaces.isNotEmpty);
        await t.tap(find.text('Settings'));
        await until(
          () => find.byType(NativeSettingsDialog).evaluate().isNotEmpty,
        );
        final toggle = find.byType(Checkbox);
        final prior = c.preferences['showSettled'] == true;
        await t.tap(toggle);
        await until(() => c.preferences['showSettled'] == !prior);
        expect(obj(await g.call('preferences'))['showSettled'], !prior);
        await t.tap(find.byKey(const ValueKey('settings-tab-Models')));
        await waitForUnauthenticatedManagement();
        expect(
          find.text(
            'Backend request failed (403). Check your settings and try again.',
          ),
          findsOneWidget,
        );
        expect(find.text('Retry settings'), findsOneWidget);
        expect(find.byType(ProviderLogin), findsNothing);
        expect(find.byType(ProviderEditor), findsNothing);
        expect(find.text('Add backend'), findsNothing);
        expect(find.text('Default model'), findsNothing);
        expect(find.text('Gateway default'), findsNothing);
        expect(find.text('Save default'), findsNothing);

        await t.tap(find.byKey(const ValueKey('settings-tab-Devices')));
        await waitForUnauthenticatedManagement();
        expect(find.byKey(const ValueKey('device-pairing-card')), findsNothing);
        expect(
          find.byWidgetPredicate((widget) {
            final key = widget.key;
            return key is ValueKey<String> &&
                key.value.startsWith('paired-device-');
          }),
          findsNothing,
        );
        expect(
          find.byWidgetPredicate(
            (widget) => widget is AssistantButton && widget.label == 'Revoke',
          ),
          findsNothing,
        );
        debugPrint(
          'REAL_GATEWAY:settings-categories-preferences-and-unauthenticated-management',
        );
        await t.ensureVisible(find.text('Assistant'));
        await t.tap(find.text('Assistant'));
        await until(
          () => find.byType(AssistantPromptEditor).evaluate().length == 2,
        );
        for (final name in ['soul', 'chat']) {
          final original = obj(initial[name]);
          expect(original['writable'], isTrue);
          final field = find.byKey(ValueKey('assistant-$name-text'));
          final editor = find.ancestor(
            of: field,
            matching: find.byType(AssistantPromptEditor),
          );
          expect(t.widget<TextField>(field).controller!.text, original['text']);
          final draft =
              '${original['text']}\nNative Android assistant verification: $name.';
          edited.add(name);
          await t.ensureVisible(field);
          await t.enterText(field, draft);
          await t.testTextInput.receiveAction(TextInputAction.done);
          await t.pumpAndSettle();
          final save = find.descendant(
            of: editor,
            matching: find.widgetWithText(TextButton, 'Save'),
          );
          await t.ensureVisible(save);
          await t.pumpAndSettle();
          expect(save.hitTestable(), findsOneWidget);
          await t.tap(save);
          await until(
            () => find
                .descendant(
                  of: editor,
                  matching: find.text(
                    'Saved. Applies at the next chat agent start.',
                  ),
                )
                .evaluate()
                .isNotEmpty,
          );
          final persisted = await g.request('/api/assistant/prompts');
          expect(persisted['nodeId'], node);
          expect(obj(persisted[name])['text'], draft.trim());
        }
        await t.ensureVisible(find.widgetWithText(TextButton, 'Refresh'));
        await t.tap(find.widgetWithText(TextButton, 'Refresh'));
        await until(
          () => find.byType(AssistantPromptEditor).evaluate().length == 2,
        );
        for (final name in ['soul', 'chat']) {
          expect(
            t
                .widget<TextField>(find.byKey(ValueKey('assistant-$name-text')))
                .controller!
                .text,
            contains('Native Android assistant verification: $name.'),
          );
        }
        debugPrint('REAL_GATEWAY:assistant-native-entry-save-both-reload');
      } finally {
        for (final name in edited) {
          await g.request(
            '/api/assistant/prompts/$name',
            method: 'PUT',
            body: {'text': obj(initial[name])['text'], 'nodeId': node},
          );
        }
        final restored = await g.request('/api/assistant/prompts');
        for (final name in ['soul', 'chat']) {
          expect(obj(restored[name])['text'], obj(initial[name])['text']);
        }
        await t.pumpWidget(const SizedBox());
        await g.call('savePreferences', preferences);
        debugPrint('REAL_GATEWAY:assistant-originals-restored');
      }
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
