import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/conversation_earlier_messages.dart';
import 'package:pirc_mobile/live/conversation_timeline.dart';
import 'package:pirc_mobile/live/gateway.dart';

import 'live_test.dart' show FakeGateway, theme;

List<Json> history(int count) => List.generate(
  count,
  (index) => {
    'id': 'history-$index',
    'role': index.isEven ? 'user' : 'assistant',
    'content':
        'Entry $index\n\nA retained paragraph for reading the conversation.',
  },
);

void main() {
  for (final width in [390.0, 1024.0]) {
    testWidgets(
      'long history reveals pages and retains reading anchor at $width',
      (t) async {
        t.view.devicePixelRatio = 1;
        t.view.physicalSize = Size(width, 900);
        addTearDown(t.view.reset);
        final gateway = FakeGateway();
        final controller = LiveController(gateway);
        await t.pumpWidget(MobileApp(theme: theme, controller: controller));
        await t.pumpAndSettle();
        await controller.open('s');
        gateway.snapshot = {...gateway.snapshot, 'messages': history(145)};
        gateway.publish('s');
        await t.pumpAndSettle();
        expect(controller.hiddenMessages, 85);
        expect(find.byType(TimelineMessage), findsNWidgets(60));
        expect(
          find.textContaining('Entry 84', findRichText: true),
          findsNothing,
        );
        final scroll = t
            .widget<CustomScrollView>(find.byType(CustomScrollView))
            .controller!;
        expect(scroll.position.extentAfter, 0);
        final earlier = find.byType(ConversationEarlierMessages);
        expect(earlier, findsOneWidget);
        final retained = find.byKey(const ValueKey('history-90'));
        final retainedState = t.state(retained);
        // At 201px beyond the button's bottom it must remain hidden. Moving one
        // pixel inside the pinned 200px observer margin reveals a page.
        final control = t.widget<ConversationEarlierMessages>(earlier);
        final buttonBottom =
            t.getRect(find.byKey(control.buttonKey!)).bottom -
            t.getRect(find.byType(CustomScrollView)).top +
            scroll.offset;
        scroll.jumpTo(buttonBottom + 201);
        await t.pumpAndSettle();
        expect(controller.hiddenMessages, 85);
        final target = buttonBottom + 199;
        scroll.jumpTo(target);
        await t.pump();
        final before = t.getRect(retained).top;
        await t.pumpAndSettle();
        expect(controller.hiddenMessages, 25);
        expect(find.byType(TimelineMessage), findsNWidgets(120));
        expect(t.getRect(retained).top, closeTo(before, .01));
        expect(t.state(retained), same(retainedState));
        // Updates retain the established window rather than re-hiding history.
        gateway.snapshot = {...gateway.snapshot, 'messages': history(146)};
        gateway.publish('s');
        await t.pumpAndSettle();
        expect(controller.hiddenMessages, 25);
        final watched = gateway.calls
            .where((call) => call.$1 == 'watch')
            .length;
        await controller.open('s');
        expect(controller.hiddenMessages, 25);
        expect(
          gateway.calls.where((call) => call.$1 == 'watch').length,
          watched,
        );
        // A subsequent explicit button activation reveals the final page and
        // keeps the existing keyed message and reading position in place.
        final beforeClick = t.getRect(retained).top;
        t.widget<ConversationEarlierMessages>(earlier).onPressed();
        await t.pumpAndSettle();
        expect(controller.hiddenMessages, 0);
        expect(earlier, findsNothing);
        expect(find.byType(TimelineMessage), findsNWidgets(146));
        expect(t.getRect(retained).top, closeTo(beforeClick, .01));
        expect(t.state(retained), same(retainedState));
        await controller.open('other');
        gateway.snapshot = {
          ...gateway.snapshot,
          'session': {
            'id': 'other',
            'name': 'Another conversation',
            'workspaceId': 'w',
          },
          'messages': history(131),
        };
        gateway.publish('other');
        await t.pumpAndSettle();
        expect(controller.hiddenMessages, 71);
        expect(find.byType(TimelineMessage), findsNWidgets(60));
        expect(
          scroll.position.extentAfter,
          0,
          reason: 'A new conversation follows its newest entry',
        );
        expect(t.takeException(), isNull);
        await t.pumpWidget(const SizedBox());
        await gateway.stream.close();
      },
    );
  }
}
