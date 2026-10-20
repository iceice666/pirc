import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/web_controls.dart';
import 'package:pirc_mobile/theme.dart';
import 'live_test.dart' show theme;

void main() {
  testWidgets('fixed sidebar search follows web flex shrink geometry', (
    t,
  ) async {
    t.view.devicePixelRatio = 1;
    t.view.physicalSize = const Size(1024, 900);
    addTearDown(t.view.reset);
    final text = TextEditingController();
    final changes = <String>[];
    await t.pumpWidget(
      MaterialApp(
        theme: theme.build(Brightness.light),
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(
              width: 239,
              child: WebSearch(
                fixedHeight: 36,
                fontSize: 16,
                controller: text,
                label: 'Search sessions',
                onChanged: changes.add,
              ),
            ),
          ),
        ),
      ),
    );
    await t.pumpAndSettle();

    final search = find.byType(WebSearch);
    final surface = find.descendant(
      of: search,
      matching: find.byWidgetPredicate(
        (widget) =>
            widget is Container &&
            widget.padding == const EdgeInsets.symmetric(horizontal: 10),
      ),
    );
    final icon = find.descendant(of: search, matching: find.byType(Icon));
    final input = find.descendant(of: search, matching: find.byType(TextField));
    expect(t.getSize(search), const Size(239, 36));
    expect(surface, findsOneWidget);
    expect(t.getSize(icon).width, closeTo(14.366, .001));
    expect(t.getSize(icon).height, closeTo(14.366, .001));
    expect(t.getRect(input).left, closeTo(32.366, .04));
    expect(t.getSize(input).width, closeTo(196.634, .04));

    final idle = t.widget<Container>(surface).decoration! as BoxDecoration;
    final colors = Theme.of(t.element(search)).extension<PircColors>()!;
    expect(idle.color, colors['fill.hover']);
    expect(idle.boxShadow, isNull);
    await t.tap(input);
    await t.pump();
    final focused = t.widget<Container>(surface).decoration! as BoxDecoration;
    expect(focused.color, colors['surface.layer']);
    expect(focused.boxShadow, hasLength(1));
    expect(focused.boxShadow!.single.color, colors['web.line-dark']);
    expect(focused.boxShadow!.single.spreadRadius, 1);
    expect(t.getSize(search), const Size(239, 36));

    await t.enterText(input, 'alpha');
    await t.pump();
    expect(text.text, 'alpha');
    expect(changes, contains('alpha'));

    FocusManager.instance.primaryFocus?.unfocus();
    await t.pump();
    final blurred = t.widget<Container>(surface).decoration! as BoxDecoration;
    expect(blurred.color, idle.color);
    expect(blurred.boxShadow, isNull);
    expect(t.getRect(input).left, closeTo(32.366, .04));
    expect(t.getSize(input).width, closeTo(196.634, .04));
    expect(t.takeException(), isNull);
    await t.pumpWidget(const SizedBox());
    text.dispose();
  });
}
