import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/conversation_jump_latest.dart';
import 'package:pirc_mobile/live/gateway.dart';

import 'live_test.dart' show FakeGateway, theme;

void main() {
  testWidgets('manual bottom scroll clears unseen content and resize follows', (
    t,
  ) async {
    t.view.devicePixelRatio = 1;
    t.view.physicalSize = const Size(390, 900);
    addTearDown(t.view.reset);
    final gateway = FakeGateway();
    final controller = LiveController(gateway);
    await t.pumpWidget(MobileApp(theme: theme, controller: controller));
    await t.pumpAndSettle();
    await controller.open('s');
    gateway.publish('s');
    await t.pumpAndSettle();
    final scroll = t
        .widget<CustomScrollView>(find.byType(CustomScrollView))
        .controller!;
    scroll.jumpTo(scroll.position.maxScrollExtent - 80);
    await t.pumpAndSettle();
    final readingOffset = scroll.offset;
    gateway.publish(
      's',
      text: List.filled(45, 'New paragraph while reading.\n\n').join(),
    );
    await t.pumpAndSettle();
    expect(scroll.offset, readingOffset);
    expect(find.byType(ConversationJumpLatest), findsOneWidget);
    scroll.jumpTo(scroll.position.maxScrollExtent);
    await t.pumpAndSettle();
    expect(find.byType(ConversationJumpLatest), findsNothing);
    t.view.physicalSize = const Size(390, 650);
    await t.pumpAndSettle();
    expect(
      scroll.position.extentAfter,
      0,
      reason: 'Viewport resizing retains following without a new snapshot',
    );
    scroll.jumpTo(200);
    await t.pumpAndSettle();
    t.view.physicalSize = const Size(390, 750);
    await t.pumpAndSettle();
    expect(
      scroll.offset,
      200,
      reason: 'Resizing a detached reader does not force the latest entry',
    );
    expect(t.takeException(), isNull);
    await t.pumpWidget(const SizedBox());
    await gateway.stream.close();
  });
  for (final width in [390.0, 1024.0]) {
    testWidgets('new content jump survives composer fade at $width and 2x', (
      tester,
    ) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = Size(width, 900);
      tester.platformDispatcher.textScaleFactorTestValue = 2;
      addTearDown(tester.view.reset);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      final gateway = FakeGateway();
      final controller = LiveController(gateway);
      await tester.pumpWidget(MobileApp(theme: theme, controller: controller));
      await tester.pumpAndSettle();
      await controller.open('s');
      gateway.publish('s');
      await tester.pumpAndSettle();
      final scroll = tester
          .widget<CustomScrollView>(find.byType(CustomScrollView).first)
          .controller!;
      expect(scroll.position.maxScrollExtent, greaterThan(100));
      scroll.jumpTo(0);
      await tester.pumpAndSettle();
      gateway.publish(
        's',
        text: List.filled(45, 'Keep the existing reading position.\n\n').join(),
      );
      await tester.pumpAndSettle();
      expect(scroll.offset, 0);
      final jump = find.byType(ConversationJumpLatest);
      expect(jump, findsOneWidget);
      final rect = tester.getRect(jump);
      expect(rect.height, 36);
      final viewport = tester.getRect(find.byType(CustomScrollView).first);
      expect(rect.bottom, closeTo(viewport.bottom - 12, .01));
      final fade = tester.getRect(
        find.byKey(const Key('conversation-composer-fade')),
      );
      expect(fade.height, 24);
      expect(fade.overlaps(rect), isTrue);
      // This point is covered by the fade but must still reach the jump button.
      await tester.tapAt(Offset(rect.center.dx, rect.bottom - 2));
      await tester.pumpAndSettle();
      expect(jump, findsNothing);
      expect(scroll.position.extentAfter, closeTo(0, .01));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await gateway.stream.close();
    });
  }
}
