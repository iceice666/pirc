import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/session_view.dart';
import 'package:pirc_mobile/live/common.dart';
import 'live_test.dart' show FakeGateway, theme;
import 'permissions_test.dart' show PermissionGateway;

void main() {
  testWidgets(
    'scanner success pairs through native bridge; cancellation does not pair',
    (t) async {
      final g = PermissionGateway()..complete = true;
      String? scanned;
      g.handler = (m, a) async {
        if (m == 'scan') return scanned;
        if (m == 'pair') {
          return {'origin': 'https://gateway.example', 'clientId': 'phone'};
        }
        return g.normal(m, a);
      };
      final c = LiveController(g, showing: 'engine');
      await t.pumpWidget(MobileApp(theme: theme, controller: c));
      await t.pumpAndSettle();
      await t.tap(find.text('掃描 QR code'));
      await t.pumpAndSettle();
      expect(g.calls.where((x) => x.$1 == 'pair'), isEmpty);
      scanned = 'test-link-from-scanner';
      await t.tap(find.text('掃描 QR code'));
      await t.pumpAndSettle();
      expect(g.calls.where((x) => x.$1 == 'pair').single.$2['link'], scanned);
      expect(c.origin, 'https://gateway.example');
      expect(c.sessionId, 's');
      expect(find.byType(PairingScreen), findsNothing);
      g.publish('s');
      await t.pumpAndSettle();
      expect(find.byType(SessionHeader), findsOneWidget);
      await t.pumpWidget(const SizedBox());
      await g.stream.close();
    },
  );
  testWidgets('scanner exception is readable and floating in both themes', (
    t,
  ) async {
    for (final brightness in Brightness.values) {
      final g = PermissionGateway()..complete = true;
      g.handler = (m, a) async {
        if (m == 'scan') {
          throw PlatformException(
            code: 'SCAN',
            message: "java.lang.Object.getClass() on a null object reference",
          );
        }
        return g.normal(m, a);
      };
      final c = LiveController(g, showing: 'engine');
      await t.pumpWidget(
        MaterialApp(
          theme: theme.build(brightness),
          home: PairingScreen(controller: c),
        ),
      );
      await t.tap(find.text('掃描 QR code'));
      await t.pumpAndSettle();
      expect(find.textContaining('java.lang'), findsNothing);
      expect(find.text('暫時無法開啟掃描器，請重試或貼上配對連結。'), findsOneWidget);
      final context = t.element(find.byType(PairingScreen));
      expect(
        Theme.of(context).snackBarTheme.backgroundColor,
        palette(context)['text.primary'],
      );
      expect(
        t.widget<SnackBar>(find.byType(SnackBar)).behavior,
        SnackBarBehavior.floating,
      );
      await t.pumpWidget(const SizedBox());
      await t.pump();
      c.dispose();
      await g.stream.close();
    }
  });
  testWidgets('empty account creates a session through the web entry point', (
    t,
  ) async {
    final g = FakeGateway();
    var created = false;
    g.handler = (method, args) async {
      if (method == 'request' && args['path'] == '/api/sessions') {
        if (args['method'] == 'POST') {
          created = true;
          return {'session': g.snapshot['session']};
        }
        return {
          'sessions': created ? [g.snapshot['session']] : [],
        };
      }
      return g.normal(method, args);
    };
    final c = LiveController(g, showing: 'engine');
    await t.pumpWidget(MobileApp(theme: theme, controller: c));
    await t.pumpAndSettle();
    expect(find.text('No session could be loaded.'), findsOneWidget);
    await t.tap(find.text('New session'));
    await t.pumpAndSettle();
    expect(find.text('Create a session'), findsOneWidget);
    await t.tap(find.text('Create session'));
    await t.pumpAndSettle();
    g.publish('s');
    await t.pumpAndSettle();
    expect(c.sessionId, 's');
    expect(find.byType(SessionHeader), findsOneWidget);
    expect(find.text('Create a session'), findsNothing);
    expect(g.calls.where((x) => x.$1 == 'command'), isEmpty);
    await t.pumpWidget(const SizedBox());
    await g.stream.close();
  });
}
