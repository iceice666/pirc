import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/mobile_tabs.dart';
import 'package:pirc_mobile/live/conversation_timeline.dart';
import 'package:pirc_mobile/live/session_sidebar.dart';
import 'live_test.dart' show FakeGateway, theme;

class NavigationGateway extends FakeGateway {
  @override
  dynamic normal(String method, Json args) {
    if (method == 'request' && args['path'] == '/api/workspaces') {
      return {
        'workspaces': [
          {
            'id': 'assistant:chats',
            'hostId': 'assistant',
            'displayName': 'Chats',
            'kind': 'chat',
          },
          {
            'id': 'w',
            'hostId': 'device',
            'displayName': 'Workspace',
            'kind': 'directory',
          },
        ],
      };
    }
    return super.normal(method, args);
  }
}

void main() {
  for (final width in [390.0, 650.0, 651.0, 768.0, 860.0, 861.0, 1024.0]) {
    testWidgets('web breakpoint $width preserves navigation and draft', (
      t,
    ) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = Size(width, 900);
      addTearDown(t.view.reset);
      final g = NavigationGateway();
      final c = LiveController(g);
      await t.pumpWidget(MobileApp(theme: theme, controller: c));
      await t.pumpAndSettle();
      expect(
        find.byType(MobileTabs),
        width <= 650 ? findsOneWidget : findsNothing,
      );
      expect(find.byType(Drawer), findsNothing);
      await c.open('s');
      g.publish('s');
      await t.pumpAndSettle();
      expect(find.byType(MobileTabs), findsNothing);
      await t.enterText(
        find.byKey(const Key('live-draft')),
        'draft survives list and settings',
      );
      if (width <= 650) {
        await t.tap(find.byTooltip('Back to the list'));
        await t.pumpAndSettle();
        expect(find.byType(MobileTabs), findsOneWidget);
        expect(c.sessionId, 's');
        await t.tap(find.text('Settings'));
        await t.pumpAndSettle();
        expect(find.byType(MobileTabs), findsOneWidget);
        await t.tap(find.byTooltip('Close'));
        await t.pumpAndSettle();
        expect(find.text('Work').hitTestable(), findsOneWidget);
        await t.tap(find.text('Work'));
        await t.pumpAndSettle();
        await t.tap(find.text('Workspace').first);
        await t.pumpAndSettle();
        await t.tap(find.text('測試對話'));
        await t.pump(const Duration(milliseconds: 350));
        g.publish('s');
        await t.pumpAndSettle();
        expect(find.text('draft survives list and settings'), findsOneWidget);
      }
      if (width > 650) {
        await t.tap(find.text('Workspace').first);
        await t.pumpAndSettle();
        await t.tap(find.byTooltip('Collapse sidebar'));
        await t.pumpAndSettle();
        expect(find.byTooltip('Expand sidebar'), findsOneWidget);
        await t.tap(find.byTooltip('Expand sidebar'));
        await t.pumpAndSettle();
        expect(find.byTooltip('Collapse sidebar'), findsOneWidget);
        await t.tap(find.text('測試對話').last);
        await t.pump(const Duration(milliseconds: 350));
        g.publish('s');
        await t.pumpAndSettle();
      }
      await t.tap(find.byTooltip('Show side panel'));
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      final barriers = find.byKey(const Key('panel-scrim'));
      expect(barriers, width <= 860 ? findsOneWidget : findsNothing);
      await t.tap(find.byTooltip('Hide side panel'));
      await t.pumpAndSettle();
      expect(find.text('draft survives list and settings'), findsOneWidget);
      expect(g.calls.where((call) => call.$1 == 'command'), isEmpty);
      await t.pumpWidget(const SizedBox());
      await g.stream.close();
    });
  }
  testWidgets(
    'phone list retains both pages and makes the covered page inert',
    (t) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = const Size(390, 844);
      addTearDown(t.view.reset);
      final g = NavigationGateway();
      final c = LiveController(g);
      await t.pumpWidget(MobileApp(theme: theme, controller: c));
      await t.pumpAndSettle();
      final sidebarState = t.state(find.byType(SessionSidebar));
      final searchField = find.descendant(
        of: find.byType(SessionSidebar),
        matching: find.byType(TextField),
      );
      await t.enterText(searchField, '測試');
      await c.open('s');
      g.publish('s');
      await t.pumpAndSettle();
      expect(
        t.state(find.byType(SessionSidebar, skipOffstage: false)),
        same(sidebarState),
      );
      final messageState = t.state(find.byType(TimelineMessage).first);
      final draft = find.byKey(const Key('live-draft'));
      await t.enterText(draft, 'a retained draft');
      final editable = t.widget<EditableText>(
        find.descendant(of: draft, matching: find.byType(EditableText)),
      );
      editable.controller.selection = const TextSelection(
        baseOffset: 2,
        extentOffset: 10,
      );
      final timeline = t.widget<CustomScrollView>(
        find.byType(CustomScrollView),
      );
      timeline.controller!.jumpTo(100);
      await t.pump();
      final scrollOffset = timeline.controller!.offset;

      await t.tap(find.byTooltip('Back to the list'));
      await t.pumpAndSettle();
      expect(find.byType(TimelineMessage), findsNothing);
      expect(
        t.state(find.byType(TimelineMessage, skipOffstage: false).first),
        same(messageState),
      );
      expect(editable.focusNode.hasFocus, isFalse);
      editable.focusNode.requestFocus();
      await t.pump();
      expect(editable.focusNode.hasFocus, isFalse);
      expect(find.text('測試'), findsOneWidget);
      expect(c.sessionVisible, isFalse);

      await c.open('s');
      await t.pumpAndSettle();
      expect(t.state(find.byType(TimelineMessage).first), same(messageState));
      expect(
        editable.controller.selection,
        const TextSelection(baseOffset: 2, extentOffset: 10),
      );
      expect(timeline.controller!.offset, scrollOffset);
      expect(c.draft, 'a retained draft');
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
      await g.stream.close();
    },
  );

  testWidgets('Escape closes the phone list without stealing a dialog Escape', (
    t,
  ) async {
    t.view.devicePixelRatio = 1;
    t.view.physicalSize = const Size(390, 844);
    addTearDown(t.view.reset);
    final g = NavigationGateway();
    final c = LiveController(g);
    await t.pumpWidget(MobileApp(theme: theme, controller: c));
    await t.pumpAndSettle();
    g.publish('s');
    await t.pumpAndSettle();
    final snapshot = c.state;
    await t.tap(find.text('Settings'));
    await t.pumpAndSettle();
    await t.sendKeyEvent(LogicalKeyboardKey.escape);
    await t.pumpAndSettle();
    expect(find.byTooltip('Close'), findsNothing);
    expect(find.byType(MobileTabs), findsOneWidget);
    final searchField = find.descendant(
      of: find.byType(SessionSidebar),
      matching: find.byType(TextField),
    );
    await t.enterText(searchField, '測試');
    await t.sendKeyEvent(LogicalKeyboardKey.escape);
    await t.pumpAndSettle();
    expect(find.byType(MobileTabs), findsNothing);
    expect(find.byType(SessionSidebar), findsNothing);
    expect(c.state, same(snapshot));
    expect(c.sessionVisible, isTrue);
    await t.tap(find.byTooltip('Back to the list'));
    await t.pumpAndSettle();
    expect(find.text('測試'), findsOneWidget);
    await t.pumpWidget(const SizedBox());
    await g.stream.close();
  });

  testWidgets(
    'sidebar state survives breakpoint and collapse while visibility follows layout',
    (t) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = const Size(650, 900);
      addTearDown(t.view.reset);
      final g = NavigationGateway();
      final c = LiveController(g);
      await t.pumpWidget(MobileApp(theme: theme, controller: c));
      await t.pumpAndSettle();
      g.publish('s');
      await t.pumpAndSettle();
      final sidebarState = t.state(find.byType(SessionSidebar));
      final searchField = find.descendant(
        of: find.byType(SessionSidebar),
        matching: find.byType(TextField),
      );
      await t.enterText(searchField, '測試');
      c.sessions = [
        for (final s in c.sessions) {...s, 'unread': true},
      ];
      c.changed();
      await t.pumpAndSettle();
      expect(c.sessionVisible, isFalse);
      expect(c.sessions.single['unread'], isTrue);
      t.view.physicalSize = const Size(651, 900);
      await t.pumpAndSettle();
      expect(t.state(find.byType(SessionSidebar)), same(sidebarState));
      expect(find.text('測試'), findsOneWidget);
      expect(c.sessionVisible, isTrue);
      expect(c.sessions.single['unread'], isFalse);
      await t.tap(find.byTooltip('Collapse sidebar'));
      await t.pumpAndSettle();
      expect(find.byType(SessionSidebar), findsNothing);
      expect(
        t.state(find.byType(SessionSidebar, skipOffstage: false)),
        same(sidebarState),
      );
      await t.tap(find.byTooltip('Show sidebar'));
      await t.pumpAndSettle();
      expect(t.state(find.byType(SessionSidebar)), same(sidebarState));
      expect(find.text('測試'), findsOneWidget);
      t.view.physicalSize = const Size(390, 900);
      await t.pumpAndSettle();
      expect(t.state(find.byType(SessionSidebar)), same(sidebarState));
      expect(find.text('測試'), findsOneWidget);
      expect(c.sessionVisible, isFalse);
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
      await g.stream.close();
    },
  );

  testWidgets('phone system back opens list, then can leave the app', (
    t,
  ) async {
    t.view.devicePixelRatio = 1;
    t.view.physicalSize = const Size(390, 844);
    addTearDown(t.view.reset);
    final g = NavigationGateway();
    final c = LiveController(g);
    await t.pumpWidget(MobileApp(theme: theme, controller: c));
    await t.pumpAndSettle();
    await c.open('s');
    g.publish('s');
    await t.pumpAndSettle();
    expect(
      ModalRoute.of(t.element(find.byType(LiveShell)))!.popDisposition,
      RoutePopDisposition.doNotPop,
    );
    await t.binding.handlePopRoute();
    await t.pumpAndSettle();
    expect(find.byType(MobileTabs), findsOneWidget);
    expect(
      ModalRoute.of(t.element(find.byType(LiveShell)))!.popDisposition,
      RoutePopDisposition.bubble,
    );
    await t.pumpWidget(const SizedBox());
    await g.stream.close();
  });
}
