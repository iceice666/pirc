import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/about_settings.dart';
import 'live_test.dart' show theme;

void main() {
  testWidgets('About content fits the bounded width/theme/text-scale matrix', (
    tester,
  ) async {
    addTearDown(tester.view.reset);
    const clientId =
        'client-0123456789-abcdefghijklmnopqrstuvwxyz-0123456789-abcdefghijklmnopqrstuvwxyz';

    for (final width in [390.0, 768.0]) {
      for (final brightness in [Brightness.light, Brightness.dark]) {
        for (final scale in [1.0, 2.0]) {
          tester.view.devicePixelRatio = 1;
          tester.view.physicalSize = Size(width, 720);
          await tester.pumpWidget(
            MaterialApp(
              theme: theme.build(brightness),
              home: Builder(
                builder: (context) => MediaQuery(
                  data: MediaQuery.of(
                    context,
                  ).copyWith(textScaler: TextScaler.linear(scale)),
                  child: Scaffold(
                    body: Center(
                      child: SizedBox(
                        width: width - 40,
                        child: NativeAboutSettings(
                          clientId: clientId,
                          onAppOptions: () {},
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );

          expect(find.text('THIS BROWSER'), findsOneWidget);
          expect(find.text('Client ID'), findsOneWidget);
          expect(find.text('App options'), findsOneWidget);
          expect(find.byType(SelectionArea), findsOneWidget);
          expect(
            tester.getSize(find.text(clientId)).width,
            lessThanOrEqualTo((width - 40) * .6 + 1),
          );
          expect(tester.takeException(), isNull);
        }
      }
    }
  });

  testWidgets('App options remains an actionable native-only entry', (
    tester,
  ) async {
    var opened = 0;
    await tester.pumpWidget(
      MaterialApp(
        theme: theme.build(Brightness.light),
        home: Scaffold(
          body: NativeAboutSettings(
            clientId: 'native-client',
            onAppOptions: () => opened++,
          ),
        ),
      ),
    );
    await tester.tap(find.text('App options'));
    await tester.pump();
    expect(opened, 1);
    expect(find.text('native-client'), findsOneWidget);
  });
}
