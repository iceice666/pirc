import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/session_sidebar.dart';
import 'package:pirc_mobile/live/web_controls.dart';
import 'package:pirc_mobile/theme.dart';
import 'live_test.dart' show FakeGateway, theme;
import '../tool/parity/capture_fonts.dart' show loadParityFonts;

Widget sidebarApp(
  LiveController controller,
  double width, {
  double scale = 2,
}) => MaterialApp(
  theme: theme.build(Brightness.light),
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(scale)),
    child: child!,
  ),
  home: Scaffold(
    body: SizedBox(
      width: width <= 650 ? width : 264,
      height: 900,
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

LiveController sidebarController(FakeGateway gateway) => LiveController(gateway)
  ..mode = 'chat'
  ..nodes = <Json>[
    {'id': 'device'},
  ]
  ..workspaces = <Json>[
    {
      'id': 'device:chats',
      'hostId': 'device',
      'displayName': 'Chats',
      'kind': 'chat',
    },
    {
      'id': 'device:project',
      'hostId': 'device',
      'displayName': 'Home server notes',
      'kind': 'chat',
    },
  ];

void main() {
  for (final (width, expectedAction) in [(1024.0, 24.0), (390.0, 32.0)]) {
    testWidgets('workspace track retains its intrinsic title at $width width', (
      t,
    ) async {
      await t.runAsync(loadParityFonts);
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = Size(width, 900);
      addTearDown(t.view.reset);
      final gateway = FakeGateway();
      final controller = sidebarController(gateway);
      await t.pumpWidget(sidebarApp(controller, width));
      await t.pumpAndSettle();

      final add = find.byTooltip('New chat in Home server notes');
      expect(t.getSize(add), Size(expectedAction, expectedAction));
      expect(
        t.getSize(find.text('Home server notes')).width,
        closeTo(236.547, .2),
        reason: 'Pinned Arial 28px title, including intrinsic grid overflow',
      );
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    });
  }

  testWidgets('overflow project action is reachable after horizontal scroll', (
    t,
  ) async {
    await t.runAsync(loadParityFonts);
    t.view.devicePixelRatio = 1;
    t.view.physicalSize = const Size(1024, 900);
    addTearDown(t.view.reset);
    final gateway = FakeGateway();
    gateway.handler = (method, args) async {
      if (method == 'request' &&
          args['path'] == '/api/sessions' &&
          args['method'] == 'POST') {
        return {
          'session': {'id': 's'},
        };
      }
      return gateway.normal(method, args);
    };
    final controller = sidebarController(gateway)
      ..sessions = [
        {
          'id': 'chat-1',
          'name': 'Known chat',
          'workspaceId': 'device:chats',
          'runStatus': 'completed',
        },
      ];
    await t.pumpWidget(sidebarApp(controller, 1024));
    await t.pumpAndSettle();
    final horizontal = find.byWidgetPredicate(
      (widget) =>
          widget is SingleChildScrollView &&
          widget.scrollDirection == Axis.horizontal,
    );
    expect(horizontal, findsOneWidget);
    final viewport = t.getRect(horizontal);
    final add = find.byTooltip('New chat in Home server notes');
    expect(t.getRect(add).left, greaterThan(viewport.right));
    final chat = find.byKey(const ValueKey('sidebar-chat-1'));
    expect(
      t.getSize(chat).width,
      247,
      reason: 'Other sections keep the original fixed sidebar width',
    );
    final chatsHeading = find.ancestor(
      of: find.text('CHATS'),
      matching: find.byWidgetPredicate(
        (widget) => widget is Container && widget.constraints?.maxHeight == 26,
      ),
    );
    expect(chatsHeading, findsOneWidget);
    expect(t.getSize(chatsHeading).width, 247);
    await t.drag(horizontal, const Offset(-180, 0));
    await t.pumpAndSettle();
    expect(t.getRect(add).right, lessThanOrEqualTo(viewport.right));
    expect(t.getSize(chat).width, 247);
    await t.tap(add);
    await t.pumpAndSettle();
    final creates = gateway.calls.where(
      (call) =>
          call.$1 == 'request' &&
          call.$2['path'] == '/api/sessions' &&
          call.$2['method'] == 'POST',
    );
    expect(creates, hasLength(1));
    expect(creates.single.$2['body'], {'workspaceId': 'device:project'});
    expect(controller.sessionId, 's');
    expect(t.takeException(), isNull);
    await t.pumpWidget(const SizedBox());
    controller.dispose();
    await gateway.stream.close();
  });

  testWidgets('short project unread metadata aligns to the shared track end', (
    t,
  ) async {
    await t.runAsync(loadParityFonts);
    t.view.devicePixelRatio = 1;
    t.view.physicalSize = const Size(1024, 900);
    addTearDown(t.view.reset);
    final gateway = FakeGateway();
    final controller = sidebarController(gateway);
    controller.workspaces.add({
      'id': 'device:short',
      'hostId': 'device',
      'displayName': 'Short',
      'kind': 'chat',
    });
    controller.sessions = [
      {
        'id': 'short-unread',
        'workspaceId': 'device:short',
        'name': 'Unread chat',
        'unread': true,
        'runStatus': 'completed',
      },
    ];
    await t.pumpWidget(sidebarApp(controller, 1024));
    await t.pumpAndSettle();
    final shortAdd = find.byTooltip('New chat in Short');
    final longAdd = find.byTooltip('New chat in Home server notes');
    final pill = find.byWidgetPredicate(
      (widget) =>
          widget is Container &&
          widget.constraints?.minWidth == 18 &&
          widget.constraints?.maxHeight == 18,
    );
    expect(pill, findsOneWidget);
    expect(t.getRect(shortAdd).left, t.getRect(longAdd).left);
    expect(
      t.getRect(pill).right,
      closeTo(t.getRect(shortAdd).left - 4, .01),
      reason:
          'Pinned workspace-meta has margin-left:auto and padding-right:4px',
    );
    expect(t.takeException(), isNull);
    await t.pumpWidget(const SizedBox());
    controller.dispose();
    await gateway.stream.close();
  });

  testWidgets('fixed sidebar search follows web flex shrink geometry', (
    t,
  ) async {
    t.view.devicePixelRatio = 1;
    t.view.physicalSize = const Size(1024, 900);
    addTearDown(t.view.reset);
    final text = TextEditingController();
    final changes = <String>[];
    await t.pumpWidget(
      MaterialApp(
        theme: theme.build(Brightness.light),
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(
              width: 239,
              child: WebSearch(
                fixedHeight: 36,
                fontSize: 16,
                controller: text,
                label: 'Search chats',
                onChanged: changes.add,
              ),
            ),
          ),
        ),
      ),
    );
    await t.pumpAndSettle();

    final search = find.byType(WebSearch);
    final surface = find.descendant(
      of: search,
      matching: find.byWidgetPredicate(
        (widget) =>
            widget is Container &&
            widget.padding == const EdgeInsets.symmetric(horizontal: 10),
      ),
    );
    final icon = find.descendant(of: search, matching: find.byType(Icon));
    final input = find.descendant(of: search, matching: find.byType(TextField));
    expect(t.getSize(search), const Size(239, 36));
    expect(surface, findsOneWidget);
    expect(t.getSize(icon).width, closeTo(14.366, .001));
    expect(t.getSize(icon).height, closeTo(14.366, .001));
    expect(t.getRect(input).left, closeTo(32.366, .04));
    expect(t.getSize(input).width, closeTo(196.634, .04));

    final idle = t.widget<Container>(surface).decoration! as BoxDecoration;
    final colors = Theme.of(t.element(search)).extension<PircColors>()!;
    expect(idle.color, colors['fill.hover']);
    expect(idle.boxShadow, isNull);
    await t.tap(input);
    await t.pump();
    final focused = t.widget<Container>(surface).decoration! as BoxDecoration;
    expect(focused.color, colors['surface.layer']);
    expect(focused.boxShadow, hasLength(1));
    expect(focused.boxShadow!.single.color, colors['web.line-dark']);
    expect(focused.boxShadow!.single.spreadRadius, 1);
    expect(t.getSize(search), const Size(239, 36));

    await t.enterText(input, 'alpha');
    await t.pump();
    expect(text.text, 'alpha');
    expect(changes, contains('alpha'));

    FocusManager.instance.primaryFocus?.unfocus();
    await t.pump();
    final blurred = t.widget<Container>(surface).decoration! as BoxDecoration;
    expect(blurred.color, idle.color);
    expect(blurred.boxShadow, isNull);
    expect(t.getRect(input).left, closeTo(32.366, .04));
    expect(t.getSize(input).width, closeTo(196.634, .04));
    expect(t.takeException(), isNull);
    await t.pumpWidget(const SizedBox());
    text.dispose();
  });
}
