import 'dart:ui' show PointerDeviceKind;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/workspace_instructions_editor.dart';

import 'live_test.dart' show theme;

Widget _host({
  required TextEditingController controller,
  required bool enabled,
  required double textScale,
  required ValueChanged<String> onChanged,
}) => MaterialApp(
  theme: theme
      .build(Brightness.light)
      .copyWith(platform: TargetPlatform.android),
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(
      context,
    ).copyWith(textScaler: TextScaler.linear(textScale)),
    child: child!,
  ),
  home: Scaffold(
    body: WorkspaceInstructionsEditor(
      controller: controller,
      enabled: enabled,
      onChanged: onChanged,
      tooLong: false,
      count: '${controller.text.length} / 8000 characters',
    ),
  ),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('touch editor uses eight-line height at 1x and 2x text scale', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 900);
    addTearDown(tester.view.reset);

    for (final (scale, expectedHeight) in [(1.0, 212.0), (2.0, 404.0)]) {
      final controller = TextEditingController(text: 'Existing instructions');
      await tester.pumpWidget(
        _host(
          controller: controller,
          enabled: true,
          textScale: scale,
          onChanged: (_) {},
        ),
      );
      await tester.pumpAndSettle();

      final field = find.byKey(const ValueKey('workspace-instructions-text'));
      final beforeFocus = tester.getRect(field);
      expect(beforeFocus.height, closeTo(expectedHeight, 0.01));

      await tester.tap(field);
      await tester.pump();
      expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
      expect(tester.getRect(field), beforeFocus);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    }
  });

  testWidgets(
    'resizing keeps the edited draft and does not emit another edit',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(390, 900);
      addTearDown(tester.view.reset);
      final controller = TextEditingController(text: 'Original');
      final changes = <String>[];
      await tester.pumpWidget(
        _host(
          controller: controller,
          enabled: true,
          textScale: 1,
          onChanged: changes.add,
        ),
      );
      await tester.pumpAndSettle();

      final field = find.byKey(const ValueKey('workspace-instructions-text'));
      final grip = find.byKey(const ValueKey('workspace-instructions-resize'));
      const draft = 'A workspace instructions draft';
      await tester.enterText(field, draft);
      await tester.pump();
      expect(controller.text, draft);
      expect(changes, [draft]);

      final beforeResize = tester.getRect(field);
      await tester.drag(
        grip,
        const Offset(0, 37),
        kind: PointerDeviceKind.touch,
      );
      await tester.pump();

      expect(
        tester.getRect(field).height,
        closeTo(beforeResize.height + 37, 0.01),
      );
      expect(controller.text, draft);
      expect(changes, [draft]);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
  );

  testWidgets('disabled instructions cannot receive focus or text input', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 900);
    addTearDown(tester.view.reset);
    final controller = TextEditingController(text: 'Read-only instructions');
    final changes = <String>[];
    await tester.pumpWidget(
      _host(
        controller: controller,
        enabled: false,
        textScale: 1,
        onChanged: changes.add,
      ),
    );
    await tester.pumpAndSettle();

    final field = find.byKey(const ValueKey('workspace-instructions-text'));
    expect(tester.widget<TextField>(field).enabled, isFalse);
    await tester.tap(field);
    await tester.pump();
    expect(tester.widget<TextField>(field).focusNode!.hasFocus, isFalse);
    expect(controller.text, 'Read-only instructions');
    expect(changes, isEmpty);

    // A disabled EditableText has no active text-input connection. Attempting
    // keyboard input through the test channel therefore must leave its value
    // and edit callback untouched.
    tester.testTextInput.enterText('Should not be accepted');
    await tester.pump();
    expect(controller.text, 'Read-only instructions');
    expect(changes, isEmpty);
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox());
    controller.dispose();
  });
}
