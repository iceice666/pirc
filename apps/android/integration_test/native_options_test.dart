// Uses only the disposable real_gateway.ts device and restores all preferences.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/permissions.dart';
import 'package:pirc_mobile/live/settings.dart';
import 'package:pirc_mobile/live/settings_dialog.dart';
import 'package:pirc_mobile/theme.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'real Android app options, appearance, permission truth and notification preferences',
    (t) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      final g = Gateway();
      await g.call('pair', {
        'link': const String.fromEnvironment('PIRC_PAIR_LINK'),
      });
      await g.call('completeOnboarding');
      final previous = obj(await g.call('preferences'));
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

      try {
        await g.call('savePreferences', {
          'appearance': 'light',
          'sidebarCollapsed': false,
          'q': true,
        });
        await t.pumpWidget(MobileApp(theme: theme, controller: c));
        await until(() => !c.booting && c.workspaces.isNotEmpty, 'paired app');
        await tap(find.text('Settings'));
        expect(find.byType(NativeSettingsDialog), findsOneWidget);
        await tap(find.byKey(const ValueKey('settings-tab-About')));
        await tap(find.text('App options'));
        expect(find.byType(SettingsContent), findsOneWidget);
        await tap(find.text('外觀'));
        await tap(find.text('深色'));
        await until(
          () => c.preferences['appearance'] == 'dark',
          'dark appearance persisted',
        );
        expect(obj(await g.call('preferences'))['appearance'], 'dark');
        expect(
          Theme.of(t.element(find.byType(SettingsContent))).brightness,
          Brightness.dark,
        );
        expect(find.text('深色'), findsOneWidget);
        final os = obj(await g.call('permissions'));
        await tap(find.text('權限與快速回應'));
        await until(
          () =>
              find
                  .byKey(const Key('permission-status-overlay'))
                  .evaluate()
                  .isNotEmpty &&
              t
                      .widget<Text>(
                        find.byKey(const Key('permission-status-overlay')),
                      )
                      .data !=
                  '正在確認…',
          'read OS permission state',
        );
        for (final name in ['notifications', 'overlay']) {
          expect(
            t.widget<Text>(find.byKey(Key('permission-status-$name'))).data,
            os[name] == true ? '已開啟' : '尚未開啟',
          );
        }
        expect(find.byType(PermissionPage), findsOneWidget);
        await t.pageBack();
        await t.pumpAndSettle();
        await tap(find.text('通知'));
        await until(
          () => find.text('需要你回應').evaluate().isNotEmpty,
          'native notification preferences',
        );
        final row = find
            .ancestor(of: find.text('需要你回應'), matching: find.byType(Row))
            .first;
        await tap(find.descendant(of: row, matching: find.byType(Switch)));
        await until(
          () => c.preferences['q'] == false,
          'notification category persisted',
        );
        expect(obj(await g.call('preferences'))['q'], false);
        expect(find.byType(SnackBar), findsNothing);
        debugPrint(
          'REAL_GATEWAY:native-options-theme-permission-truth-notification-preferences',
        );
      } finally {
        await g.call('savePreferences', previous);
        await t.pumpWidget(const SizedBox());
        await g.call('unwatch');
      }
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
