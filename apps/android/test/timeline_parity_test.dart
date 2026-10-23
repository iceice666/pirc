import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/conversation_timeline.dart';
import 'package:pirc_mobile/live/timeline_tools.dart';
import 'package:pirc_mobile/live/timeline_models.dart';
import 'live_test.dart' show FakeGateway, theme;

Json fixture() => obj(
  jsonDecode(
    File('../../fixtures/mobile-parity/timeline.json').readAsStringSync(),
  ),
);
Widget shell(LiveController c, {double scale = 1}) => MaterialApp(
  theme: theme.build(Brightness.light),
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(scale)),
    child: child!,
  ),
  home: Scaffold(
    body: ListenableBuilder(
      listenable: c,
      builder: (_, _) => SingleChildScrollView(
        padding: const EdgeInsets.all(14),
        child: ConversationTimeline(controller: c),
      ),
    ),
  ),
);
void main() {
  testWidgets('message clock keeps the web two-digit hour in 12-hour locales', (
    t,
  ) async {
    final g = FakeGateway(), c = LiveController(g);
    c.state = {
      'messages': [
        {
          'id': 'clock',
          'role': 'user',
          'content': 'Clock sample',
          'createdAt': DateTime(2026, 10, 5, 8).toIso8601String(),
        },
      ],
    };
    await t.pumpWidget(shell(c));
    await t.pumpAndSettle();
    expect(find.text('08:00 AM'), findsOneWidget);
    expect(find.text('8:00 AM'), findsNothing);
    await t.pumpWidget(const SizedBox());
    c.dispose();
    await g.stream.close();
  });

  test('grouping and run summary follow the pinned web outputs', () {
    final f = obj(
      jsonDecode(
        File(
          '../../fixtures/mobile-parity/timeline-models.json',
        ).readAsStringSync(),
      ),
    );
    for (final row in rows(f['cases'])) {
      final items = timelineItems(rows(row['messages']));
      expect([
        for (final i in items)
          {
            'kind': i.run ? 'run' : 'message',
            'id': i.id,
            'messages': i.messages.map((m) => m['id']).toList(),
          },
      ], row['items']);
      final s = RunSummary(rows(row['tools']));
      expect({
        'count': s.count,
        'status': s.status,
        if (s.durationMs != null) 'durationMs': s.durationMs,
        'files': s.files,
      }, row['summary']);
    }
    expect(
      toolDescription({
        'name': 'read',
        'input': {'path': 'a.ts', 'offset': 3, 'limit': 4},
      }),
      'a.ts:3–6',
    );
    expect(
      residualInput({
        'name': 'write',
        'input': {'path': 'a', 'content': 'secret content', 'mode': 'replace'},
      }),
      {'mode': 'replace'},
    );
    expect(toolElapsed({'startedAt': 1000, 'endedAt': 900}), isEmpty);
    expect(toolElapsed({'startedAt': 1000, 'endedAt': 2200}), '1.2 s');
    expect(
      writeBlock({
        'status': 'failed',
        'output':
            'a.ts is being written by session "Other chat" (x); wait until its run finishes',
      }),
      (path: 'a.ts', holderName: 'Other chat'),
    );
    expect(
      clipToolText('x' * 201234).endsWith('… 1,234 more characters not shown'),
      isTrue,
    );
  });
  testWidgets(
    'incoming failures keep both activity and tool output collapsed',
    (t) async {
      final g = FakeGateway(), c = LiveController(g);
      c.state = {
        'messages': [
          {
            'id': 'm',
            'role': 'assistant',
            'content': '',
            'tools': [
              {
                'id': 't',
                'name': 'bash',
                'status': 'running',
                'input': {'command': 'pwd'},
              },
            ],
          },
        ],
      };
      await t.pumpWidget(shell(c));
      // A running tool now has a continuous loader; wait for entry layout,
      // without waiting for the intentionally live animation to end.
      await t.pump(const Duration(milliseconds: 350));
      expect(find.text('Command'), findsNothing);
      final tool = rows(c.messages.first['tools']).first;
      c.state = {
        'messages': [
          {
            ...c.messages.first,
            'tools': [
              {...tool, 'status': 'failed', 'output': 'Failure details'},
            ],
          },
        ],
      };
      c.changed();
      await t.pumpAndSettle();
      expect(find.text('Command'), findsNothing);
      expect(find.textContaining('1 failed'), findsOneWidget);
      await t.tap(find.textContaining('Completed 1 operations'));
      await t.pumpAndSettle();
      expect(find.text('Command'), findsNothing);
      await t.tap(find.text('bash'));
      await t.pumpAndSettle();
      expect(find.text('Command'), findsOneWidget);
      expect(find.text('Error'), findsOneWidget);
      await t.tap(find.text('bash'));
      await t.pumpAndSettle();
      expect(find.text('Command'), findsNothing);
      c.changed();
      await t.pump();
      expect(find.text('Command'), findsNothing);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'activity and thoughts open only on request, copy preserves source',
    (t) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = const Size(390, 1400);
      addTearDown(t.view.reset);
      final g = FakeGateway(),
          c = LiveController(g)..state = {'messages': fixture()['messages']};
      String? copied;
      t.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            copied = call.arguments['text'];
          }
          return null;
        },
      );
      addTearDown(
        () => t.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      await t.pumpWidget(shell(c));
      await t.pumpAndSettle();
      expect(find.byType(ResponseActivity), findsOneWidget);
      expect(find.text('read'), findsNothing);
      await t.tap(find.textContaining('Completed '));
      await t.pumpAndSettle();
      expect(find.text('read'), findsOneWidget);
      await t.tap(find.text('Thought'));
      await t.pumpAndSettle();
      expect(
        find.text('Compare the same viewport and theme.', findRichText: true),
        findsOneWidget,
      );
      await t.tap(find.byTooltip('Copy message').first);
      await t.pump();
      expect(copied, 'Check the native client layout.');
      c.state = {
        'messages': [
          {
            'id': 'stream',
            'role': 'assistant',
            'content': '',
            'partial': true,
            'thinking': 'Keep reasoning visible',
          },
        ],
      };
      c.changed();
      await t.pump(const Duration(milliseconds: 350));
      expect(find.text('Thinking…'), findsOneWidget);
      expect(
        find.textContaining('Keep reasoning visible', findRichText: true),
        findsNothing,
      );
      await t.tap(find.text('Thinking…'));
      await t.pump(const Duration(milliseconds: 350));
      expect(
        find.textContaining('Keep reasoning visible', findRichText: true),
        findsNothing,
      );
      await t.tap(find.text('Thinking…').last);
      await t.pump(const Duration(milliseconds: 350));
      expect(
        find.textContaining('Keep reasoning visible', findRichText: true),
        findsOneWidget,
      );
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  for (final (width, scale) in [
    (651.0, 1.0),
    (651.0, 2.0),
    (1024.0, 1.0),
    (1024.0, 2.0),
  ]) {
    testWidgets(
      'wide run summary flexes and clips files at ${width.toInt()}px / ${scale.toInt()}x',
      (t) async {
        t.view.devicePixelRatio = 1;
        t.view.physicalSize = Size(width, 500);
        addTearDown(t.view.reset);
        final paths = [
          '/src/very-long-first-file-name-abcdefghijklmnopqrstuvwxyz.dart',
          '/src/very-long-second-file-name-abcdefghijklmnopqrstuvwxyz.dart',
          '/src/third-long-file-name-abcdefghijklmnopqrstuvwxyz.dart',
          '/src/fourth.dart',
        ];
        final tools = <Json>[
          for (final (index, path) in paths.indexed)
            {
              'id': 't$index',
              'name': 'read',
              'status': 'succeeded',
              'input': {'path': path},
              'startedAt': '2026-10-03T02:30:00Z',
              'endedAt': '2026-10-03T02:30:01.200Z',
            },
        ];
        final cardWidth = width <= 700 ? width - 28 : 420.0;
        await t.pumpWidget(
          MaterialApp(
            theme: theme.build(Brightness.light),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(
                context,
              ).copyWith(textScaler: TextScaler.linear(scale)),
              child: child!,
            ),
            home: Scaffold(
              body: Center(
                child: SizedBox(
                  width: cardWidth,
                  child: TimelineRun(
                    tools: tools,
                    child: const SizedBox.shrink(),
                  ),
                ),
              ),
            ),
          ),
        );
        await t.pumpAndSettle();
        expect(t.takeException(), isNull);
        final titleRect = t.getRect(find.text('Explored the code'));
        final metaRect = t.getRect(find.text('4 tools · 1.2 s'));
        expect(metaRect.left, closeTo(titleRect.right + 8, 1));
        final stripRect = t.getRect(
          find.byKey(const ValueKey('timeline-run-files-clip')),
        );
        final tailRect = t.getRect(find.byKey(const ValueKey('+1')));
        final cardRect = t.getRect(
          find
              .descendant(
                of: find.byType(TimelineRun),
                matching: find.byType(Container),
              )
              .first,
        );
        final statusRect = t.getRect(find.byIcon(LucideIcons.check));
        expect(tailRect.right, closeTo(stripRect.right, 1));
        expect(
          statusRect.left,
          closeTo(metaRect.right + 8 + stripRect.width + 8, 1),
        );
        if (stripRect.width == 0) {
          expect(statusRect.right, greaterThanOrEqualTo(cardRect.right - 14));
        } else {
          expect(statusRect.right, closeTo(cardRect.right - 13, 1));
        }
        await t.pumpWidget(const SizedBox());
      },
    );
  }
  for (final width in [390.0, 651.0, 1024.0]) {
    testWidgets('timeline errors and tool input fit $width at 2x text', (
      t,
    ) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = Size(width, 1400);
      addTearDown(t.view.reset);
      final g = FakeGateway(),
          c = LiveController(g)..state = {'messages': fixture()['messages']};
      await t.pumpWidget(shell(c, scale: 2));
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      final summaryToggle = find
          .ancestor(
            of: find.textContaining('Completed '),
            matching: find.byType(InkWell),
          )
          .first;
      await t.ensureVisible(summaryToggle);
      await t.tap(summaryToggle);
      await t.pumpAndSettle();
      expect(find.text('read'), findsOneWidget);
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    });
  }
}
