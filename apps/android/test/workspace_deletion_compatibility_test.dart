import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/session_sidebar.dart';
import 'package:pirc_mobile/live/workspace_dialogs.dart';
import 'package:pirc_mobile/live/workspace_page.dart';

import 'live_test.dart' show FakeGateway, theme;

const Json _chats = {
  'id': 'home:chats',
  'hostId': 'home',
  'displayName': 'Chats',
  'kind': 'chat',
};
Json _project({bool deleting = false}) => {
  'id': 'home:trip',
  'hostId': 'home',
  'displayName': 'Trip planning',
  'kind': 'chat',
  if (deleting) 'deleting': true,
};

LiveController _controller(FakeGateway gateway, {bool deleting = true}) =>
    LiveController(gateway)
      ..mode = 'chat'
      ..nodes = [
        {'id': 'home'},
      ]
      ..workspaces = [_chats, _project(deleting: deleting)];

Widget _sidebar(LiveController controller) => MaterialApp(
  theme: theme.build(Brightness.light),
  home: Scaffold(
    body: SizedBox(
      width: 390,
      height: 700,
      child: SessionSidebar(
        controller: controller,
        onOpen: (_) {},
        onWorkspace: (_) {},
        onPage: (_) {},
        onCollapse: () {},
        onMode: (_) {},
      ),
    ),
  ),
);

void main() {
  test(
    'controller refuses creation in a deleting workspace before HTTP',
    () async {
      final gateway = FakeGateway();
      final controller = _controller(gateway);
      addTearDown(() async {
        controller.dispose();
        await gateway.stream.close();
      });

      await expectLater(
        controller.create('home:trip'),
        throwsA(
          isA<StateError>().having(
            (error) => error.message,
            'message',
            workspaceDeletionNotice,
          ),
        ),
      );
      expect(
        gateway.calls.where(
          (call) =>
              call.$1 == 'request' &&
              call.$2['path'] == '/api/sessions' &&
              call.$2['method'] == 'POST',
        ),
        isEmpty,
      );
    },
  );

  testWidgets('sidebar shows deleting state and disables project chat action', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final controller = _controller(gateway);
    addTearDown(() async {
      controller.dispose();
      await gateway.stream.close();
    });

    await tester.pumpWidget(_sidebar(controller));
    await tester.pumpAndSettle();

    expect(find.text(workspaceDeletionNotice), findsOneWidget);
    final add = tester.widget<IconButton>(
      find.byWidgetPredicate(
        (widget) =>
            widget is IconButton &&
            widget.tooltip == 'New chat in Trip planning',
      ),
    );
    expect(add.onPressed, isNull);
    await tester.tap(find.byTooltip('New chat in Trip planning'));
    await tester.pump();
    expect(
      gateway.calls.where(
        (call) => call.$1 == 'request' && call.$2['method'] == 'POST',
      ),
      isEmpty,
    );
  });

  testWidgets('workspace page shows status and disables its new-chat action', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final controller = _controller(gateway);
    addTearDown(() async {
      controller.dispose();
      await gateway.stream.close();
    });

    tester.view.physicalSize = const Size(800, 700);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: theme.build(Brightness.light),
        home: Scaffold(
          body: WorkspacePage(
            controller: controller,
            workspaceId: 'home:trip',
            onBack: () {},
            onOpen: (_) {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text(workspaceDeletionNotice), findsOneWidget);
    final create = tester.widget<TextButton>(
      find.widgetWithText(TextButton, 'New chat'),
    );
    expect(create.onPressed, isNull);
  });

  testWidgets(
    'new-session dialog handles all-deleting and newly-deleting selection',
    (tester) async {
      final gateway = FakeGateway();
      final controller = _controller(gateway, deleting: true)
        ..mode = 'work'
        ..workspaces = [_project(deleting: true)];
      addTearDown(() async {
        controller.dispose();
        await gateway.stream.close();
      });

      await tester.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.light),
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => newSessionDialog(context, controller),
                child: const Text('Open dialog'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open dialog'));
      await tester.pumpAndSettle();
      expect(find.text(workspaceDeletionNotice), findsOneWidget);
      expect(find.text('No workspace available'), findsOneWidget);
      expect(
        tester
            .widget<TextButton>(
              find.widgetWithText(TextButton, 'Create session'),
            )
            .onPressed,
        isNull,
      );
      expect(tester.takeException(), isNull);

      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      controller.workspaces = [_project()];
      controller.mode = 'work';
      controller.changed();
      await tester.tap(find.text('Open dialog'));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<TextButton>(
              find.widgetWithText(TextButton, 'Create session'),
            )
            .onPressed,
        isNotNull,
      );

      controller.workspaces = [_project(deleting: true)];
      controller.changed();
      await tester.pumpAndSettle();
      expect(find.text('Trip planning · deleting'), findsOneWidget);
      expect(find.text(workspaceDeletionNotice), findsOneWidget);
      expect(
        tester
            .widget<TextButton>(
              find.widgetWithText(TextButton, 'Create session'),
            )
            .onPressed,
        isNull,
      );
      expect(tester.takeException(), isNull);
    },
  );
}
