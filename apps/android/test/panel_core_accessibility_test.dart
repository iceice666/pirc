import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/context_pane.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/observational_memory_pane.dart';
import 'package:pirc_mobile/live/side_panel.dart';
import 'package:pirc_mobile/live/tasks_pane.dart';
import 'live_test.dart' show FakeGateway, theme;
import 'observational_memory_test.dart' show memoryView;

Json fixture(String name) => obj(
  jsonDecode(
    File('../../fixtures/mobile-parity/$name.json').readAsStringSync(),
  ),
);

Future<void> mountPanel(
  WidgetTester t,
  double width,
  Brightness brightness,
  String tab,
  Widget child,
) async {
  t.view.devicePixelRatio = 1;
  t.view.physicalSize = Size(width, 844);
  addTearDown(t.view.reset);
  final panelWidth = width <= 650 ? width : 420.0;
  await t.pumpWidget(
    MaterialApp(
      theme: theme.build(brightness),
      home: MediaQuery(
        data: MediaQueryData(
          size: Size(width, 844),
          textScaler: TextScaler.linear(2),
        ),
        child: Scaffold(
          body: Padding(
            // Same occupied top/bottom space as the app with safe areas.
            padding: const EdgeInsets.only(top: 80, bottom: 24),
            child: Align(
              alignment: Alignment.centerRight,
              child: SizedBox(
                width: panelWidth,
                child: NativeSidePanel(
                  tab: tab,
                  open: true,
                  overlay: true,
                  width: panelWidth,
                  maxWidth: panelWidth,
                  touch: true,
                  onSelect: (_) {},
                  onResize: (_) {},
                  child: child,
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await t.pumpAndSettle();
}

Finder verticalScrollIn(Finder pane) => find
    .descendant(
      of: pane,
      matching: find.byWidgetPredicate(
        (w) =>
            w is Scrollable &&
            (w.axisDirection == AxisDirection.down ||
                w.axisDirection == AxisDirection.up),
      ),
    )
    .first;

Future<void> reach(
  WidgetTester t,
  Finder pane,
  Finder target, {
  double delta = 240,
}) async {
  await t.scrollUntilVisible(target, delta, scrollable: verticalScrollIn(pane));
  await t.pumpAndSettle();
  await t.ensureVisible(target);
  await t.pumpAndSettle();
  expect(target.hitTestable(), findsOneWidget);
}

void main() {
  for (final width in [390.0, 768.0]) {
    for (final brightness in Brightness.values) {
      final name = '$width/${brightness.name}/2x';
      testWidgets('Context copy and source remain reachable in panel $name', (
        t,
      ) async {
        final g = FakeGateway(), c = LiveController(g)..sessionId = 's';
        final context = fixture('side-panel')['context'];
        g.handler = (_, _) async => context;
        String? clipboard, path;
        t.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          (call) async {
            if (call.method == 'Clipboard.setData') {
              clipboard = call.arguments['text'];
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
        await mountPanel(
          t,
          width,
          brightness,
          'context',
          ContextPane(controller: c, onFile: (p) => path = p),
        );
        final pane = find.byType(ContextPane);
        await reach(t, pane, find.text('Copy all'));
        await t.tap(find.text('Copy all'));
        await t.pumpAndSettle();
        expect(clipboard, 'Exact system prompt\nPreserve the source text.');
        final section = find.textContaining('System prompt ~');
        await reach(t, pane, section);
        await t.tap(section);
        await t.pumpAndSettle();
        await reach(t, pane, find.text('AGENTS.md'));
        await t.tap(find.text('AGENTS.md'));
        expect(path, 'AGENTS.md');
        await reach(
          t,
          pane,
          find.text('Exact system prompt\nPreserve the source text.'),
        );
        expect(t.takeException(), isNull);
        await t.pumpWidget(const SizedBox());
        c.dispose();
        await g.stream.close();
      });

      testWidgets(
        'Memory filters and full expansion remain reachable in panel $name',
        (t) async {
          final g = FakeGateway(), c = LiveController(g)..sessionId = 's';
          g.handler = (_, _) async => memoryView('active');
          await mountPanel(
            t,
            width,
            brightness,
            'memory',
            ObservationalMemoryPane(controller: c),
          );
          final pane = find.byType(ObservationalMemoryPane);
          await reach(t, pane, find.byKey(const ValueKey('memory-filter-all')));
          await t.tap(find.byKey(const ValueKey('memory-filter-all')));
          await t.pumpAndSettle();
          final entry = find.byKey(const ValueKey('memory-entry-a00000000001'));
          await reach(t, pane, entry);
          await t.tap(entry);
          await t.pumpAndSettle();
          final body = find
              .descendant(of: entry, matching: find.byType(Text))
              .first;
          expect(t.widget<Text>(body).maxLines, isNull);
          // The expanded entry is taller than the viewport: scroll its last text
          // line into view, rather than merely finding an instantiated widget.
          final rich = find
              .descendant(of: entry, matching: find.byType(RichText))
              .first;
          final textBox = t.getRect(rich);
          final bottom = t.getRect(find.byType(NativeSidePanel)).bottom;
          if (textBox.bottom > bottom) {
            await t.drag(
              verticalScrollIn(pane),
              Offset(0, bottom - textBox.bottom - 24),
            );
            await t.pumpAndSettle();
          }
          expect(t.getRect(rich).bottom, lessThanOrEqualTo(bottom));
          await reach(
            t,
            pane,
            find.byKey(const ValueKey('memory-filter-dropped')),
            delta: -240,
          );
          await t.tap(find.byKey(const ValueKey('memory-filter-dropped')));
          await t.pumpAndSettle();
          await reach(
            t,
            pane,
            find.byKey(const ValueKey('memory-entry-a00000000002')),
          );
          expect(
            find.byKey(const ValueKey('memory-entry-a00000000001')),
            findsNothing,
          );
          expect(t.takeException(), isNull);
          await t.pumpWidget(const SizedBox());
          c.dispose();
          await g.stream.close();
        },
      );

      testWidgets(
        'Tasks activity and output controls remain reachable in panel $name',
        (t) async {
          final data = fixture('tasks');
          final g = FakeGateway(), c = LiveController(g)..sessionId = 's';
          var outputReads = 0;
          g.handler = (_, args) async {
            if ('${args['path']}'.contains('/background/')) {
              outputReads++;
              return data['output'];
            }
            return data['panel'];
          };
          await mountPanel(
            t,
            width,
            brightness,
            'tasks',
            TasksPane(controller: c),
          );
          final pane = find.byType(TasksPane);
          await reach(t, pane, find.text('RECENT TEAM ACTIVITY'));
          await reach(
            t,
            pane,
            find.text('Layout review complete. Two edge cases remain.'),
          );
          await t.scrollUntilVisible(
            find.text('bun run watch --verbose'),
            -240,
            scrollable: verticalScrollIn(pane),
          );
          await t.pumpAndSettle();
          expect(
            find.text('bun run watch --verbose').hitTestable(),
            findsOneWidget,
          );
          await t.tap(find.text('bun run watch --verbose'));
          await t.pumpAndSettle();
          expect(find.text('${obj(data['output'])['output']}'), findsOneWidget);
          expect(
            find.byTooltip('Refresh output').hitTestable(),
            findsOneWidget,
          );
          await t.tap(find.byTooltip('Refresh output'));
          await t.pumpAndSettle();
          expect(outputReads, 2);
          expect(find.byTooltip('Back').hitTestable(), findsOneWidget);
          await t.tap(find.byTooltip('Back'));
          await t.pumpAndSettle();
          expect(find.text('BACKGROUND TASKS'), findsOneWidget);
          expect(t.takeException(), isNull);
          await t.pumpWidget(const SizedBox());
          c.dispose();
          await g.stream.close();
        },
      );
    }
  }
}
