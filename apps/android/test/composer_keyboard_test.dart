import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/conversation_composer.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'live_test.dart' show FakeGateway, theme;

Future<void> Function()? _cleanup;

void keyboardTest(String name, Future<void> Function(WidgetTester) body) {
  testWidgets(name, (t) async {
    try {
      await body(t);
    } finally {
      await _cleanup?.call();
      _cleanup = null;
    }
  });
}

Future<(LiveController, TextEditingController, FakeGateway)> mount(
  WidgetTester t, {
  TargetPlatform platform = TargetPlatform.macOS,
  double width = 1024,
}) async {
  t.view.devicePixelRatio = 1;
  t.view.physicalSize = Size(width, 800);
  addTearDown(t.view.reset);
  final g = FakeGateway();
  final c = LiveController(g)
    ..sessionId = 's'
    ..connection = 'live'
    ..control = {'held': true};
  final text = TextEditingController();
  text.addListener(() => c.editDraft(text.text));
  await t.pumpWidget(
    MaterialApp(
      theme: theme.build(Brightness.light).copyWith(platform: platform),
      home: Scaffold(
        body: AnimatedBuilder(
          animation: c,
          builder: (context, _) =>
              ConversationComposer(controller: c, text: text),
        ),
      ),
    ),
  );
  await t.showKeyboard(find.byKey(const Key('live-draft')));
  _cleanup = () async {
    await t.pumpWidget(const SizedBox.shrink());
    text.dispose();
    c.dispose();
    await g.stream.close();
  };
  return (c, text, g);
}

List<Json> commands(FakeGateway g) => g.calls
    .where((call) => call.$1 == 'command')
    .map((call) => obj(call.$2['payload']))
    .toList();

void main() {
  for (final width in [390.0, 1024.0]) {
    keyboardTest('desktop Enter sends prompt at width $width', (t) async {
      final (_, text, g) = await mount(t, width: width);
      await t.enterText(find.byKey(const Key('live-draft')), 'hello');
      await t.sendKeyEvent(LogicalKeyboardKey.enter);
      await t.pumpAndSettle();
      expect(commands(g).map((p) => p['type']), ['set_thinking', 'prompt']);
      expect(commands(g).last['message'], 'hello');
      expect(text.text, 'hello'); // The parent owns acknowledged draft syncing.
    });
    keyboardTest('touch Enter keeps newline at width $width', (t) async {
      final (_, text, g) = await mount(
        t,
        platform: TargetPlatform.android,
        width: width,
      );
      await t.enterText(find.byKey(const Key('live-draft')), 'hello');
      await t.sendKeyEvent(LogicalKeyboardKey.enter);
      await t.pumpAndSettle();
      expect(commands(g), isEmpty);
      // Android delegates newline insertion to its platform text input.
      t.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: 'hello\n',
          selection: TextSelection.collapsed(offset: 6),
        ),
      );
      await t.pump();
      expect(text.text, 'hello\n');
    });
  }
  keyboardTest('Shift Enter and composing Enter never submit', (t) async {
    final (_, text, g) = await mount(t);
    await t.enterText(find.byKey(const Key('live-draft')), 'first');
    await t.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await t.sendKeyEvent(LogicalKeyboardKey.enter);
    await t.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await t.pump();
    expect(commands(g), isEmpty);
    expect(
      t.widget<TextField>(find.byKey(const Key('live-draft'))).textInputAction,
      TextInputAction.newline,
    );
    t.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: 'first\n',
        selection: TextSelection.collapsed(offset: 6),
      ),
    );
    await t.pump();
    expect(text.text, 'first\n');
    text.value = const TextEditingValue(
      text: '中文',
      selection: TextSelection.collapsed(offset: 2),
      composing: TextRange(start: 0, end: 2),
    );
    await t.pump();
    await t.sendKeyEvent(LogicalKeyboardKey.enter);
    await t.pump();
    expect(commands(g), isEmpty);
  });
  keyboardTest('Enter steers an active run, empty Enter never stops it', (
    t,
  ) async {
    final (c, _, g) = await mount(t);
    c.state = {
      'run': {'status': 'running'},
    };
    c.changed();
    await t.pump();
    await t.sendKeyEvent(LogicalKeyboardKey.enter);
    await t.pump();
    expect(commands(g), isEmpty);
    await t.enterText(find.byKey(const Key('live-draft')), 'change direction');
    await t.sendKeyEvent(LogicalKeyboardKey.numpadEnter);
    await t.pumpAndSettle();
    expect(commands(g).single['type'], 'steer');
  });
  keyboardTest(
    'blocked Enter preserves draft without sending or adding newline',
    (t) async {
      final (c, text, g) = await mount(t);
      for (final reason in [
        'offline',
        'control',
        'busy',
        'uploading',
        'unknown',
      ]) {
        c.connection = reason == 'offline' ? 'offline' : 'live';
        c.control = {'held': reason != 'control'};
        c.busy = reason == 'busy';
        c.unknownCommand = reason == 'unknown';
        c.uploading = reason == 'uploading';
        c.changed();
        await t.enterText(find.byKey(const Key('live-draft')), 'keep $reason');
        await t.pump();
        await t.sendKeyEvent(LogicalKeyboardKey.enter);
        await t.pump();
        expect(text.text, 'keep $reason');
        expect(commands(g), isEmpty);
      }
    },
  );
}
