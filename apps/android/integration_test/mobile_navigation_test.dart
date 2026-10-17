import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/mobile_tabs.dart';
import 'package:pirc_mobile/live/schedules_page.dart';
import 'package:pirc_mobile/live/scoped_gateway.dart';
import 'package:pirc_mobile/live/session_sidebar.dart';
import 'package:pirc_mobile/live/settings_dialog.dart';
import 'package:pirc_mobile/theme.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'real Android phone navigation retains Schedules and selects Settings',
    (t) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      expect(const bool.fromEnvironment('PIRC_DOCUMENTS'), isTrue);
      const pairingLink = String.fromEnvironment('PIRC_PAIR_LINK');
      expect(pairingLink, isNotEmpty, reason: 'Missing private pairing link.');

      final transport = Gateway();
      var paired = false;
      Json? originalPreferences;
      Future<void> until(bool Function() ready, String label) async {
        for (var i = 0; i < 150 && !ready(); i++) {
          await t.pump(const Duration(milliseconds: 200));
        }
        expect(ready(), isTrue, reason: label);
        await t.pumpAndSettle();
        expect(t.takeException(), isNull, reason: label);
      }

      try {
        await transport.call('pair', {'link': pairingLink});
        paired = true;
        await transport.call('completeOnboarding');
        originalPreferences = obj(await transport.call('preferences'));
        await transport.call('savePreferences', {'mode': 'chat'});

        final controller = LiveController(DartScopedGateway(transport));
        final theme = await PircTheme.load();
        await t.pumpWidget(MobileApp(theme: theme, controller: controller));
        await until(
          () =>
              !controller.booting &&
              controller.origin != null &&
              controller.workspaces.isNotEmpty,
          'paired native app loads the real workspace list',
        );
        expect(
          controller.workspaces.any(
            (workspace) =>
                workspace['kind'] == 'chat' &&
                workspace['id'] == '${workspace['hostId']}:chats',
          ),
          isTrue,
          reason: 'The real helper must expose its default Chats workspace.',
        );

        final tabs = find.byType(MobileTabs);
        Future<void> chooseTab(String name) async {
          final tab = find.descendant(of: tabs, matching: find.text(name));
          await t.ensureVisible(tab);
          expect(tab.hitTestable(), findsOneWidget);
          await t.tap(tab);
          await t.pumpAndSettle();
          expect(t.takeException(), isNull, reason: 'Selecting $name');
        }

        await chooseTab('Schedules');
        await until(
          () => find.byType(SchedulesPage).evaluate().isNotEmpty,
          'Schedules page opens',
        );
        expect(t.widget<MobileTabs>(tabs).current, 'schedules');
        final schedulesState = t.state(find.byType(SchedulesPage));

        await chooseTab('Work');
        await until(
          () => find.byType(SessionSidebar).evaluate().isNotEmpty,
          'Work opens the phone navigation list',
        );
        expect(t.widget<MobileTabs>(tabs).current, 'work');
        expect(
          t.state(find.byType(SchedulesPage, skipOffstage: false)),
          same(schedulesState),
          reason: 'Opening the list must retain the underlying page instance.',
        );

        await chooseTab('Settings');
        await until(
          () => find.byType(NativeSettingsDialog).evaluate().isNotEmpty,
          'Settings opens above the phone navigation list',
        );
        expect(t.widget<MobileTabs>(tabs).current, 'settings');

        await t.binding.handlePopRoute();
        await t.pumpAndSettle();
        expect(find.byType(NativeSettingsDialog), findsNothing);
        expect(t.widget<MobileTabs>(tabs).current, 'work');
        expect(
          t.state(find.byType(SchedulesPage, skipOffstage: false)),
          same(schedulesState),
        );

        await t.binding.handlePopRoute();
        await t.pumpAndSettle();
        expect(find.byType(SessionSidebar), findsNothing);
        expect(find.byType(SchedulesPage), findsOneWidget);
        expect(t.state(find.byType(SchedulesPage)), same(schedulesState));
        expect(t.widget<MobileTabs>(tabs).current, 'schedules');
        expect(t.takeException(), isNull);
      } finally {
        await t.pumpWidget(const SizedBox());
        if (originalPreferences != null) {
          await transport.call('savePreferences', originalPreferences);
        }
        if (paired) await transport.call('unpair');
      }
    },
  );
}
