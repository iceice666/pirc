import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:pirc_mobile/live/tasks_pane.dart' show PanelChip;
import 'package:flutter/services.dart' show LogicalKeyboardKey;
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/git_state.dart';
import 'package:pirc_mobile/live/git_pane.dart';
import 'package:pirc_mobile/live/diff_view.dart';
import 'live_test.dart' show FakeGateway, theme;
import '../tool/parity/capture_fonts.dart' show loadParityFonts;

final gitFixture = obj(
  jsonDecode(File('../../fixtures/mobile-parity/git.json').readAsStringSync()),
);
Json gitResponse(String path, {String view = 'changes'}) {
  if (path.contains('/commits/')) return obj(gitFixture['commit']);
  if (path.contains('/diff?')) return obj(gitFixture['diff']);
  if (path.contains('/log?')) {
    return obj(gitFixture[path.contains('skip=0') ? 'log' : 'next']);
  }
  return view == 'nonrepo'
      ? {'repo': false}
      : view == 'clean'
      ? {...obj(gitFixture['status']), 'files': []}
      : obj(gitFixture['status']);
}

void main() {
  test(
    'unified diff matches line numbers, metadata and final newline handling',
    () {
      final lines = parseUnifiedDiff('${obj(gitFixture['diff'])['diff']}');
      expect(lines.first.text, 'src/main.ts');
      expect(lines.where((l) => l.kind == 'del').single.old, 2);
      expect(lines.where((l) => l.kind == 'add').map((l) => l.next), [2, 3]);
      expect(lines.last.old, 4);
      expect(lines.last.next, 5);
      final binary = parseUnifiedDiff(
        'diff --git a/a b/b\nold mode 100644\nnew mode 100755\nBinary files a/a and b/b differ\n',
      );
      expect(binary.map((l) => l.kind), ['file', 'meta', 'meta', 'meta']);
      final eof = parseUnifiedDiff(
        '@@ -2 +3 @@\n-a\n+b\n\\ No newline at end of file\n',
      );
      expect(eof.last.kind, 'meta');
    },
  );
  testWidgets(
    'history appends pages, prepends new commits and resets rewritten history',
    (t) async {
      final g = FakeGateway(), c = LiveController(g)..sessionId = 's';
      g.handler = (_, a) async => gitResponse('${a['path']}');
      final s = GitState(c);
      await t.pump();
      expect(s.staged.length, 2);
      expect(s.unstaged.length, 3);
      await s.switchView('history');
      expect(s.commits.length, 2);
      await s.loadHistory();
      expect(s.commits.length, 3);
      expect(s.more, false);
      final newest = {...s.commits.first, 'sha': 'd' * 40};
      g.handler = (_, a) async => '${a['path']}'.contains('/log?')
          ? {
              'commits': [newest, ...rows(obj(gitFixture['log'])['commits'])],
              'more': true,
            }
          : gitResponse('${a['path']}');
      await s.refreshHistory();
      expect(s.commits.map((c) => c['sha']), [
        'd' * 40,
        'a' * 40,
        'b' * 40,
        'c' * 40,
      ]);
      expect(s.more, false);
      g.handler = (_, _) async => {
        'commits': [
          {'sha': 'rewritten'},
        ],
        'more': true,
      };
      await s.refreshHistory();
      expect(s.commits.single['sha'], 'rewritten');
      expect(s.more, true);
      s.dispose();
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'stale diff/commit replies, session isolation and hidden refresh',
    (t) async {
      final g = FakeGateway(), c = LiveController(g)..sessionId = 's';
      g.handler = (_, a) async => gitResponse('${a['path']}');
      final s = GitState(c);
      await t.pump();
      final first = Completer<Json>(), second = Completer<Json>();
      var reads = 0;
      g.handler = (_, _) => ++reads == 1 ? first.future : second.future;
      final a = s.openDiff(s.files.first, true),
          b = s.openDiff(s.files.last, false);
      second.complete({'diff': 'new', 'truncated': false});
      await b;
      first.complete({'diff': 'old'});
      await a;
      expect(s.diff?['diff'], 'new');
      final commit = Completer<Json>();
      g.handler = (_, _) => commit.future;
      final pending = s.openCommit({'sha': 'a'});
      s.back();
      commit.complete(gitFixture['commit']);
      await pending;
      expect(s.commit, isNull);
      g.handler = (_, a) async => gitResponse('${a['path']}');
      s.setActive(false);
      final before = g.calls.length;
      g.stream.add({
        'type': 'panelChange',
        'sessionId': 's',
        'data': ['git'],
      });
      await t.pump();
      expect(g.calls.length, before);
      expect(s.stale, true);
      s.setActive(true);
      await t.pump();
      expect(g.calls.length, before + 1);
      final old = Completer<Json>(), next = Completer<Json>();
      g.handler = (_, a) =>
          '${a['path']}'.contains('/sessions/next/') ? next.future : old.future;
      final read = s.load();
      c.sessionId = 'next';
      c.changed();
      old.complete(gitFixture['status']);
      await read;
      expect(s.status, isNull);
      next.complete({'repo': false});
      await t.pump();
      expect(s.status?['repo'], false);
      s.dispose();
      c.dispose();
      await g.stream.close();
    },
  );
  for (final scale in [1.0, 2.0]) {
    testWidgets('Git UI diff/history/file navigation at $scale text', (
      t,
    ) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = const Size(390, 1100);
      addTearDown(t.view.reset);
      final g = FakeGateway(), c = LiveController(g)..sessionId = 's';
      g.handler = (_, a) async => gitResponse('${a['path']}');
      String? opened;
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
            body: GitPane(
              controller: c,
              onFile: (p) => opened = p,
              clock: () =>
                  DateTime.fromMillisecondsSinceEpoch(gitFixture['now']),
            ),
          ),
        ),
      );
      await t.pumpAndSettle();
      expect(find.text('STAGED'), findsOneWidget);
      await t.tap(find.byKey(const ValueKey('git-file-src/main.ts-true')));
      await t.pumpAndSettle();
      expect(find.byType(NativeDiffView), findsOneWidget);
      expect(g.calls.last.$2['path'], contains('staged=1'));
      await t.tap(find.byTooltip('Open file'));
      expect(opened, 'src/main.ts');
      await t.tap(find.byTooltip('Back'));
      await t.pumpAndSettle();
      final history = find.byKey(const ValueKey('git-view-history'));
      await t.ensureVisible(history);
      await t.pumpAndSettle();
      expect(history.hitTestable(), findsOneWidget);
      await t.tap(history);
      await t.pumpAndSettle();
      expect(find.text('Load more'), findsOneWidget);
      if (scale == 1) {
        final ref = find.ancestor(
          of: find.text('origin/main'),
          matching: find.byType(PanelChip),
        );
        expect(t.getSize(ref).width, lessThan(160));
      }
      await t.tap(find.text('Load more'));
      await t.pumpAndSettle();
      expect(find.text('Initial commit'), findsOneWidget);
      await t.tap(find.byKey(ValueKey('git-commit-${'a' * 40}')));
      await t.pumpAndSettle();
      expect(find.textContaining('Keep the full diff'), findsOneWidget);
      await t.tap(find.byTooltip('Back'));
      await t.pumpAndSettle();
      expect(find.text('Initial commit'), findsOneWidget);
      expect(g.calls.where((c) => c.$2['method'] == 'POST'), isEmpty);
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    });
  }
  testWidgets('Git intrinsic rows and fixed tabs match 2x panel constraints', (
    t,
  ) async {
    await t.runAsync(loadParityFonts);
    addTearDown(t.view.reset);
    t.view.devicePixelRatio = 1;
    t.view.physicalSize = const Size(861, 844);
    final g = FakeGateway(), c = LiveController(g)..sessionId = 's';
    g.handler = (_, a) async => gitResponse('${a['path']}');
    await t.pumpWidget(
      MaterialApp(
        theme: theme.build(Brightness.light),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(2)),
          child: child!,
        ),
        home: Scaffold(
          body: Theme(
            data: theme
                .build(Brightness.light)
                .copyWith(
                  textTheme: theme
                      .build(Brightness.light)
                      .textTheme
                      .apply(fontFamily: 'Arial'),
                ),
            child: Align(
              alignment: Alignment.topLeft,
              child: SizedBox(
                width: 280,
                child: GitPane(controller: c, onFile: (_) {}),
              ),
            ),
          ),
        ),
      ),
    );
    await t.pumpAndSettle();

    final tab = find.byKey(const ValueKey('git-view-changes'));
    expect(t.getSize(tab).height, 26);
    final upstream = find.text('→ origin/main');
    expect(upstream, findsOneWidget);
    expect(t.getSize(upstream).width, closeTo(127.172, 1));
    expect(t.getSize(upstream).height, closeTo(60, 2));
    final renamed = find.byKey(const ValueKey('git-file-docs/guide.md-true'));
    expect(renamed, findsOneWidget);
    expect(t.getSize(renamed).width, closeTo(328.328, 1));
    expect(t.takeException(), isNull);
    await t.pumpWidget(const SizedBox());
    c.dispose();
    await g.stream.close();
  });
  testWidgets('Git roving keys and error states preserve the current data', (
    t,
  ) async {
    final g = FakeGateway(), c = LiveController(g)..sessionId = 's';
    final pending = Completer<Json>();
    g.handler = (_, _) => pending.future;
    await t.pumpWidget(
      MaterialApp(
        theme: theme.build(Brightness.light),
        home: Scaffold(
          body: GitPane(controller: c, onFile: (_) {}),
        ),
      ),
    );
    expect(find.text('Loading…'), findsOneWidget);
    pending.complete(gitFixture['status']);
    await t.pumpAndSettle();
    g.handler = (_, a) async => gitResponse('${a['path']}');
    final changes = find.byKey(const ValueKey('git-view-changes'));
    t.widget<InkWell>(changes).focusNode!.requestFocus();
    await t.pump();
    await t.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await t.pumpAndSettle();
    final history = find.byKey(const ValueKey('git-view-history'));
    expect(t.widget<InkWell>(history).focusNode!.hasFocus, isTrue);
    expect(find.text('Load more'), findsOneWidget);
    await t.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await t.pumpAndSettle();
    final checkpoints = find.byKey(const ValueKey('git-view-checkpoints'));
    expect(t.widget<InkWell>(checkpoints).focusNode!.hasFocus, isTrue);
    await t.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await t.pumpAndSettle();
    expect(t.widget<InkWell>(find.byKey(const ValueKey('git-view-changes'))).focusNode!.hasFocus, isTrue);
    await t.sendKeyEvent(LogicalKeyboardKey.home);
    await t.pumpAndSettle();
    expect(t.widget<InkWell>(changes).focusNode!.hasFocus, isTrue);
    g.handler = (_, _) async =>
        throw Exception('Status temporarily unavailable');
    await t.tap(find.byTooltip('Refresh'));
    await t.pumpAndSettle();
    expect(
      find.textContaining('Status temporarily unavailable'),
      findsOneWidget,
    );
    expect(find.text('STAGED'), findsOneWidget);
    g.handler = (_, _) async => throw Exception('Diff unavailable');
    await t.tap(find.byKey(const ValueKey('git-file-src/main.ts-true')));
    await t.pumpAndSettle();
    expect(find.textContaining('Diff unavailable'), findsOneWidget);
    await t.tap(find.byTooltip('Back'));
    await t.pumpAndSettle();
    expect(find.textContaining('Diff unavailable'), findsNothing);
    expect(t.takeException(), isNull);
    await t.pumpWidget(const SizedBox());
    c.dispose();
    await g.stream.close();
  });
  testWidgets(
    'diff pagination preserves all rows and exposes truncation only at end',
    (t) async {
      final diff =
          'diff --git a/a b/a\n@@ -0,0 +1,6000 @@\n${List.generate(6000, (i) => '+line $i').join('\n')}\n';
      await t.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.dark),
          home: Scaffold(
            body: SingleChildScrollView(
              child: NativeDiffView(diff: diff, truncated: true),
            ),
          ),
        ),
      );
      expect(find.text('line 1997'), findsOneWidget);
      expect(find.text('line 1998'), findsNothing);
      expect(find.text('Diff truncated at 1 MB.'), findsNothing);
      final more = find.text('Show 4,000 more lines (4,002 hidden)');
      await t.ensureVisible(more);
      await t.pumpAndSettle();
      await t.tap(more);
      await t.pumpAndSettle();
      final rest = find.text('Show 2 more lines (2 hidden)');
      await t.ensureVisible(rest);
      await t.pumpAndSettle();
      await t.tap(rest);
      await t.pumpAndSettle();
      expect(find.text('line 5999'), findsOneWidget);
      expect(find.text('Diff truncated at 1 MB.'), findsOneWidget);
      expect(t.takeException(), isNull);
    },
  );
}
