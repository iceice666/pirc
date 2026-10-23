import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/interaction_card.dart';
import 'package:pirc_mobile/live/timeline_tools.dart';
import 'live_test.dart' show FakeGateway, theme;

void main() {
  testWidgets(
    'the App exposes a pending nested approval outside closed activity and withdraws it after another device answers',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(390, 844);
      addTearDown(tester.view.reset);
      final g = FakeGateway();
      final c = LiveController(g);
      g.snapshot = {
        ...g.snapshot,
        'messages': [
          {'id': 'u', 'role': 'user', 'content': 'Inspect the change'},
          {
            'id': 'a',
            'role': 'assistant',
            'content': '',
            'thinking': 'Internal details',
            'tools': [
              {
                'id': 'p',
                'name': 'ptc',
                'status': 'running',
                'operations': [
                  {
                    'id': 'edit',
                    'name': 'edit',
                    'status': 'running',
                    'input': {'path': 'a.txt'},
                  },
                ],
              },
            ],
          },
        ],
        'interactions': [
          {
            'id': 'q',
            'epoch': 'e',
            'kind': 'confirm',
            'status': 'pending',
            'title': 'Allow edit?',
            'toolCallId': 'edit',
          },
        ],
      };
      await tester.pumpWidget(MobileApp(theme: theme, controller: c));
      await tester.pumpAndSettle();
      await c.open('s');
      g.stream.add({'type': 'snapshot', 'sessionId': 's', 'data': g.snapshot});
      c.connection = 'live';
      c.control = {'held': true, 'generation': 3};
      c.changed();
      await tester.pump(const Duration(milliseconds: 350));
      expect(find.byType(TimelineTool), findsNothing);
      expect(find.text('Internal details', findRichText: true), findsNothing);
      expect(find.byType(NativeInteractionCard), findsOneWidget);
      expect(find.text('Allow edit?'), findsOneWidget);
      final accept = find.widgetWithText(TextButton, 'Yes, continue');
      expect(accept, findsOneWidget);
      await tester.ensureVisible(accept);
      await tester.pump(const Duration(milliseconds: 350));
      expect(tester.widget<TextButton>(accept).onPressed, isNotNull);
      expect(accept.hitTestable(), findsOneWidget);
      final answered = {
        ...obj(rows(g.snapshot['interactions']).single),
        'status': 'answered',
      };
      g.snapshot = {
        ...g.snapshot,
        'interactions': [answered],
      };
      g.stream.add({'type': 'snapshot', 'sessionId': 's', 'data': g.snapshot});
      await tester.pump(const Duration(milliseconds: 350));
      expect(find.widgetWithText(TextButton, 'Yes, continue'), findsNothing);
      expect(g.calls.where((call) => call.$1 == 'answer'), isEmpty);
      await tester.pumpWidget(const SizedBox());
      await tester.pump();
      await g.stream.close();
    },
  );
}
