import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/mobile_tabs.dart';
import 'package:pirc_mobile/live/schedules_page.dart';
import 'package:pirc_mobile/live/session_sidebar.dart';
import 'package:pirc_mobile/live/settings_dialog.dart';
import 'package:pirc_mobile/live/workspace_page.dart';

import 'live_test.dart' show FakeGateway, theme;

class PageNavigationGateway extends FakeGateway {
  @override
  dynamic normal(String method, Json args) {
    if (method == 'preferences') return {'mode': 'chat'};
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
            {
              'id': 'home:files',
              'hostId': 'home',
              'displayName': 'Files',
              'kind': 'directory',
            },
          ],
        };
      }
      if (path == '/api/nodes') {
        return {
          'nodes': [
            {'id': 'home', 'online': true},
          ],
        };
      }
      if (path == '/api/sessions') {
        return {
          'sessions': [
            {
              'id': 'session-1',
              'name': 'Trip conversation',
              'workspaceId': 'home:trip',
              'updatedAt': 100,
            },
          ],
        };
      }
      if (path == '/api/schedules') return {'schedules': []};
      if (path.endsWith('/instructions')) {
        return {
          'instructions': {'text': 'saved text', 'maxChars': 8000},
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

class NoTopLevelChatsGateway extends PageNavigationGateway {
  @override
  dynamic normal(String method, Json args) {
    if (method == 'request' && args['path'] == '/api/workspaces') {
      final response = super.normal(method, args) as Map<String, dynamic>;
      final workspaces = List<Map<String, dynamic>>.from(
        response['workspaces'] as List,
      )..removeWhere((workspace) => workspace['id'] == 'home:chats');
      return {'workspaces': workspaces};
    }
    return super.normal(method, args);
  }
}

void _setPhone(WidgetTester tester) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(390, 844);
  tester.view.viewPadding = const FakeViewPadding();
  tester.view.viewInsets = const FakeViewPadding();
  addTearDown(tester.view.reset);
}

Future<(PageNavigationGateway, LiveController)> _showPhone(
  WidgetTester tester,
) async {
  final gateway = PageNavigationGateway();
  final controller = LiveController(gateway);
  await tester.pumpWidget(MobileApp(theme: theme, controller: controller));
  await tester.pumpAndSettle();
  return (gateway, controller);
}

Future<void> _openWorkspaceSettings(WidgetTester tester) async {
  final workspace = find.descendant(
    of: find.byType(SessionSidebar),
    matching: find.text('Trip planning'),
  );
  await tester.tap(workspace);
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
}

void main() {
  testWidgets(
    'Chat/Work opens phone navigation without disposing workspace editor; Escape returns to it',
    (tester) async {
      _setPhone(tester);
      final (gateway, controller) = await _showPhone(tester);
      addTearDown(() async => gateway.stream.close());

      await _openWorkspaceSettings(tester);
      final pageFinder = find.byType(WorkspacePage);
      final pageState = tester.state(pageFinder);
      final editor = find.byKey(const Key('workspace-instructions-text'));
      await tester.enterText(editor, 'unsaved instructions stay here');
      final flushesBefore = gateway.calls
          .where((call) => call.$1 == 'draft')
          .length;

      await tester.tap(
        find.descendant(
          of: find.byType(MobileTabs),
          matching: find.text('Work'),
        ),
      );
      await tester.pumpAndSettle();

      expect(controller.mode, 'work');
      expect(find.byType(SessionSidebar), findsOneWidget);
      final hiddenEditor = find.byKey(
        const Key('workspace-instructions-text'),
        skipOffstage: false,
      );
      expect(hiddenEditor.hitTestable(), findsNothing);
      final editable = tester.widget<EditableText>(
        find.descendant(
          of: hiddenEditor,
          matching: find.byType(EditableText, skipOffstage: false),
          skipOffstage: false,
        ),
      );
      expect(editable.focusNode.hasFocus, isFalse);
      expect(
        tester.state(find.byType(WorkspacePage, skipOffstage: false)),
        same(pageState),
      );
      expect(
        tester.widget<TextField>(hiddenEditor).controller!.text,
        'unsaved instructions stay here',
      );
      expect(
        gateway.calls.where((call) => call.$1 == 'draft').length,
        flushesBefore,
        reason:
            'Opening navigation over a page must not flush the hidden chat draft.',
      );

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.byType(SessionSidebar), findsNothing);
      expect(find.byType(WorkspacePage), findsOneWidget);
      expect(tester.state(find.byType(WorkspacePage)), same(pageState));
      expect(
        tester.widget<TextField>(editor).controller!.text,
        'unsaved instructions stay here',
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'Android Back closes phone navigation and restores the retained Schedules page',
    (tester) async {
      _setPhone(tester);
      final (gateway, _) = await _showPhone(tester);
      addTearDown(() async => gateway.stream.close());

      await tester.tap(
        find.descendant(
          of: find.byType(MobileTabs),
          matching: find.text('Schedules'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(SchedulesPage), findsOneWidget);
      final pageState = tester.state(find.byType(SchedulesPage));

      await tester.tap(
        find.descendant(
          of: find.byType(MobileTabs),
          matching: find.text('Chat'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(SessionSidebar), findsOneWidget);
      expect(
        tester.state(find.byType(SchedulesPage, skipOffstage: false)),
        same(pageState),
      );

      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.byType(SessionSidebar), findsNothing);
      expect(find.byType(SchedulesPage), findsOneWidget);
      expect(tester.state(find.byType(SchedulesPage)), same(pageState));
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('Settings is the selected phone tab while its dialog is open', (
    tester,
  ) async {
    _setPhone(tester);
    final (gateway, _) = await _showPhone(tester);
    addTearDown(() async => gateway.stream.close());

    final tabs = find.byType(MobileTabs);
    expect(tester.widget<MobileTabs>(tabs).current, 'chat');
    await tester.tap(
      find.descendant(of: tabs, matching: find.text('Settings')),
    );
    await tester.pumpAndSettle();

    expect(find.byType(NativeSettingsDialog), findsOneWidget);
    expect(tester.widget<MobileTabs>(tabs).current, 'settings');

    await tester.tap(find.byTooltip('Close'));
    await tester.pumpAndSettle();
    expect(find.byType(NativeSettingsDialog), findsNothing);
    expect(tester.widget<MobileTabs>(tabs).current, 'chat');
    expect(tester.takeException(), isNull);
  });

  testWidgets('Work is the selected phone tab when no top-level Chats exists', (
    tester,
  ) async {
    _setPhone(tester);
    final gateway = NoTopLevelChatsGateway();
    final controller = LiveController(gateway);
    await tester.pumpWidget(MobileApp(theme: theme, controller: controller));
    await tester.pumpAndSettle();
    addTearDown(() async => gateway.stream.close());

    final tabs = find.byType(MobileTabs);
    expect(tabs, findsOneWidget);
    expect(
      find.descendant(of: tabs, matching: find.text('Chat')),
      findsNothing,
    );
    expect(tester.widget<MobileTabs>(tabs).current, 'work');
    expect(tester.takeException(), isNull);
  });
}
