import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/conversation_composer.dart';
import 'package:pirc_mobile/live/conversation_header.dart';
import 'live_test.dart' show FakeGateway, theme;

void main() {
  test(
    'prompt settings failure retains draft and prevents submission',
    () async {
      final g = FakeGateway(), c = LiveController(g);
      await c.boot();
      await c.open('s');
      g.publish('s');
      c.editDraft('keep until accepted');
      g.handler = (m, a) async =>
          m == 'command' && obj(a['payload'])['type'] == 'set_thinking'
          ? {'status': 'rejected', 'message': 'Unavailable'}
          : g.normal(m, a);
      await c.send('prompt');
      expect(
        g.calls
            .where((x) => x.$1 == 'command')
            .map((x) => obj(x.$2['payload'])['type']),
        ['set_model', 'set_thinking'],
      );
      expect(c.draft, 'keep until accepted');
      expect(c.busy, isFalse);
      expect(c.actionError, 'Unavailable');
      c.dispose();
      await g.stream.close();
    },
  );
  test(
    'read-only choice rides with next prompt; duplicate sends are blocked',
    () async {
      final g = FakeGateway(), c = LiveController(g);
      await c.boot();
      await c.open('s');
      g.publish('s');
      c.control = {};
      await c.changeThinking('high');
      expect(g.calls.where((x) => x.$1 == 'command'), isEmpty);
      c.control = {'held': true};
      c.editDraft('one message');
      final gate = Completer<Json>();
      g.handler = (m, a) async =>
          m == 'command' && obj(a['payload'])['type'] == 'set_model'
          ? gate.future
          : g.normal(m, a);
      final sent = c.send('prompt');
      await c.send('prompt');
      gate.complete({'status': 'accepted'});
      await sent;
      final commands = g.calls
          .where((x) => x.$1 == 'command')
          .map((x) => obj(x.$2['payload']))
          .toList();
      expect(commands.map((p) => p['type']), [
        'set_model',
        'set_thinking',
        'prompt',
      ]);
      expect(commands[1]['level'], 'high');
      expect(c.draft, isEmpty);
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'running composer steers text, whitespace stops, and offline drafts remain editable',
    (t) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = const Size(390, 900);
      addTearDown(t.view.reset);
      final g = FakeGateway(), c = LiveController(g);
      await t.pumpWidget(MobileApp(theme: theme, controller: c));
      await t.pumpAndSettle();
      await c.open('s');
      g.publish('s');
      c.state = {
        ...c.state,
        'run': {'status': 'running'},
      };
      c.changed();
      await t.pumpAndSettle();
      await t.enterText(find.byKey(const Key('live-draft')), '   ');
      await t.pump();
      final primaryStopGlyph = find.byKey(
        const Key('composer-stop-glyph-primary'),
      );
      expect(primaryStopGlyph, findsOneWidget);
      expect(
        t.getSize(primaryStopGlyph),
        const Size(13 * 20 / 24, 13 * 20 / 24),
      );
      expect(
        (t.widget<DecoratedBox>(primaryStopGlyph).decoration as BoxDecoration)
            .color,
        isNotNull,
      );
      await t.tap(find.byTooltip('Stop run'));
      await t.pumpAndSettle();
      expect(
        obj(g.calls.lastWhere((x) => x.$1 == 'command').$2['payload'])['type'],
        'stop',
      );
      await t.enterText(
        find.byKey(const Key('live-draft')),
        'change direction',
      );
      await t.pump();
      final secondaryStopGlyph = find.byKey(
        const Key('composer-stop-glyph-secondary'),
      );
      expect(secondaryStopGlyph, findsOneWidget);
      expect(
        t.getSize(secondaryStopGlyph),
        const Size(11 * 20 / 24, 11 * 20 / 24),
      );
      expect(
        (t.widget<DecoratedBox>(secondaryStopGlyph).decoration as BoxDecoration)
            .color,
        isNotNull,
      );
      final secondaryStopButton = find.ancestor(
        of: secondaryStopGlyph,
        matching: find.byType(IconButton),
      );
      expect(secondaryStopButton, findsOneWidget);
      expect(t.getSize(secondaryStopButton), const Size(34, 34));
      await t.tap(find.byTooltip('Send message'));
      await t.pumpAndSettle();
      expect(
        obj(g.calls.lastWhere((x) => x.$1 == 'command').$2['payload'])['type'],
        'steer',
      );
      c.connection = 'offline';
      c.state = {
        ...c.state,
        'run': {'status': 'idle'},
      };
      c.changed();
      await t.pump();
      await t.enterText(find.byKey(const Key('live-draft')), 'offline draft');
      await t.pump();
      final count = g.calls.where((x) => x.$1 == 'command').length;
      await t.tap(find.byTooltip('Send message'));
      await t.pump();
      expect(g.calls.where((x) => x.$1 == 'command').length, count);
      expect(c.draft, 'offline draft');
      expect(
        find.textContaining('never be sent automatically'),
        findsOneWidget,
      );
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
      await g.stream.close();
    },
  );
  testWidgets(
    'reasoning selector is independent, changes the command and closes',
    (t) async {
      final g = FakeGateway(), c = LiveController(g);
      await t.pumpWidget(MobileApp(theme: theme, controller: c));
      await t.pumpAndSettle();
      await c.open('s');
      g.publish('s');
      await t.pumpAndSettle();
      await t.tap(find.byTooltip('Reasoning effort'));
      await t.pumpAndSettle();
      await t.tap(find.text('High'));
      await t.pumpAndSettle();
      expect(obj(g.calls.lastWhere((x) => x.$1 == 'command').$2['payload']), {
        'type': 'set_thinking',
        'level': 'high',
      });
      expect(c.selectedThinking, 'high');
      expect(find.text('Extra high'), findsNothing);
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
      await g.stream.close();
    },
  );
  testWidgets(
    'short breadcrumb does not steal room from a fitting long title',
    (t) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = const Size(1400, 200);
      t.platformDispatcher.textScaleFactorTestValue = 2;
      addTearDown(t.view.reset);
      addTearDown(t.platformDispatcher.clearTextScaleFactorTestValue);
      final g = FakeGateway(), c = LiveController(g);
      c.state = {
        'session': {'name': 'Review native layout', 'workspaceId': 'repo'},
      };
      c.workspaces = [
        {'id': 'repo', 'kind': 'directory', 'displayName': 'Repo'},
      ];
      c.connection = 'live';
      c.control = {'held': true};
      await t.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.light),
          home: Scaffold(
            body: Align(
              alignment: Alignment.topLeft,
              child: SizedBox(
                width: 1300,
                height: 56,
                child: ConversationHeader(
                  controller: c,
                  sidebarCollapsed: false,
                  panelOpen: false,
                  onBack: () {},
                  onExpand: () {},
                  onPanel: () {},
                  onWorkspace: () {},
                  onOrigin: (_) {},
                ),
              ),
            ),
          ),
        ),
      );
      await t.pumpAndSettle();
      final title = find.descendant(
        of: find.text('Review native layout'),
        matching: find.byType(RichText),
      );
      final crumb = find.descendant(
        of: find.text('Repo'),
        matching: find.byType(RichText),
      );
      expect(t.renderObject<RenderParagraph>(title).didExceedMaxLines, isFalse);
      expect(t.renderObject<RenderParagraph>(crumb).didExceedMaxLines, isFalse);
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );

  for (final width in [390.0, 651.0]) {
    for (final scale in [1.0, 2.0]) {
      testWidgets(
        'composer selectors keep the web 34px height at $width/${scale}x',
        (t) async {
          t.view.devicePixelRatio = 1;
          t.view.physicalSize = Size(width, 900);
          t.platformDispatcher.textScaleFactorTestValue = scale;
          addTearDown(t.view.reset);
          addTearDown(t.platformDispatcher.clearTextScaleFactorTestValue);
          final g = FakeGateway(), c = LiveController(g);
          await t.pumpWidget(MobileApp(theme: theme, controller: c));
          await t.pumpAndSettle();
          await c.open('s');
          g.publish('s');
          await t.pumpAndSettle();

          final composer = find.byType(ConversationComposer);
          final triggers = find.descendant(
            of: composer,
            matching: find.byType(TextButton),
          );
          expect(triggers, findsNWidgets(2));
          for (var i = 0; i < triggers.evaluate().length; i++) {
            final trigger = triggers.at(i);
            expect(
              t.getSize(trigger).height,
              34,
              reason: '$width/$scale selector trigger height',
            );
            final label = find.descendant(
              of: trigger,
              matching: find.byType(Text),
            );
            expect(label, findsOneWidget);
            final text = t.widget<Text>(label);
            expect(text.maxLines, 1);
            expect(text.overflow, TextOverflow.ellipsis);
            expect(text.style?.height, kTextHeightNone);
          }
          expect(find.byTooltip('Model'), findsOneWidget);
          expect(find.byTooltip('Reasoning effort'), findsOneWidget);
          expect(t.takeException(), isNull);
          await t.pumpWidget(const SizedBox());
          await g.stream.close();
        },
      );
    }
  }

  for (final width in [390.0, 651.0, 1024.0]) {
    testWidgets('header/composer at $width, large text and pane', (t) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = Size(width, 1000);
      t.platformDispatcher.textScaleFactorTestValue = 2;
      addTearDown(t.view.reset);
      addTearDown(t.platformDispatcher.clearTextScaleFactorTestValue);
      final g = FakeGateway(), c = LiveController(g);
      await t.pumpWidget(MobileApp(theme: theme, controller: c));
      await t.pumpAndSettle();
      await c.open('s');
      g.publish('s');
      await t.pumpAndSettle();
      expect(find.byType(ConversationHeader), findsOneWidget);
      expect(find.byType(ConversationComposer), findsOneWidget);
      expect(t.takeException(), isNull);
      await t.tap(find.byTooltip('Show side panel'));
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
      await g.stream.close();
    });
  }
}
