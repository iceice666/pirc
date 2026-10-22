import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/workspace_page.dart';
import 'live_test.dart' show FakeGateway, theme;

const _project = <String, dynamic>{
  'id': 'host:project',
  'hostId': 'host',
  'kind': 'directory',
  'displayName': 'Trip',
};

LiveController _controller(FakeGateway gateway) =>
    LiveController(gateway, showing: 'engine')
      ..booting = false
      ..origin = 'https://gateway.example'
      ..workspaces = [_project]
      ..nodes = [
        {'id': 'host'},
      ]
      ..sessions = [
        {
          'id': 's1',
          'name': 'A long session title that should stay inside its row',
          'workspaceId': _project['id'],
          'runStatus': 'idle',
          'unread': true,
        },
      ];

double _pageWidthFor(double viewportWidth) => switch (viewportWidth) {
  <= 650 => viewportWidth,
  <= 860 => viewportWidth - 232,
  _ => viewportWidth - 264,
};

Widget _host(Widget child, Brightness brightness) => MaterialApp(
  theme: theme.build(brightness),
  home: Scaffold(body: child),
);

void main() {
  for (final width in [390.0, 650.0, 651.0, 768.0, 860.0, 861.0, 1024.0]) {
    for (final brightness in [Brightness.light, Brightness.dark]) {
      for (final scale in [1.0, 2.0]) {
        testWidgets(
          'workspace layout fits ${width.toInt()}px, $brightness, text scale $scale',
          (tester) async {
            tester.view.devicePixelRatio = 1;
            tester.view.physicalSize = Size(width, 900);
            tester.platformDispatcher.textScaleFactorTestValue = scale;
            addTearDown(tester.view.reset);
            addTearDown(
              tester.platformDispatcher.clearTextScaleFactorTestValue,
            );

            final gateway = FakeGateway();
            final controller = _controller(gateway);
            final pageWidth = _pageWidthFor(width);
            await tester.pumpWidget(
              _host(
                Align(
                  alignment: Alignment.topCenter,
                  child: SizedBox(
                    width: pageWidth,
                    height: 900,
                    child: WorkspacePage(
                      controller: controller,
                      workspaceId: '${_project['id']}',
                      onBack: () {},
                      onOpen: (_) {},
                    ),
                  ),
                ),
                brightness,
              ),
            );
            await tester.pumpAndSettle();

            expect(tester.takeException(), isNull);
            final header = tester.getRect(
              find.byKey(const Key('workspace-page-header')),
            );
            final tabs = tester.getRect(
              find.byKey(const Key('workspace-page-tabs')),
            );
            final body = tester.getRect(
              find.byKey(const Key('workspace-page-body')),
            );
            final tools = tester.getRect(
              find.byKey(const Key('workspace-page-list-tools')),
            );
            final phone = width <= 650;
            final horizontalInset = phone ? 10.0 : 32.0;

            expect(header.width, closeTo(pageWidth, 0.1));
            expect(header.height, greaterThanOrEqualTo(56));
            expect(tabs.top, closeTo(header.bottom, 0.1));
            expect(tabs.height, closeTo(37, 0.1));
            expect(body.width, closeTo(pageWidth, 0.1));
            expect(body.top, closeTo(tabs.bottom, 0.1));
            expect(body.left, closeTo((width - pageWidth) / 2, 0.1));
            expect(tools.left, closeTo(body.left + horizontalInset, 0.1));
            expect(tools.width, closeTo(body.width - horizontalInset * 2, 0.1));
            expect(tester.takeException(), isNull);

            await tester.pumpWidget(const SizedBox.shrink());
            controller.dispose();
            await gateway.stream.close();
          },
        );
      }
    }
  }

  testWidgets('header follows the workspace identity and phone subtitle rule', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(768, 900);
    addTearDown(tester.view.reset);
    final gateway = FakeGateway();
    final controller = _controller(gateway);

    Widget page(String id) => _host(
      SizedBox(
        width: 536,
        height: 900,
        child: WorkspacePage(
          controller: controller,
          workspaceId: id,
          onBack: () {},
          onOpen: (_) {},
        ),
      ),
      Brightness.light,
    );

    await tester.pumpWidget(page('${_project['id']}'));
    await tester.pumpAndSettle();
    expect(find.text('Trip'), findsOneWidget);
    expect(find.text('Workspace · host'), findsOneWidget);
    expect(
      find.byWidgetPredicate(
        (widget) => widget is Icon && widget.icon == LucideIcons.folder,
      ),
      findsOneWidget,
    );

    tester.view.physicalSize = const Size(390, 900);
    await tester.pumpWidget(
      _host(
        SizedBox(
          width: 390,
          height: 900,
          child: WorkspacePage(
            controller: controller,
            workspaceId: '${_project['id']}',
            onBack: () {},
            onOpen: (_) {},
          ),
        ),
        Brightness.light,
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Workspace · host'), findsNothing);
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox.shrink());
    controller.dispose();
    await gateway.stream.close();
  });

  testWidgets('phone workspace tabs use content widths and a 4px gap', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 900);
    addTearDown(tester.view.reset);
    final gateway = FakeGateway();
    final controller = _controller(gateway);
    await tester.pumpWidget(
      _host(
        Align(
          alignment: Alignment.topCenter,
          child: SizedBox(
            width: 390,
            height: 900,
            child: WorkspacePage(
              controller: controller,
              workspaceId: '${_project['id']}',
              onBack: () {},
              onOpen: (_) {},
            ),
          ),
        ),
        Brightness.light,
      ),
    );
    await tester.pumpAndSettle();

    final chats = tester.getRect(
      find.byKey(const Key('workspace-tab-sessions')),
    );
    final settings = tester.getRect(
      find.byKey(const Key('workspace-tab-settings')),
    );
    expect(chats.left, closeTo(12, 0.1));
    // Keep each tab content-sized; do not stretch either item to half the row.
    expect(chats.width, inInclusiveRange(60, 160));
    expect(settings.left, closeTo(chats.right + 4, 0.1));
    expect(settings.width, inInclusiveRange(60, 160));
    expect(
      tester.getRect(find.byKey(const Key('workspace-page-tabs'))).height,
      closeTo(37, 0.1),
    );
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox.shrink());
    controller.dispose();
    await gateway.stream.close();
  });
}
