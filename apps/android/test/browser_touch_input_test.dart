import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/browser_pointer_surface.dart';

const _surfaceKey = ValueKey('browser-pointer-surface-box');

Widget _app({
  required List<Map<String, dynamic>> messages,
  required VoidCallback onKeyboard,
  bool enabled = true,
  Object scope = 'scope-a',
  bool touchDrag = false,
  Size remoteSize = const Size(200, 300),
  Widget? child,
}) => MaterialApp(
  home: Scaffold(
    body: Align(
      alignment: Alignment.topLeft,
      child: SizedBox(
        key: _surfaceKey,
        width: 100,
        height: 100,
        child: BrowserPointerSurface(
          enabled: enabled,
          scope: scope,
          remoteSize: remoteSize,
          onMessage: messages.add,
          onKeyboard: onKeyboard,
          touchDrag: touchDrag,
          child: child ?? const SizedBox.expand(),
        ),
      ),
    ),
  ),
);

Offset _origin(WidgetTester tester) =>
    tester.getTopLeft(find.byKey(_surfaceKey));

void main() {
  testWidgets('touch tap sends a click only after release', (tester) async {
    final messages = <Map<String, dynamic>>[];
    var keyboardRequests = 0;
    await tester.pumpWidget(
      _app(messages: messages, onKeyboard: () => keyboardRequests++),
    );
    final origin = _origin(tester);

    final tap = await tester.startGesture(
      origin + const Offset(20, 10),
      kind: PointerDeviceKind.touch,
    );
    expect(messages, isEmpty);
    expect(keyboardRequests, 0);

    await tap.up();
    expect(keyboardRequests, 1);
    expect(messages, [
      {
        'type': 'mouse',
        'action': 'down',
        'x': 40,
        'y': 30,
        'button': 'left',
        'clickCount': 1,
      },
      {
        'type': 'mouse',
        'action': 'up',
        'x': 40,
        'y': 30,
        'button': 'left',
        'clickCount': 1,
      },
    ]);
  });

  testWidgets('touch swipe emits scaled horizontal and vertical wheel only', (
    tester,
  ) async {
    final messages = <Map<String, dynamic>>[];
    var keyboardRequests = 0;
    await tester.pumpWidget(
      _app(messages: messages, onKeyboard: () => keyboardRequests++),
    );
    final origin = _origin(tester);

    final swipe = await tester.startGesture(
      origin + const Offset(80, 80),
      kind: PointerDeviceKind.touch,
    );
    await swipe.moveTo(origin + const Offset(40, 80));
    await swipe.moveTo(origin + const Offset(40, 50));
    await swipe.up();

    expect(keyboardRequests, 0);
    expect(messages, [
      {'type': 'wheel', 'x': 160, 'y': 240, 'dx': 80.0, 'dy': 0.0},
      {'type': 'wheel', 'x': 160, 'y': 240, 'dx': 0.0, 'dy': 90.0},
    ]);
    expect(messages.every((message) => message['type'] == 'wheel'), isTrue);
  });

  testWidgets('touch drag mode forwards mouse drag and cancel releases it', (
    tester,
  ) async {
    final messages = <Map<String, dynamic>>[];
    var keyboardRequests = 0;
    await tester.pumpWidget(
      _app(
        messages: messages,
        onKeyboard: () => keyboardRequests++,
        touchDrag: true,
      ),
    );
    final origin = _origin(tester);

    final drag = await tester.startGesture(
      origin + const Offset(20, 30),
      kind: PointerDeviceKind.touch,
    );
    expect(messages, [
      {
        'type': 'mouse',
        'action': 'down',
        'x': 40,
        'y': 90,
        'button': 'left',
        'clickCount': 1,
      },
    ]);
    await drag.moveTo(origin + const Offset(40, 45));
    await drag.up();
    expect(messages, [
      {
        'type': 'mouse',
        'action': 'down',
        'x': 40,
        'y': 90,
        'button': 'left',
        'clickCount': 1,
      },
      {'type': 'mouse', 'action': 'move', 'x': 80, 'y': 135},
      {
        'type': 'mouse',
        'action': 'up',
        'x': 80,
        'y': 135,
        'button': 'left',
        'clickCount': 1,
      },
    ]);

    final cancel = await tester.startGesture(
      origin + const Offset(10, 20),
      kind: PointerDeviceKind.touch,
    );
    await cancel.moveTo(origin + const Offset(30, 40));
    await cancel.cancel();
    expect(keyboardRequests, 2);
    expect(messages.skip(3), [
      {
        'type': 'mouse',
        'action': 'down',
        'x': 20,
        'y': 60,
        'button': 'left',
        'clickCount': 1,
      },
      {'type': 'mouse', 'action': 'move', 'x': 60, 'y': 120},
      {
        'type': 'mouse',
        'action': 'up',
        'x': 60,
        'y': 120,
        'button': 'left',
        'clickCount': 1,
      },
    ]);
  });

  testWidgets('mouse buttons, move and wheel retain native pointer behavior', (
    tester,
  ) async {
    final messages = <Map<String, dynamic>>[];
    var keyboardRequests = 0;
    await tester.pumpWidget(
      _app(messages: messages, onKeyboard: () => keyboardRequests++),
    );
    final origin = _origin(tester);

    for (final (buttons, name) in <(int, String)>[
      (kPrimaryMouseButton, 'left'),
      (kMiddleMouseButton, 'middle'),
      (kSecondaryMouseButton, 'right'),
    ]) {
      final mouse = await tester.startGesture(
        origin + const Offset(10, 20),
        kind: PointerDeviceKind.mouse,
        buttons: buttons,
      );
      await mouse.moveTo(origin + const Offset(15, 25));
      await mouse.up();
      final offset = messages.length - 3;
      expect(messages.skip(offset).take(3), [
        {
          'type': 'mouse',
          'action': 'down',
          'x': 20,
          'y': 60,
          'button': name,
          'clickCount': 1,
        },
        {'type': 'mouse', 'action': 'move', 'x': 30, 'y': 75},
        {
          'type': 'mouse',
          'action': 'up',
          'x': 30,
          'y': 75,
          'button': name,
          'clickCount': 1,
        },
      ]);
    }

    tester.binding.handlePointerEvent(
      PointerScrollEvent(
        kind: PointerDeviceKind.mouse,
        position: origin + const Offset(50, 50),
        scrollDelta: const Offset(6, -14),
      ),
    );
    await tester.pump();

    expect(keyboardRequests, 3);
    expect(messages.last, {
      'type': 'wheel',
      'x': 100,
      'y': 150,
      'dx': 6.0,
      'dy': -14.0,
    });
  });

  testWidgets('disabling or changing control scope suppresses an old drag', (
    tester,
  ) async {
    final messages = <Map<String, dynamic>>[];
    var keyboardRequests = 0;
    Widget build({required bool enabled, required Object scope}) => _app(
      messages: messages,
      onKeyboard: () => keyboardRequests++,
      enabled: enabled,
      scope: scope,
      touchDrag: true,
    );

    await tester.pumpWidget(build(enabled: true, scope: 'first'));
    final origin = _origin(tester);
    final disabledDrag = await tester.startGesture(
      origin + const Offset(10, 10),
      kind: PointerDeviceKind.touch,
    );
    await disabledDrag.moveTo(origin + const Offset(20, 20));
    final beforeDisable = List<Map<String, dynamic>>.of(messages);
    await tester.pumpWidget(build(enabled: false, scope: 'first'));
    await disabledDrag.moveTo(origin + const Offset(30, 30));
    await disabledDrag.up();
    expect(messages, beforeDisable);

    await tester.pumpWidget(build(enabled: true, scope: 'first'));
    final scopedDrag = await tester.startGesture(
      origin + const Offset(10, 10),
      kind: PointerDeviceKind.touch,
    );
    await scopedDrag.moveTo(origin + const Offset(20, 20));
    final beforeScopeChange = List<Map<String, dynamic>>.of(messages);
    await tester.pumpWidget(build(enabled: true, scope: 'second'));
    await scopedDrag.up();
    expect(messages, beforeScopeChange);
    expect(keyboardRequests, 2);
  });

  testWidgets('disabled surface does not intercept a nested scroll view', (
    tester,
  ) async {
    final messages = <Map<String, dynamic>>[];
    var keyboardRequests = 0;
    final scroll = ScrollController();
    await tester.pumpWidget(
      _app(
        messages: messages,
        onKeyboard: () => keyboardRequests++,
        enabled: false,
        child: SingleChildScrollView(
          controller: scroll,
          child: const SizedBox(
            height: 400,
            child: Center(child: Text('Scrollable content')),
          ),
        ),
      ),
    );
    final origin = _origin(tester);

    final swipe = await tester.startGesture(
      origin + const Offset(50, 80),
      kind: PointerDeviceKind.touch,
    );
    await swipe.moveTo(origin + const Offset(50, 30));
    await swipe.up();
    await tester.pump();

    expect(scroll.offset, greaterThan(0));
    expect(messages, isEmpty);
    expect(keyboardRequests, 0);
    await tester.pumpWidget(const SizedBox.shrink());
    scroll.dispose();
  });

  testWidgets('a second touch pointer cannot replace the active pointer', (
    tester,
  ) async {
    final messages = <Map<String, dynamic>>[];
    var keyboardRequests = 0;
    await tester.pumpWidget(
      _app(messages: messages, onKeyboard: () => keyboardRequests++),
    );
    final origin = _origin(tester);

    final first = await tester.startGesture(
      origin + const Offset(20, 10),
      kind: PointerDeviceKind.touch,
    );
    final second = await tester.startGesture(
      origin + const Offset(70, 70),
      kind: PointerDeviceKind.touch,
    );
    await second.moveTo(origin + const Offset(80, 80));
    await second.up();
    expect(messages, isEmpty);
    expect(keyboardRequests, 0);

    await first.up();
    expect(keyboardRequests, 1);
    expect(messages, [
      {
        'type': 'mouse',
        'action': 'down',
        'x': 40,
        'y': 30,
        'button': 'left',
        'clickCount': 1,
      },
      {
        'type': 'mouse',
        'action': 'up',
        'x': 40,
        'y': 30,
        'button': 'left',
        'clickCount': 1,
      },
    ]);
  });

  testWidgets('two touch taps send click counts 1, 1, 2, 2', (tester) async {
    final messages = <Map<String, dynamic>>[];
    var keyboardRequests = 0;
    await tester.pumpWidget(
      _app(messages: messages, onKeyboard: () => keyboardRequests++),
    );
    final origin = _origin(tester);

    for (var i = 0; i < 2; i++) {
      final tap = await tester.startGesture(
        origin + const Offset(20, 10),
        kind: PointerDeviceKind.touch,
      );
      await tap.up();
    }

    expect(messages.map((message) => message['clickCount']), [1, 1, 2, 2]);
    expect(keyboardRequests, 2);
  });

  testWidgets('two mouse clicks send click counts 1, 1, 2, 2', (tester) async {
    final messages = <Map<String, dynamic>>[];
    var keyboardRequests = 0;
    await tester.pumpWidget(
      _app(messages: messages, onKeyboard: () => keyboardRequests++),
    );
    final origin = _origin(tester);

    for (var i = 0; i < 2; i++) {
      final click = await tester.startGesture(
        origin + const Offset(20, 10),
        kind: PointerDeviceKind.mouse,
        buttons: kPrimaryMouseButton,
      );
      await click.up();
    }

    expect(messages.map((message) => message['clickCount']), [1, 1, 2, 2]);
    expect(keyboardRequests, 2);
  });

  testWidgets('distant and expired taps restart click count at one', (
    tester,
  ) async {
    final messages = <Map<String, dynamic>>[];
    var keyboardRequests = 0;
    await tester.pumpWidget(
      _app(messages: messages, onKeyboard: () => keyboardRequests++),
    );
    final origin = _origin(tester);

    var eventTime = Duration.zero;
    Future<void> tapAt(Offset position) async {
      final tap = await tester.startGesture(
        origin + position,
        kind: PointerDeviceKind.touch,
      );
      await tap.up(timeStamp: eventTime);
    }

    await tapAt(const Offset(20, 10));
    await tapAt(const Offset(50, 10));
    await tapAt(const Offset(20, 10));
    eventTime = kDoubleTapTimeout + const Duration(milliseconds: 1);
    await tapAt(const Offset(20, 10));

    expect(messages.map((message) => message['clickCount']), [
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
    ]);
    expect(keyboardRequests, 4);
  });
}
