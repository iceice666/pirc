import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/conversation_header.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/conversation_empty.dart';
import 'package:pirc_mobile/live/session_sidebar.dart';
import 'live_test.dart' show FakeGateway, theme;

void main() {
  for (final width in [390.0, 768.0]) {
    for (final brightness in Brightness.values) {
      testWidgets('conversation error below header $width ${brightness.name}', (
        t,
      ) async {
        t.view.devicePixelRatio = 1;
        t.view.physicalSize = Size(width, 900);
        addTearDown(t.view.reset);
        final gateway = FakeGateway();
        final controller = LiveController(gateway, showing: 'engine');
        await t.pumpWidget(MobileApp(theme: theme, controller: controller));
        await t.pumpAndSettle();
        await controller.open('s');
        gateway.publish('s');
        controller.preferences['appearance'] = brightness.name;
        gateway.stream.add({
          'type': 'error',
          'sessionId': 's',
          'data': 'The operation could not be completed.',
        });
        controller.changed();
        await t.pumpAndSettle();
        final banner = find.byType(ConversationErrorBanner);
        expect(banner, findsOneWidget);
        expect(
          find.text(
            'The operation could not be completed.',
            skipOffstage: false,
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: find.byType(SessionSidebar, skipOffstage: false),
            matching: find.text(
              'The operation could not be completed.',
              skipOffstage: false,
            ),
            skipOffstage: false,
          ),
          findsNothing,
        );
        await controller.refreshList();
        expect(controller.error, 'The operation could not be completed.');
        gateway.handler = (method, args) async {
          if (method == 'request' && args['path'] == '/api/sessions') {
            throw PlatformException(
              code: 'NETWORK',
              message: 'Background list failed',
            );
          }
          return gateway.normal(method, args);
        };
        await controller.refreshList();
        expect(controller.error, 'The operation could not be completed.');
        gateway.publish('s');
        await t.pumpAndSettle();
        expect(controller.error, 'The operation could not be completed.');
        expect(
          t.getTopLeft(banner).dy,
          t.getBottomLeft(find.byType(ConversationHeader)).dy,
        );
        await t.tap(find.byTooltip('Dismiss error'));
        await t.pumpAndSettle();
        expect(controller.error, isNull);
        expect(banner, findsNothing);
        await controller.refreshList();
        await t.pumpAndSettle();
        expect(controller.error, isNull);
        expect(find.text('Background list failed'), findsNothing);
        gateway.stream.add({
          'type': 'connection',
          'sessionId': 's',
          'data': 'connecting',
        });
        await t.pumpAndSettle();
        expect(find.byTooltip('Reconnecting'), findsOneWidget);
        expect(
          find.text('Reconnecting'),
          width <= 650 ? findsNothing : findsOneWidget,
        );
        expect(
          find.textContaining('Displayed state may be stale'),
          findsNothing,
        );
        expect(find.text('Connecting…'), findsNothing);
        expect(t.takeException(), isNull);
        await t.pumpWidget(const SizedBox());
        await gateway.stream.close();
      });
    }
  }
  for (final width in [390.0, 768.0]) {
    for (final code in ['NETWORK', 'UNAUTHORIZED']) {
      testWidgets(
        'initial $code failure follows web no-session state at $width',
        (t) async {
          t.view.devicePixelRatio = 1;
          t.view.physicalSize = Size(width, 900);
          addTearDown(t.view.reset);
          final gateway = FakeGateway();
          gateway.handler = (method, args) async {
            if (method == 'request' && args['path'] == '/api/sessions') {
              throw PlatformException(
                code: code,
                message: 'Initial list failed',
              );
            }
            return gateway.normal(method, args);
          };
          final controller = LiveController(gateway, showing: 'engine');
          await t.pumpWidget(MobileApp(theme: theme, controller: controller));
          await t.pumpAndSettle();
          expect(controller.error, isNotNull);
          expect(controller.sessionId, isNull);
          expect(
            find.byType(AppNoSessionState, skipOffstage: false),
            findsOneWidget,
          );
          expect(
            find.byType(ConversationErrorBanner, skipOffstage: false),
            findsNothing,
          );
          expect(
            find.textContaining('Initial list failed', skipOffstage: false),
            findsNothing,
          );
          expect(find.byTooltip('Retry', skipOffstage: false), findsNothing);
          expect(
            find.text('No session could be loaded.').hitTestable(),
            width > 650 ? findsOneWidget : findsNothing,
          );
          expect(t.takeException(), isNull);
          await t.pumpWidget(const SizedBox());
          await gateway.stream.close();
        },
      );
    }
  }
}
