import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/app_document_route.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/session_sidebar.dart';
import 'package:pirc_mobile/live/workspace_page.dart';
import 'app_document_live_routes_test.dart' show RouteGateway, finish, scope;
import 'live_test.dart' show theme;

Future<void> _openDocumentRoute(WidgetTester tester, String url) async {
  final route = NativeAppDocumentRoute.parse(
    url,
    appRootUrl: 'https://gateway.example/',
    allowSpaFallback: true,
  )!;
  await scope(tester).windows.onAppRoute!(route);
  await tester.pumpAndSettle();
  expect(scope(tester).documentUrl, url);
}

SessionSidebar _sidebar(WidgetTester tester) => tester.widget<SessionSidebar>(
  find.byType(SessionSidebar, skipOffstage: false).first,
);

void _setPhoneViewport(WidgetTester tester) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(390, 844);
  addTearDown(tester.view.reset);
}

void main() {
  testWidgets(
    'opening a session keeps the index path and list opening keeps its address',
    (tester) async {
      _setPhoneViewport(tester);
      final gateway = RouteGateway();
      final controller = LiveController(gateway);
      await tester.pumpWidget(MobileApp(theme: theme, controller: controller));
      await tester.pumpAndSettle();

      await _openDocumentRoute(
        tester,
        'https://gateway.example/index.html?workspace=work-local&trace=old#week',
      );
      _sidebar(tester).onOpen('session-second');
      await tester.pumpAndSettle();

      expect(controller.sessionId, 'session-second');
      expect(
        scope(tester).documentUrl,
        'https://gateway.example/index.html?session=session-second',
      );

      await tester.tap(find.byTooltip('Back to the list'));
      await tester.pumpAndSettle();

      expect(controller.sessionId, 'session-second');
      expect(controller.sessionVisible, isFalse);
      expect(
        scope(tester).documentUrl,
        'https://gateway.example/index.html?session=session-second',
      );
      expect(tester.takeException(), isNull);
      await finish(tester, gateway, controller);
    },
  );

  testWidgets(
    'opening a workspace keeps its deep path and replaces query and fragment',
    (tester) async {
      _setPhoneViewport(tester);
      final gateway = RouteGateway();
      final controller = LiveController(gateway);
      await tester.pumpWidget(MobileApp(theme: theme, controller: controller));
      await tester.pumpAndSettle();

      await _openDocumentRoute(
        tester,
        'https://gateway.example/projects/notes?workspace=home%3Anotes&trace=old#section',
      );
      _sidebar(tester).onWorkspace('work-local');
      await tester.pumpAndSettle();

      expect(controller.sessionId, 'session-latest');
      final workspace = tester.widget<WorkspacePage>(
        find.byType(WorkspacePage).first,
      );
      expect(workspace.workspaceId, 'work-local');
      expect(
        scope(tester).documentUrl,
        'https://gateway.example/projects/notes?workspace=work-local',
      );
      expect(tester.takeException(), isNull);
      await finish(tester, gateway, controller);
    },
  );
}
