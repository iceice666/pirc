import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/session_sidebar.dart';
import 'package:pirc_mobile/live/workspace_page.dart';
import 'package:pirc_mobile/live/workspace_settings.dart';
import 'navigation_parity_test.dart' show NavigationGateway;
import 'live_test.dart' show theme;

Finder sidebarMode(String label) => find
    .descendant(of: find.byType(SessionSidebar), matching: find.text(label))
    .hitTestable();

void main() {
  for (final width in [768.0, 1024.0]) {
    testWidgets(
      'sidebar mode at $width retains conversation, draft and panel',
      (tester) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = Size(width, 900);
        addTearDown(tester.view.reset);
        final gateway = NavigationGateway();
        final controller = LiveController(gateway);
        await tester.pumpWidget(
          MobileApp(theme: theme, controller: controller),
        );
        await tester.pumpAndSettle();
        await controller.setMode('work');
        await controller.open('s');
        gateway.publish('s');
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const Key('live-draft')),
          'retained desktop draft',
        );
        await tester.tap(find.byTooltip('Show side panel'));
        await tester.pumpAndSettle();
        final watches = gateway.calls
            .where((call) => call.$1 == 'watch')
            .length;
        // The tablet overlay covers the sidebar; close only its scrim to return
        // to the same conversation before switching the sidebar's mode.
        if (width <= 860) {
          await tester.tap(find.byTooltip('Hide side panel'));
          await tester.pumpAndSettle();
        }
        await tester.tap(sidebarMode('Chat'));
        await tester.pumpAndSettle();
        expect(controller.mode, 'chat');
        expect(controller.sessionId, 's');
        expect(find.byKey(const Key('live-draft')), findsOneWidget);
        expect(find.text('retained desktop draft'), findsOneWidget);
        if (width > 860) {
          expect(find.byTooltip('Hide side panel'), findsOneWidget);
        }
        expect(
          gateway.calls.where((call) => call.$1 == 'watch').length,
          watches,
        );
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        await gateway.stream.close();
      },
    );

    testWidgets('sidebar mode at $width retains workspace settings tab', (
      tester,
    ) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = Size(width, 900);
      addTearDown(tester.view.reset);
      final gateway = NavigationGateway();
      final controller = LiveController(gateway);
      await tester.pumpWidget(MobileApp(theme: theme, controller: controller));
      await tester.pumpAndSettle();
      await controller.setMode('work');
      await tester.pumpAndSettle();
      await tester.tap(
        find
            .descendant(
              of: find.byType(SessionSidebar),
              matching: find.text('Workspace'),
            )
            .first,
      );
      await tester.pumpAndSettle();
      expect(find.byType(WorkspacePage), findsOneWidget);
      await tester.tap(
        find.descendant(
          of: find.byType(WorkspacePage),
          matching: find.text('Settings'),
        ),
      );
      await tester.pumpAndSettle();
      final original = tester.state(find.byType(WorkspaceSettings));
      await tester.tap(sidebarMode('Chat'));
      await tester.pumpAndSettle();
      expect(controller.mode, 'chat');
      expect(find.byType(WorkspacePage), findsOneWidget);
      expect(tester.state(find.byType(WorkspaceSettings)), same(original));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      await gateway.stream.close();
    });
  }
}
