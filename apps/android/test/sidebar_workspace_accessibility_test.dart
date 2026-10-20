import 'dart:ui' show PointerDeviceKind, SemanticsRole, Tristate;
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsNode;
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/session_row.dart';
import 'package:pirc_mobile/live/session_sidebar.dart';
import 'package:pirc_mobile/live/workspace_page.dart';
import 'live_test.dart' show FakeGateway, theme;

const _project = <String, dynamic>{
  'id': 'host:project',
  'hostId': 'host',
  'displayName': 'Project',
};

LiveController _controller(FakeGateway gateway) => LiveController(gateway)
  ..booting = false
  ..origin = 'https://gateway.example'
  ..workspaces = [_project]
  ..nodes = [
    {'id': 'host'},
  ];

/// Unread, so the sidebar lists it under its workspace.
Json _session(String id, {String? status}) => {
  'id': id,
  'name': id,
  'workspaceId': _project['id'],
  'runStatus': status ?? 'idle',
  'unread': true,
};

Widget _app(
  Widget child, {
  Brightness brightness = Brightness.light,
  TargetPlatform platform = TargetPlatform.android,
}) => MaterialApp(
  theme: theme.build(brightness).copyWith(platform: platform),
  home: Scaffold(body: child),
);

void main() {
  testWidgets('touch row reveals actions and sidebar keeps one revealed row', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 780);
    addTearDown(tester.view.reset);
    final gateway = FakeGateway(), controller = _controller(gateway);
    controller.sessions = [
      _session('Alpha'),
      _session('Beta'),
      _session('Gamma'),
    ];
    await tester.pumpWidget(
      _app(
        SessionSidebar(
          controller: controller,
          activeId: 'Alpha',
          workspaceId: '${_project['id']}',
          onOpen: (_) {},
          onWorkspace: (_) {},
          onPage: (_) {},
          onCollapse: () {},
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byTooltip('Actions for Beta'), findsOneWidget);
    expect(find.byTooltip('Pin Beta'), findsNothing);
    expect(find.byTooltip('Actions for Alpha'), findsNothing);
    expect(find.byTooltip('Pin Alpha'), findsOneWidget);

    await tester.tap(find.byTooltip('Actions for Beta'));
    await tester.pumpAndSettle();
    expect(find.byTooltip('Pin Beta'), findsOneWidget);
    expect(find.byTooltip('Actions for Beta'), findsNothing);

    await tester.tap(find.byTooltip('Actions for Gamma'));
    await tester.pumpAndSettle();
    expect(find.byTooltip('Pin Beta'), findsNothing);
    expect(find.byTooltip('Pin Gamma'), findsOneWidget);
    expect(find.byTooltip('Actions for Beta'), findsOneWidget);
    controller.dispose();
    await gateway.stream.close();
  });

  testWidgets(
    'desktop actions appear on hover and keyboard focus, without ellipsis',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(900, 600);
      addTearDown(tester.view.reset);
      final gateway = FakeGateway(), controller = _controller(gateway);
      final session = _session('Desktop row');
      await tester.pumpWidget(
        _app(
          Align(
            alignment: Alignment.topLeft,
            child: SizedBox(
              width: 420,
              child: SessionRow(
                controller: controller,
                session: session,
                onOpen: () {},
              ),
            ),
          ),
          platform: TargetPlatform.macOS,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byTooltip('Actions for Desktop row'), findsNothing);
      expect(find.byTooltip('Pin Desktop row'), findsNothing);

      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      await mouse.moveTo(tester.getCenter(find.text('Desktop row')));
      await tester.pumpAndSettle();
      expect(find.byTooltip('Pin Desktop row'), findsOneWidget);
      expect(find.byTooltip('Actions for Desktop row'), findsNothing);

      await mouse.moveTo(const Offset(580, 500));
      await tester.pumpAndSettle();
      expect(find.byTooltip('Pin Desktop row'), findsNothing);
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pumpAndSettle();
      expect(find.byTooltip('Pin Desktop row'), findsOneWidget);
      expect(find.byTooltip('Actions for Desktop row'), findsNothing);
      await mouse.removePointer();
      controller.dispose();
      await gateway.stream.close();
    },
  );

  testWidgets(
    'workspace tabs expose tab semantics and rove by arrows/Home/End',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(768, 820);
      addTearDown(tester.view.reset);
      final semantics = tester.ensureSemantics();
      final gateway = FakeGateway(), controller = _controller(gateway);
      try {
        await tester.pumpWidget(
          _app(
            WorkspacePage(
              controller: controller,
              workspaceId: '${_project['id']}',
              onBack: () {},
              onOpen: (_) {},
            ),
          ),
        );
        await tester.pumpAndSettle();
        final tabBarFinder = find.bySemanticsLabel('Project sections');
        final tabBarNode = tester.getSemantics(tabBarFinder);
        expect(tabBarNode.getSemanticsData().role, SemanticsRole.tabBar);
        final tabRoles = <SemanticsNode>[];
        tabBarNode.visitChildren((child) {
          if (child.getSemanticsData().role == SemanticsRole.tab) {
            tabRoles.add(child);
          }
          return true;
        });
        expect(tabRoles, hasLength(2));
        expect(
          tabRoles.where(
            (node) =>
                node.getSemanticsData().flagsCollection.isSelected ==
                Tristate.isTrue,
          ),
          hasLength(1),
        );

        await tester.tap(find.text('Sessions').first);
        await tester.pumpAndSettle();
        expect(
          FocusManager.instance.primaryFocus?.debugLabel,
          'workspace-sessions-tab',
        );
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
        await tester.pumpAndSettle();
        expect(
          FocusManager.instance.primaryFocus?.debugLabel,
          'workspace-settings-tab',
        );
        expect(
          tester.getSemantics(tabBarFinder).getSemanticsData().role,
          SemanticsRole.tabBar,
        );
        expect(find.text('WORKSPACE'), findsOneWidget);
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
        await tester.pumpAndSettle();
        expect(
          FocusManager.instance.primaryFocus?.debugLabel,
          'workspace-sessions-tab',
        );
        await tester.sendKeyEvent(LogicalKeyboardKey.end);
        await tester.pumpAndSettle();
        expect(
          FocusManager.instance.primaryFocus?.debugLabel,
          'workspace-settings-tab',
        );
        await tester.sendKeyEvent(LogicalKeyboardKey.home);
        await tester.pumpAndSettle();
        expect(
          FocusManager.instance.primaryFocus?.debugLabel,
          'workspace-sessions-tab',
        );
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
        await tester.pumpAndSettle();
        expect(
          FocusManager.instance.primaryFocus?.debugLabel,
          'workspace-settings-tab',
        );
        await tester.sendKeyEvent(LogicalKeyboardKey.home);
        await tester.pumpAndSettle();

        // Only the selected tab remains in sequential focus order.
        await tester.sendKeyEvent(LogicalKeyboardKey.tab);
        await tester.pumpAndSettle();
        expect(
          FocusManager.instance.primaryFocus?.debugLabel,
          isNot('workspace-settings-tab'),
        );
      } finally {
        semantics.dispose();
        controller.dispose();
        await gateway.stream.close();
      }
    },
  );

  testWidgets(
    'sidebar and workspace layouts stay within bounds at 2x text scale',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.platformDispatcher.textScaleFactorTestValue = 2;
      addTearDown(tester.view.reset);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      const widths = [390.0, 650.0, 651.0, 768.0, 860.0, 861.0, 1024.0];
      for (final brightness in [Brightness.light, Brightness.dark]) {
        for (final width in widths) {
          tester.view.physicalSize = Size(width, 900);
          final gateway = FakeGateway(), controller = _controller(gateway);
          controller.sessions = [
            _session(
              'A long running conversation with a long title',
              status: 'running',
            ),
            _session('Waiting for input', status: 'waiting_input'),
            _session('Settled work'),
          ];
          await tester.pumpWidget(
            _app(
              SessionSidebar(
                controller: controller,
                activeId: 'Waiting for input',
                workspaceId: '${_project['id']}',
                onOpen: (_) {},
                onWorkspace: (_) {},
                onPage: (_) {},
                onCollapse: () {},
              ),
              brightness: brightness,
            ),
          );
          await tester.pumpAndSettle();
          expect(
            tester.takeException(),
            isNull,
            reason: 'sidebar $width $brightness',
          );
          await tester.pumpWidget(
            _app(
              WorkspacePage(
                controller: controller,
                workspaceId: '${_project['id']}',
                onBack: () {},
                onOpen: (_) {},
              ),
              brightness: brightness,
            ),
          );
          await tester.pumpAndSettle();
          expect(
            tester.takeException(),
            isNull,
            reason: 'workspace $width $brightness',
          );
          controller.dispose();
          await gateway.stream.close();
        }
      }
    },
  );
}
