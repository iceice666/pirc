import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:pirc_mobile/live/conversation_empty.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';

import 'live_test.dart' show FakeGateway, theme;

void main() {
  testWidgets(
    'empty conversation scrolls above keyboard and disappears on a message',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(390, 700);
      tester.view.viewInsets = const FakeViewPadding(bottom: 250);
      addTearDown(tester.view.reset);
      final gateway = FakeGateway();
      gateway.snapshot = {...gateway.snapshot, 'messages': <Json>[]};
      final controller = LiveController(gateway, showing: 'engine');
      await tester.pumpWidget(MobileApp(theme: theme, controller: controller));
      await tester.pumpAndSettle();
      await controller.open('s');
      gateway.publish('s');
      await tester.pumpAndSettle();
      final empty = find.byType(ConversationEmptyState);
      expect(empty, findsOneWidget);
      expect(tester.getSize(empty).height, greaterThanOrEqualTo(300));
      expect(find.byKey(const Key('live-draft')), findsOneWidget);
      await tester.drag(empty, const Offset(0, -150));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      gateway.publish('s', text: 'The first reply');
      await tester.pumpAndSettle();
      expect(empty, findsNothing);
      expect(find.textContaining('The first reply'), findsWidgets);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await gateway.stream.close();
    },
  );
  for (final fixture in [
    (
      name: 'phone',
      screen: const Size(390, 900),
      loading: const Size(390, 900),
      empty: const Size(362, 671),
    ),
    (
      name: 'tablet',
      screen: const Size(768, 900),
      loading: const Size(536, 900),
      empty: const Size(488, 625),
    ),
  ]) {
    for (final scale in [1.0, 2.0]) {
      testWidgets(
        'empty and app status widgets fit ${fixture.name} at ${scale}x text',
        (tester) async {
          tester.view.devicePixelRatio = 1;
          tester.view.physicalSize = fixture.screen;
          addTearDown(tester.view.reset);

          await _pumpState(
            tester,
            const ConversationEmptyState(),
            fixture.empty,
            scale,
          );
          expect(find.text('Start something useful'), findsOneWidget);
          expect(
            find.text(
              'Describe a task, attach a reference image, or ask the agent to continue work in this workspace.',
            ),
            findsOneWidget,
          );
          _expectIcon(tester, LucideIcons.plus);
          final title = tester.widget<Text>(
            find.text('Start something useful'),
          );
          expect(title.style?.fontSize, 22);
          expect(title.style?.fontWeight, FontWeight.w600);
          expect(title.style?.height, kTextHeightNone);
          final description = tester.widget<Text>(
            find.text(
              'Describe a task, attach a reference image, or ask the agent to continue work in this workspace.',
            ),
          );
          expect(description.style?.fontSize, 14);
          expect(description.style?.height, 1.6);

          await _pumpState(
            tester,
            const AppLoadingState(),
            fixture.loading,
            scale,
          );
          expect(find.text('Connecting to your sessions…'), findsOneWidget);
          _expectIcon(tester, LucideIcons.sparkles);

          await _pumpState(
            tester,
            const AppNoSessionState(),
            fixture.loading,
            scale,
          );
          expect(find.text('No session could be loaded.'), findsOneWidget);
          _expectIcon(tester, LucideIcons.circleAlert);
          expect(tester.takeException(), isNull);
        },
      );
    }
  }
}

Future<void> _pumpState(
  WidgetTester tester,
  Widget child,
  Size size,
  double textScale,
) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: theme.build(Brightness.light),
      home: Scaffold(
        body: Builder(
          builder: (context) => Align(
            alignment: Alignment.topLeft,
            child: MediaQuery(
              data: MediaQuery.of(
                context,
              ).copyWith(textScaler: TextScaler.linear(textScale)),
              child: SizedBox.fromSize(size: size, child: child),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
  expect(tester.takeException(), isNull);
}

void _expectIcon(WidgetTester tester, IconData iconData) {
  expect(
    find.byWidgetPredicate(
      (widget) =>
          widget is Icon && widget.icon == iconData && widget.size == 24,
    ),
    findsOneWidget,
  );
}
