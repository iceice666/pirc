import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/common.dart';
import 'package:pirc_mobile/live/assistant_settings.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/permissions.dart';
import 'package:pirc_mobile/live/settings.dart';
import 'package:pirc_mobile/live/web_controls.dart';

import 'live_test.dart' show FakeGateway, theme;

void main() {
  testWidgets(
    'native app options use shared sections and keep save errors inline',
    (tester) async {
      final gateway = FakeGateway();
      gateway.handler = (method, args) async {
        if (method == 'savePreferences') {
          throw PlatformException(code: 'STORAGE', message: '偏好設定無法儲存');
        }
        return {};
      };
      final controller = LiveController(gateway, showing: 'engine');

      await tester.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.dark),
          home: ManagementPage(
            kind: 'settings',
            controller: controller,
            theme: theme,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(AssistantSection), findsNWidgets(3));
      expect(find.byType(Surface), findsNothing);
      expect(find.text('解除配對'), findsOneWidget);

      await tester.tap(find.text('外觀').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('淺色').last);
      await tester.pumpAndSettle();

      expect(find.text('偏好設定無法儲存'), findsOneWidget);
      expect(find.byType(WebNotice), findsOneWidget);
      expect(find.byType(SnackBar), findsNothing);

      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    },
  );

  testWidgets('notification action failures appear inline without a SnackBar', (
    tester,
  ) async {
    final gateway = FakeGateway();
    gateway.handler = (method, args) async {
      if (method == 'preferences') return {};
      if (method == 'pushStatus') return {'state': 'off', 'code': 'off'};
      if (method == 'permissions') {
        return {'notifications': true, 'overlay': false};
      }
      if (method == 'request') {
        if (args['path'] == '/api/push') return {'subscriptions': []};
        return {};
      }
      if (method == 'pushEnable') {
        throw PlatformException(code: 'PUSH', message: '推播註冊失敗');
      }
      return {};
    };
    final controller = LiveController(gateway, showing: 'engine');

    await tester.pumpWidget(
      MaterialApp(
        theme: theme.build(Brightness.light),
        home: Scaffold(body: PushSettings(controller: controller)),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('啟用推播'));
    await tester.pumpAndSettle();

    expect(find.text('推播註冊失敗'), findsOneWidget);
    expect(find.byType(WebNotice), findsOneWidget);
    expect(find.byType(SnackBar), findsNothing);

    await tester.pumpWidget(const SizedBox());
    controller.dispose();
    await gateway.stream.close();
  });

  testWidgets(
    'a late pre-resume permission read cannot overwrite resumed OS truth',
    (tester) async {
      final gateway = FakeGateway();
      final reads = <Completer<dynamic>>[];
      gateway.handler = (method, args) {
        if (method == 'permissions') {
          final read = Completer<dynamic>();
          reads.add(read);
          return read.future;
        }
        return Future<dynamic>.value(null);
      };

      await tester.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.light),
          home: PermissionPage(gateway: gateway),
        ),
      );
      await tester.pump();
      expect(reads, hasLength(1));

      (tester.state(find.byType(PermissionPage)) as WidgetsBindingObserver)
          .didChangeAppLifecycleState(AppLifecycleState.resumed);
      await tester.pump();
      expect(reads, hasLength(2));

      reads[1].complete({'notifications': true, 'overlay': true});
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<Text>(find.byKey(const Key('permission-status-overlay')))
            .data,
        '已開啟',
      );

      reads[0].complete({'notifications': false, 'overlay': false});
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<Text>(find.byKey(const Key('permission-status-overlay')))
            .data,
        '已開啟',
      );

      await tester.pumpWidget(const SizedBox());
      await gateway.stream.close();
    },
  );
}
