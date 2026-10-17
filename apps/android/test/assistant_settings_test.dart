import 'dart:async';
import 'dart:ui' show SemanticsValidationResult, PointerDeviceKind;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/assistant_settings.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'live_test.dart' show FakeGateway, theme;

Json prompt({bool writable = true, String? reason, int max = 100}) => {
  'text': 'original',
  'path': '/test/SOUL.md',
  'writable': writable,
  'reason': reason,
  'maxChars': max,
};
Widget shell(Widget child, {double scale = 1}) => MaterialApp(
  theme: theme.build(Brightness.light),
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(scale)),
    child: child!,
  ),
  home: Scaffold(
    body: SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: child,
    ),
  ),
);
Future<void> tap(WidgetTester t, String label) async {
  final button = find.widgetWithText(TextButton, label);
  await t.ensureVisible(button);
  await t.pump();
  await t.tap(button);
  await t.pump();
}

void main() {
  testWidgets('narrow prompt counter wraps beside the actions like web flex', (
    t,
  ) async {
    t.view.devicePixelRatio = 1;
    t.view.physicalSize = const Size(320, 900);
    addTearDown(t.view.reset);
    final g = FakeGateway(), c = LiveController(g);
    await t.pumpWidget(
      shell(
        AssistantPromptEditor(
          controller: c,
          name: 'soul',
          nodeId: 'n',
          prompt: {...prompt(max: 12000), 'text': 'x' * 52},
        ),
      ),
    );
    final count = t.getRect(find.text('52 / 12000 characters'));
    final revert = t.getRect(find.widgetWithText(TextButton, 'Revert'));
    final save = t.getRect(find.widgetWithText(TextButton, 'Save'));
    expect(count.height, greaterThan(15));
    expect(count.center.dy, revert.center.dy);
    expect(save.top, revert.top);
    // The test font has wider minimum words than the browser font.
    // CSS keeps the actions on the row even when that minimum overflows.
    expect(save.right, greaterThan(296));
    expect(t.takeException(), isNull);
    await t.pumpWidget(const SizedBox());
    c.dispose();
    await g.stream.close();
  });

  testWidgets(
    'prompt resize matches browser deltas for editable readonly and saving fields',
    (t) async {
      final g = FakeGateway(), c = LiveController(g);
      for (final kind in [PointerDeviceKind.touch, PointerDeviceKind.mouse]) {
        for (final mode in ['editable', 'readonly', 'saving']) {
          final writable = mode != 'readonly';
          final pending = Completer<Json>();
          g.handler = (_, args) => pending.future;
          await t.pumpWidget(
            shell(
              AssistantPromptEditor(
                controller: c,
                name: 'soul',
                nodeId: 'n',
                prompt: prompt(writable: writable),
              ),
            ),
          );
          final field = find.byKey(const ValueKey('assistant-soul-text'));
          final grip = find.byKey(const ValueKey('assistant-soul-resize'));
          final initialWidth = t.getSize(field).width;
          final initialHeight = t.getSize(field).height;
          // The initial eight-row height follows the active font's normal
          // metrics. The browser resize contract is its exact pointer delta.
          expect(initialHeight, greaterThan(15));
          if (mode == 'saving') {
            await t.enterText(field, 'changed');
            await tap(t, 'Save');
            expect(t.widget<TextField>(field).enabled, isFalse);
          }
          await t.ensureVisible(grip);
          await t.drag(grip, const Offset(40, 80), kind: kind);
          await t.pump();
          expect(t.getSize(field).height, initialHeight + 80);
          expect(t.getSize(field).width, initialWidth);
          await t.ensureVisible(grip);
          await t.drag(grip, const Offset(0, -400), kind: kind);
          await t.pump();
          expect(t.getSize(field).height, 15);
          expect(
            t.widget<TextField>(field).controller!.text,
            mode == 'saving' ? 'changed' : 'original',
          );
          expect(t.takeException(), isNull);
          if (mode == 'saving') {
            pending.complete({
              'prompt': {...prompt(), 'text': 'changed'},
            });
            await t.pumpAndSettle();
            expect(t.getSize(field).height, 15);
          }
          await t.pumpWidget(const SizedBox());
        }
      }
      c.dispose();
      await g.stream.close();
    },
  );

  testWidgets(
    'prompt semantics expose count and validation through edit and revert',
    (t) async {
      final semantics = t.ensureSemantics();
      final g = FakeGateway(), c = LiveController(g);
      await t.pumpWidget(
        shell(
          AssistantPromptEditor(
            controller: c,
            name: 'soul',
            nodeId: 'n',
            prompt: prompt(max: 10),
          ),
        ),
      );
      final field = find.byKey(const ValueKey('assistant-soul-text'));
      void check(String count, SemanticsValidationResult validation) {
        final data = t.getSemantics(field).getSemanticsData();
        expect(data.label, 'Soul');
        expect(data.hint, count);
        expect(data.validationResult, validation);
      }

      final heading = t.getSemantics(find.text('SOUL')).getSemanticsData();
      expect(heading.headingLevel, 3);
      check('8 / 10 characters', SemanticsValidationResult.valid);
      await t.enterText(field, '123456789😀');
      await t.pump();
      check('11 / 10 characters', SemanticsValidationResult.invalid);
      expect(
        t.widget<TextButton>(find.widgetWithText(TextButton, 'Save')).onPressed,
        isNull,
      );
      await tap(t, 'Revert');
      check('8 / 10 characters', SemanticsValidationResult.valid);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
      semantics.dispose();
    },
  );

  testWidgets('prompt caret and external focus ring match textarea geometry', (
    t,
  ) async {
    final g = FakeGateway(), c = LiveController(g);
    for (final writable in [true, false]) {
      await t.pumpWidget(
        shell(
          AssistantPromptEditor(
            controller: c,
            name: 'soul',
            nodeId: 'n',
            prompt: prompt(writable: writable),
          ),
        ),
      );
      final field = find.byType(TextField);
      final editor = t
          .state<EditableTextState>(
            find.descendant(of: field, matching: find.byType(EditableText)),
          )
          .renderEditable;
      final caret = editor.getLocalRectForCaret(const TextPosition(offset: 0));
      expect(editor.localToGlobal(caret.topLeft).dx - t.getRect(field).left, 3);
      final before = t.getSize(field);
      await t.ensureVisible(field);
      await t.tap(field);
      await t.pump();
      final box = t.getRect(field);
      final ring = t.getRect(
        find.byKey(const ValueKey('assistant-soul-focus-ring')),
      );
      expect(ring, box.inflate(4));
      expect(t.getSize(field), before);
      expect(t.widget<TextField>(field).readOnly, !writable);
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
    }
    c.dispose();
    await g.stream.close();
  });

  testWidgets('save uses exact node and draft, applies canonical response', (
    t,
  ) async {
    final g = FakeGateway(), c = LiveController(g)..origin = 'one';
    g.handler = (_, args) async => {
      'prompt': {...prompt(), 'text': 'canonical'},
    };
    await t.pumpWidget(
      shell(
        AssistantPromptEditor(
          controller: c,
          name: 'soul',
          nodeId: 'node-1',
          prompt: prompt(),
        ),
      ),
    );
    final field = find.byType(TextField);
    await t.enterText(field, ' original\r\n');
    await t.pump();
    expect(
      t.widget<TextButton>(find.widgetWithText(TextButton, 'Save')).onPressed,
      isNull,
    );
    await t.enterText(field, ' new\r\ndraft ');
    await tap(t, 'Save');
    await t.pumpAndSettle();
    final request = g.calls.single.$2;
    expect(request['method'], 'PUT');
    expect(request['path'], '/api/assistant/prompts/soul');
    expect(request['body'], {'text': ' new\r\ndraft ', 'nodeId': 'node-1'});
    expect(t.widget<TextField>(field).controller!.text, 'canonical');
    expect(
      find.text('Saved. Applies at the next chat agent start.'),
      findsOneWidget,
    );
    await t.pumpWidget(const SizedBox());
    c.dispose();
    await g.stream.close();
  });
  testWidgets(
    'failed save retains draft and refreshes changed file permissions',
    (t) async {
      final g = FakeGateway(), c = LiveController(g);
      g.handler = (_, args) async {
        if (args['method'] == 'PUT') {
          throw PlatformException(code: 'HTTP_409', message: 'Managed file');
        }
        return {
          'nodeId': 'node-1',
          'soul': {
            ...prompt(writable: false, reason: 'symlink'),
            'text': 'external',
          },
        };
      };
      await t.pumpWidget(
        shell(
          AssistantPromptEditor(
            controller: c,
            name: 'soul',
            nodeId: 'node-1',
            prompt: prompt(),
          ),
        ),
      );
      await t.enterText(find.byType(TextField), 'my draft');
      await tap(t, 'Save');
      await t.pumpAndSettle();
      expect(
        t.widget<TextField>(find.byType(TextField)).controller!.text,
        'my draft',
      );
      expect(t.widget<TextField>(find.byType(TextField)).readOnly, true);
      expect(
        find.text('Managed symlink: edit its source file.'),
        findsOneWidget,
      );
      expect(g.calls.where((e) => e.$2['method'] == 'PUT').length, 1);
      await tap(t, 'Revert');
      expect(
        t.widget<TextField>(find.byType(TextField)).controller!.text,
        'external',
      );
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets('node conflict cannot retarget draft or replay a save', (
    t,
  ) async {
    final g = FakeGateway(), c = LiveController(g);
    g.handler = (_, args) async {
      if (args['method'] == 'PUT') {
        throw PlatformException(code: 'HTTP_409', message: 'Binding changed');
      }
      return {
        'nodeId': 'node-2',
        'soul': {'text': 'other node'},
      };
    };
    await t.pumpWidget(
      shell(
        AssistantPromptEditor(
          controller: c,
          name: 'soul',
          nodeId: 'node-1',
          prompt: prompt(),
        ),
      ),
    );
    await t.enterText(find.byType(TextField), 'draft');
    await tap(t, 'Save');
    await t.pumpAndSettle();
    expect(
      t.widget<TextField>(find.byType(TextField)).controller!.text,
      'draft',
    );
    await tap(t, 'Revert');
    expect(
      t.widget<TextField>(find.byType(TextField)).controller!.text,
      'original',
    );
    expect(g.calls.where((e) => e.$2['method'] == 'PUT').length, 1);
    await t.pumpWidget(const SizedBox());
    c.dispose();
    await g.stream.close();
  });
  testWidgets('UTF16 length gate and pending save prevent duplicate writes', (
    t,
  ) async {
    final g = FakeGateway(), c = LiveController(g), pending = Completer<Json>();
    g.handler = (_, args) async => pending.future;
    await t.pumpWidget(
      shell(
        AssistantPromptEditor(
          controller: c,
          name: 'chat',
          nodeId: 'n',
          prompt: prompt(max: 4),
        ),
      ),
    );
    await t.enterText(find.byType(TextField), '😀😀x');
    await t.pump();
    expect(find.text('5 / 4 characters'), findsOneWidget);
    expect(
      t.widget<TextButton>(find.widgetWithText(TextButton, 'Save')).onPressed,
      isNull,
    );
    await t.enterText(find.byType(TextField), '😀😀');
    await tap(t, 'Save');
    expect(t.widget<TextField>(find.byType(TextField)).enabled, false);
    expect(
      t
          .widget<TextButton>(find.widgetWithText(TextButton, 'Saving…'))
          .onPressed,
      isNull,
    );
    pending.complete({
      'prompt': {...prompt(max: 4), 'text': '😀😀'},
    });
    await t.pumpAndSettle();
    expect(g.calls.length, 1);
    await t.pumpWidget(const SizedBox());
    c.dispose();
    await g.stream.close();
  });
  testWidgets(
    'offline binding skips files; release requires confirmation and exact node',
    (t) async {
      final g = FakeGateway(), c = LiveController(g);
      g.handler = (_, args) async => '${args['path']}'.endsWith('/release')
          ? {'nodeId': null, 'online': false}
          : {'nodeId': 'offline-node', 'online': false};
      await t.pumpWidget(shell(AssistantSettings(controller: c)));
      await t.pumpAndSettle();
      expect(find.text('Chat node: offline-node — offline'), findsOneWidget);
      expect(g.calls.length, 1);
      await tap(t, 'Release chat node binding');
      expect(g.calls.length, 1);
      expect(find.textContaining('Stop the old chat node'), findsOneWidget);
      await tap(t, 'Confirm release');
      await t.pumpAndSettle();
      expect(g.calls.last.$2['body'], {'nodeId': 'offline-node'});
      expect(
        find.text('No chat node is bound. Start a chat node to register it.'),
        findsOneWidget,
      );
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'account switch discards editors and ignores an old pending read',
    (t) async {
      final g = FakeGateway(), c = LiveController(g)..origin = 'old';
      final pending = Completer<Json>();
      g.handler = (_, args) async {
        if (c.origin == 'old') {
          if (args['path'] == '/api/assistant/node') {
            return {'nodeId': 'old-node', 'online': true};
          }
          return pending.future;
        }
        return {'nodeId': 'new-node', 'online': false};
      };
      await t.pumpWidget(shell(AssistantSettings(controller: c)));
      await t.pump();
      c.origin = 'new';
      c.changed();
      await t.pumpAndSettle();
      pending.complete({
        'nodeId': 'old-node',
        'soul': prompt(),
        'chat': prompt(),
      });
      await t.pumpAndSettle();
      expect(find.text('Chat node: new-node — offline'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
      expect(find.text('Loading…'), findsNothing);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'managed prompts and actions lay out at 2x text without render errors',
    (t) async {
      for (final width in [390.0, 651.0, 1024.0]) {
        t.view.devicePixelRatio = 1;
        t.view.physicalSize = Size(width, 844);
        final g = FakeGateway(), c = LiveController(g);
        g.handler = (_, args) async => '${args['path']}'.endsWith('/node')
            ? {'nodeId': 'n', 'online': true}
            : {
                'nodeId': 'n',
                'soul': prompt(),
                'chat': prompt(writable: false, reason: 'nix-store'),
              };
        await t.pumpWidget(shell(AssistantSettings(controller: c), scale: 2));
        await t.pumpAndSettle();
        const managedText = 'Managed by Nix: edit services.pirc.chatPrompt.';
        final managedParagraph = find.byWidgetPredicate(
          (widget) =>
              widget is RichText &&
              widget.text
                      .toPlainText(includeSemanticsLabels: false)
                      .replaceAll('\uFFFC', '') ==
                  managedText,
        );
        await t.ensureVisible(managedParagraph);
        expect(managedParagraph, findsOneWidget);
        expect(
          find.ancestor(
            of: managedParagraph,
            matching: find.byType(SelectionArea),
          ),
          findsOneWidget,
        );
        await t.pump();
        expect(t.takeException(), isNull);
        await t.pumpWidget(const SizedBox());
        c.dispose();
        await g.stream.close();
      }
      t.view.reset();
    },
  );
}
