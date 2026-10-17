import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/schedule_datetime_picker.dart';
import 'live_test.dart' show theme;

void main() {
  testWidgets(
    'picker commits month changes and distinguishes cancel and clear',
    (t) async {
      String? result = 'untouched';
      Widget host() => MaterialApp(
        theme: theme.build(Brightness.light),
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () async {
                result = await showScheduleDateTimePicker(
                  context,
                  '2026-01-31T09:30',
                );
              },
              child: const Text('Open'),
            ),
          ),
        ),
      );
      await t.pumpWidget(host());
      await t.tap(find.text('Open'));
      await t.pumpAndSettle();
      await t.enterText(
        find.byKey(const ValueKey('schedule-picker-Month')),
        'Feb',
      );
      await t.testTextInput.receiveAction(TextInputAction.done);
      await t.pumpAndSettle();
      expect(
        t
            .widget<TextField>(
              find.byKey(const ValueKey('schedule-picker-Day')),
            )
            .controller!
            .text,
        '28',
      );
      await t.tap(find.text('Set'));
      await t.pumpAndSettle();
      expect(result, '2026-02-28T09:30');
      await t.tap(find.text('Open'));
      await t.pumpAndSettle();
      await t.enterText(
        find.byKey(const ValueKey('schedule-picker-Year')),
        '2028',
      );
      await t.tap(find.text('Cancel'));
      await t.pumpAndSettle();
      expect(result, isNull);
      await t.tap(find.text('Open'));
      await t.pumpAndSettle();
      await t.tap(find.text('Clear'));
      await t.pumpAndSettle();
      expect(result, '');
      expect(t.takeException(), isNull);
    },
  );

  testWidgets('picker supports 24 hour editing and rejects invalid draft', (
    t,
  ) async {
    String? result;
    await t.pumpWidget(
      MaterialApp(
        theme: theme.build(Brightness.dark),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(alwaysUse24HourFormat: true),
          child: child!,
        ),
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () async {
                result = await showScheduleDateTimePicker(
                  context,
                  '2026-11-05T09:30',
                );
              },
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    );
    await t.tap(find.text('Open'));
    await t.pumpAndSettle();
    expect(find.byKey(const ValueKey('schedule-picker-Period')), findsNothing);
    final hour = find.byKey(const ValueKey('schedule-picker-Hour'));
    await t.enterText(hour, '24');
    await t.tap(find.text('Set'));
    await t.pump();
    expect(find.text('Enter a valid date and time.'), findsOneWidget);
    expect(result, isNull);
    await t.enterText(hour, '23');
    await t.tap(find.text('Set'));
    await t.pumpAndSettle();
    expect(result, '2026-11-05T23:30');
    expect(t.takeException(), isNull);
  });
  testWidgets(
    'picker retains edits across focus changes and validates blurred drafts',
    (t) async {
      String? result;
      await t.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.light),
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () async {
                  result = await showScheduleDateTimePicker(
                    context,
                    '2026-01-31T09:30',
                  );
                },
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      );
      await t.tap(find.text('Open'));
      await t.pumpAndSettle();
      await t.enterText(
        find.byKey(const ValueKey('schedule-picker-Month')),
        'Feb',
      );
      await t.enterText(
        find.byKey(const ValueKey('schedule-picker-Minute')),
        '45',
      );
      FocusManager.instance.primaryFocus?.unfocus();
      await t.pumpAndSettle();
      await t.tap(find.text('Set'));
      await t.pumpAndSettle();
      expect(result, '2026-02-28T09:45');
      result = null;
      await t.tap(find.text('Open'));
      await t.pumpAndSettle();
      await t.enterText(
        find.byKey(const ValueKey('schedule-picker-Minute')),
        '99',
      );
      FocusManager.instance.primaryFocus?.unfocus();
      await t.pumpAndSettle();
      await t.tap(find.text('Set'));
      await t.pumpAndSettle();
      expect(find.text('Enter a valid date and time.'), findsOneWidget);
      expect(result, isNull);
      expect(t.takeException(), isNull);
    },
  );
}
