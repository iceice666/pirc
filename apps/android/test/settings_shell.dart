import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'live_test.dart' show theme;

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
