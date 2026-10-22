import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'live_test.dart' show theme;
import 'permissions_test.dart' show PermissionGateway;

void main() {
  testWidgets(
    'incoming pairing link updates an open pairing field without resetting edits for the same link',
    (tester) async {
      final gateway = PermissionGateway()..complete = true;
      final controller = LiveController(gateway, showing: 'engine');
      await tester.pumpWidget(MobileApp(theme: theme, controller: controller));
      await tester.pumpAndSettle();

      final fieldFinder = find.byType(TextField);
      expect(fieldFinder, findsOneWidget);

      const firstLink = 'pirc://pair?token=first';
      gateway.stream.add({
        'type': 'route',
        'sessionId': null,
        'data': {'pairLink': firstLink},
      });
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(fieldFinder).controller!.text, firstLink);

      await tester.enterText(fieldFinder, 'user is editing the link');
      gateway.stream.add({
        'type': 'route',
        'sessionId': null,
        'data': {'pairLink': firstLink},
      });
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(fieldFinder).controller!.text,
        'user is editing the link',
      );

      const replacementLink = 'pirc://pair?token=replacement';
      gateway.stream.add({
        'type': 'route',
        'sessionId': null,
        'data': {'pairLink': replacementLink},
      });
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(fieldFinder).controller!.text,
        replacementLink,
      );

      await tester.pumpWidget(const SizedBox());
      await tester.pump();
      await gateway.stream.close();
    },
  );
}
