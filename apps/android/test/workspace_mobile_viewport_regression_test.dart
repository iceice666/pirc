import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/mobile_tabs.dart';
import 'package:pirc_mobile/live/session_sidebar.dart';
import 'package:pirc_mobile/live/workspace_page.dart';
import 'package:pirc_mobile/live/workspace_settings.dart';
import 'package:pirc_mobile/theme.dart';

import 'live_test.dart' show FakeGateway;

final theme = PircTheme(
  jsonDecode(File('assets/design-tokens.json').readAsStringSync())
      as Map<String, dynamic>,
);

class WorkspaceViewportGateway extends FakeGateway {
  @override
  dynamic normal(String method, Json args) {
    if (method == 'request') {
      final path = '${args['path']}';
      if (path == '/api/workspaces') {
        return {
          'workspaces': [
            {
              'id': 'home:chats',
              'hostId': 'home',
              'displayName': 'Chats',
              'kind': 'chat',
            },
            {
              'id': 'home:trip',
              'hostId': 'home',
              'displayName': 'Trip planning',
              'kind': 'chat',
            },
          ],
        };
      }
      if (path == '/api/nodes') {
        return {
          'nodes': [
            {'id': 'home'},
          ],
        };
      }
      if (path == '/api/sessions') return {'sessions': []};
      if (path.endsWith('/instructions')) {
        return {
          'instructions': {'text': 'Saved instructions', 'maxChars': 8000},
        };
      }
      if (path.endsWith('/capabilities')) {
        return {
          'capabilities': {
            'version': 1,
            'delegation': true,
            'memory_search': true,
            'remote_recall': true,
            'schedules': true,
            'web_search': true,
          },
        };
      }
    }
    return super.normal(method, args);
  }
}

Future<(WorkspaceViewportGateway, LiveController)> openWorkspaceSettings(
  WidgetTester tester,
  double width,
) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 900);
  tester.view.viewPadding = const FakeViewPadding();
  tester.view.viewInsets = const FakeViewPadding();
  final gateway = WorkspaceViewportGateway();
  final controller = LiveController(gateway);
  await tester.pumpWidget(MobileApp(theme: theme, controller: controller));
  await tester.pumpAndSettle();
  final project = find.descendant(
    of: find.byType(SessionSidebar),
    matching: find.text('Trip planning'),
  );
  expect(project, findsOneWidget);
  await tester.tap(project);
  await tester.pumpAndSettle();
  expect(find.byType(WorkspacePage), findsOneWidget);
  await tester.tap(
    find.descendant(
      of: find.byType(WorkspacePage),
      matching: find.text('Settings'),
    ),
  );
  await tester.pumpAndSettle();
  expect(find.byKey(const Key('workspace-instructions-text')), findsOneWidget);
  return (gateway, controller);
}

void main() {
  for (final width in [390.0, 650.0, 651.0, 1024.0]) {
    testWidgets('MobileApp workspace viewport at $width x 900', (tester) async {
      addTearDown(tester.view.reset);
      final (gateway, _) = await openWorkspaceSettings(tester, width);
      final page = tester.getRect(find.byType(WorkspacePage));
      expect(page.top, closeTo(0, 0.01));
      expect(page.height, closeTo(900, 0.01));
      expect(page.bottom, closeTo(900, 0.01));
      if (width <= 650) {
        expect(find.byType(MobileTabs), findsOneWidget);
        final footer = tester.getRect(find.byType(MobileTabs));
        expect(footer.top, closeTo(844, 0.01));
        expect(footer.height, closeTo(56, 0.01));
      } else {
        expect(find.byType(MobileTabs), findsNothing);
      }
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      await gateway.stream.close();
    });
  }

  testWidgets('phone/desktop resize preserves Settings and an unsaved draft', (
    tester,
  ) async {
    addTearDown(tester.view.reset);
    final (gateway, _) = await openWorkspaceSettings(tester, 650);
    final page = find.byType(WorkspacePage);
    final settings = find.byType(WorkspaceSettings);
    final originalPageState = tester.state(page);
    final originalSettingsState = tester.state(settings);
    const draft = 'Unsaved instructions stay in the editor';
    final field = find.byKey(const Key('workspace-instructions-text'));
    await tester.enterText(field, draft);
    await tester.pump();

    for (final width in [651.0, 390.0]) {
      tester.view.physicalSize = Size(width, 900);
      await tester.pumpAndSettle();
      expect(tester.state(page), same(originalPageState));
      expect(tester.state(settings), same(originalSettingsState));
      expect(tester.widget<TextField>(field).controller!.text, draft);
      expect(
        find.byKey(const Key('workspace-instructions-text')),
        findsOneWidget,
      );
      expect(
        find.byType(MobileTabs),
        width <= 650 ? findsOneWidget : findsNothing,
      );
      expect(tester.takeException(), isNull);
    }
    await tester.pumpWidget(const SizedBox.shrink());
    await gateway.stream.close();
  });
}
