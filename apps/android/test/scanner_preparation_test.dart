import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'live_test.dart' show theme;
import 'permissions_test.dart' show PermissionGateway;

class PreparingGateway extends PermissionGateway {
  Completer<dynamic>? pending;
  bool canCancel = true;
  @override
  dynamic normal(String method, Json args) {
    if (method == 'scan') return (pending = Completer<dynamic>()).future;
    if (method == 'cancelScanPreparation') {
      if (canCancel && pending?.isCompleted == false) pending!.complete(null);
      return canCancel;
    }
    if (method == 'pair') {
      return {'origin': 'https://gateway.example', 'clientId': 'phone'};
    }
    return super.normal(method, args);
  }
}

Future<LiveController> mount(WidgetTester t, PreparingGateway g) async {
  final c = LiveController(g);
  await t.pumpWidget(
    MaterialApp(
      theme: theme.build(Brightness.light),
      home: PairingScreen(controller: c),
    ),
  );
  await t.pumpAndSettle();
  return c;
}

Future<void> cleanup(
  WidgetTester t,
  PreparingGateway g,
  LiveController c,
) async {
  await t.pumpWidget(const SizedBox());
  await t.pumpAndSettle();
  c.dispose();
  await g.stream.close();
}

void main() {
  testWidgets('preparation exposes cancel and prevents duplicate scans', (
    t,
  ) async {
    final g = PreparingGateway();
    final c = await mount(t, g);
    await t.tap(find.text('掃描 QR code'));
    await t.pump();
    expect(find.text('正在準備掃描器…'), findsOneWidget);
    expect(
      t
          .widget<TextButton>(find.widgetWithText(TextButton, '正在準備掃描器…'))
          .onPressed,
      isNull,
    );
    final request = g.calls.singleWhere((call) => call.$1 == 'scan').$2;
    await t.tap(find.text('取消準備'));
    await t.pumpAndSettle();
    expect(
      g.calls
          .singleWhere((call) => call.$1 == 'cancelScanPreparation')
          .$2['requestId'],
      request['requestId'],
    );
    expect(g.calls.where((call) => call.$1 == 'pair'), isEmpty);
    expect(find.text('掃描 QR code'), findsOneWidget);
    await t.tap(find.text('掃描 QR code'));
    await t.pump();
    final scans = g.calls.where((call) => call.$1 == 'scan').toList();
    expect(scans, hasLength(2));
    expect(scans[1].$2['requestId'], isNot(scans[0].$2['requestId']));
    await cleanup(t, g, c);
  });

  testWidgets(
    'leaving pairing cancels only its preparation and cannot pair a late result',
    (t) async {
      final g = PreparingGateway()..canCancel = false;
      final c = await mount(t, g);
      await t.tap(find.text('掃描 QR code'));
      await t.pump();
      final request = g.calls.singleWhere((call) => call.$1 == 'scan').$2;
      await t.pumpWidget(const SizedBox());
      await t.pump();
      expect(
        g.calls
            .singleWhere((call) => call.$1 == 'cancelScanPreparation')
            .$2['requestId'],
        request['requestId'],
      );
      g.pending!.complete('a-late-decoded-link');
      await t.pumpAndSettle();
      expect(g.calls.where((call) => call.$1 == 'pair'), isEmpty);
      expect(t.takeException(), isNull);
      c.dispose();
      await g.stream.close();
    },
  );

  testWidgets('pasted link cancels preparation before pairing', (t) async {
    final g = PreparingGateway();
    final c = await mount(t, g);
    await t.tap(find.text('掃描 QR code'));
    await t.pump();
    await t.enterText(find.byType(TextField), 'a-pasted-test-link');
    await t.tap(find.text('連接'));
    await t.pumpAndSettle();
    final calls = g.calls.map((call) => call.$1).toList();
    expect(
      calls.indexOf('cancelScanPreparation'),
      lessThan(calls.indexOf('pair')),
    );
    expect(
      g.calls.singleWhere((call) => call.$1 == 'pair').$2['link'],
      'a-pasted-test-link',
    );
    expect(c.origin, 'https://gateway.example');
    expect(find.text('正在準備掃描器…'), findsNothing);
    await cleanup(t, g, c);
  });

  testWidgets('preparation timeout has retry copy and reenables scanner', (
    t,
  ) async {
    final g = PreparingGateway();
    final c = await mount(t, g);
    await t.tap(find.text('掃描 QR code'));
    await t.pump();
    g.pending!.completeError(PlatformException(code: 'SCAN_TIMEOUT'));
    await t.pumpAndSettle();
    expect(find.text('掃描器準備逾時，請重試或貼上配對連結。'), findsOneWidget);
    expect(find.text('掃描 QR code'), findsOneWidget);
    expect(find.text('使用內建相機掃描'), findsOneWidget);
    expect(find.text('取消準備'), findsNothing);
    expect(t.takeException(), isNull);
    await cleanup(t, g, c);
  });
}
