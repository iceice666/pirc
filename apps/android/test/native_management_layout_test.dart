import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/native_management_access.dart';
import 'live_test.dart' show FakeGateway, theme;

void main() {
  for (final width in [390, 650, 651, 768, 860, 861, 1024]) {
    for (final brightness in Brightness.values) {
      for (final scale in [1.0, 2.0]) {
        testWidgets('management states fit $width $brightness $scale', (
          tester,
        ) async {
          tester.view.physicalSize = Size(width.toDouble(), 900);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          final gateway = FakeGateway();
          final controller = LiveController(gateway)..pairingStamp = 'paired';
          final now = DateTime.now().millisecondsSinceEpoch;
          Json status = {};
          gateway.handler = (method, _) async => status;
          for (final phase in [
            'idle',
            'pending',
            'active',
            'limited',
            'expired',
          ]) {
            status = {
              'active': phase == 'active' || phase == 'limited',
              'remainingMs': 900000,
              'capabilities': phase == 'limited' ? ['devices'] : ['providers'],
              'request': {
                'id': 'opaque-request',
                'deviceName':
                    'Long named Android tablet for browser management approval',
                'status': phase == 'active' || phase == 'limited'
                    ? 'claimed'
                    : phase,
                'expiresAt': now + 300000,
                'serverNow': now,
                'capabilities': ['providers'],
              },
            };
            await tester.pumpWidget(
              MaterialApp(
                theme: theme.build(brightness),
                builder: (context, child) => MediaQuery(
                  data: MediaQuery.of(
                    context,
                  ).copyWith(textScaler: TextScaler.linear(scale)),
                  child: child!,
                ),
                home: Scaffold(
                  body: SingleChildScrollView(
                    child: NativeManagementAccess(
                      key: ValueKey(phase),
                      controller: controller,
                      capabilities: const ['providers'],
                      onApproved: () async {},
                      onRevoked: () async {},
                    ),
                  ),
                ),
              ),
            );
            await tester.pumpAndSettle();
            expect(
              tester.takeException(),
              isNull,
              reason: '$phase at $width/$brightness/$scale',
            );
            expect(find.byType(NativeManagementAccess), findsOneWidget);
            expect(
              find.textContaining('Approve this app in your browser'),
              findsOneWidget,
            );
          }
          await tester.pumpWidget(const SizedBox());
          controller.dispose();
          await gateway.stream.close();
        });
      }
    }
  }
}
