import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/external_image_drop_target.dart';
import 'package:pirc_mobile/live/gateway.dart';

import 'live_test.dart' show FakeGateway, theme;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'registers the clipped Flutter-DPR target and uploads ordered images',
    (tester) async {
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(800, 1200);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final gateway = FakeGateway();
      final targetCalls = <(String, Json)>[];
      final uploads = <Json>[];
      gateway.handler = (method, args) async {
        if (method == 'setExternalImageDropTarget' ||
            method == 'clearExternalImageDropTarget') {
          targetCalls.add((method, Map<String, dynamic>.of(args)));
          return null;
        }
        if (method == 'uploadAttachment') {
          final payload = Map<String, dynamic>.of(args);
          uploads.add(payload);
          return {
            'id': 'uploaded-${uploads.length}',
            'name': payload['name'],
            'mimeType': payload['mimeType'],
            'kind': 'image',
            'size': (payload['bytes'] as Uint8List).length,
          };
        }
        return gateway.normal(method, args);
      };
      final controller = _controller(gateway, 'session-a');
      await tester.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.light),
          home: Scaffold(
            body: Padding(
              padding: const EdgeInsets.only(left: 14, top: 26),
              child: ClipRect(
                child: SizedBox(
                  width: 110,
                  height: 54,
                  child: Align(
                    alignment: Alignment.topLeft,
                    child: ExternalImageDropTarget(
                      controller: controller,
                      child: const SizedBox(
                        key: ValueKey('drop-surface'),
                        width: 180,
                        height: 42,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final registration = targetCalls
          .singleWhere((call) => call.$1 == 'setExternalImageDropTarget')
          .$2;
      expect(registration['sessionId'], 'session-a');
      expect(registration['devicePixelRatio'], 2);
      final registeredRect = registration['rect'] as Map;
      final surfaceRect = tester.getRect(
        find.byKey(const ValueKey('drop-surface')),
      );
      expect(registeredRect['left'], surfaceRect.left);
      expect(registeredRect['top'], surfaceRect.top);
      expect(registeredRect['right'], lessThanOrEqualTo(124));
      expect(registeredRect['bottom'], lessThanOrEqualTo(80));

      gateway.stream.add({
        'type': 'externalImageDrop',
        'sessionId': 'session-a',
        'data': {
          'targetId': registration['targetId'],
          'scopeToken': registration['scopeToken'],
          'dropId': 'drop-1',
          'files': [
            {
              'name': 'first.png',
              'mimeType': 'image/png',
              'bytes': Uint8List.fromList([1, 2]),
            },
            {
              'name': 'unreadable.webp',
              'mimeType': 'image/webp',
              'error': 'permission denied',
            },
            {
              'name': 'last.jpg',
              'mimeType': 'image/jpeg',
              'bytes': Uint8List.fromList([3]),
            },
            {
              'name': 'ignored.pdf',
              'mimeType': 'application/pdf',
              'bytes': Uint8List.fromList([4]),
            },
          ],
        },
      });
      await tester.pumpAndSettle();

      expect(uploads.map((file) => file['name']), ['first.png', 'last.jpg']);
      expect(uploads.every((file) => file['sessionId'] == 'session-a'), isTrue);
      expect(controller.attachments.map((file) => file['name']), [
        'first.png',
        'last.jpg',
      ]);
      expect(controller.actionError, contains('unreadable.webp'));

      controller.dispose();
      await gateway.stream.close();
    },
  );

  testWidgets('drop completed after a session or account change is rejected', (
    tester,
  ) async {
    final gateway = FakeGateway();
    Json? registration;
    var uploads = 0;
    gateway.handler = (method, args) async {
      if (method == 'setExternalImageDropTarget') {
        registration = Map<String, dynamic>.of(args);
        return null;
      }
      if (method == 'uploadAttachment') {
        uploads++;
        return {'id': 'unexpected'};
      }
      return gateway.normal(method, args);
    };
    final controller = _controller(gateway, 'before-navigation');
    await tester.pumpWidget(
      MaterialApp(
        theme: theme.build(Brightness.light),
        home: Scaffold(
          body: ExternalImageDropTarget(
            controller: controller,
            child: const SizedBox(width: 180, height: 48),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final oldRegistration = registration!;

    // Models the native read completing only after the user has switched chat
    // or account. The event is still tagged with the old native target.
    controller.sessionId = 'after-navigation';
    controller.origin = 'https://replacement.example';
    controller.pairingStamp = 'replacement-stamp';
    gateway.stream.add({
      'type': 'externalImageDrop',
      'sessionId': 'before-navigation',
      'data': {
        'targetId': oldRegistration['targetId'],
        'scopeToken': oldRegistration['scopeToken'],
        'dropId': 'late-drop',
        'files': [
          {
            'name': 'late.png',
            'mimeType': 'image/png',
            'bytes': Uint8List.fromList([7, 8, 9]),
          },
        ],
      },
    });
    await tester.pumpAndSettle();

    expect(uploads, 0);
    expect(controller.attachments, isEmpty);
    controller.dispose();
    await gateway.stream.close();
  });

  testWidgets('offstage composer unregisters its native target', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final calls = <String>[];
    gateway.handler = (method, args) async {
      if (method == 'setExternalImageDropTarget' ||
          method == 'clearExternalImageDropTarget') {
        calls.add(method);
        return null;
      }
      return gateway.normal(method, args);
    };
    final controller = _controller(gateway, 'visible-session');
    var offstage = false;
    await tester.pumpWidget(
      MaterialApp(
        theme: theme.build(Brightness.light),
        home: Scaffold(
          body: StatefulBuilder(
            builder: (context, setState) => Column(
              children: [
                TextButton(
                  onPressed: () => setState(() => offstage = true),
                  child: const Text('hide'),
                ),
                Offstage(
                  offstage: offstage,
                  child: ExternalImageDropTarget(
                    controller: controller,
                    child: const SizedBox(width: 180, height: 48),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(calls, contains('setExternalImageDropTarget'));

    await tester.tap(find.text('hide'));
    await tester.pumpAndSettle();
    expect(calls.last, 'clearExternalImageDropTarget');

    controller.dispose();
    await gateway.stream.close();
  });
}

LiveController _controller(FakeGateway gateway, String sessionId) =>
    LiveController(gateway, showing: 'engine')
      ..booting = false
      ..origin = 'https://gateway.example'
      ..clientId = 'phone'
      ..pairingStamp = 'stamp-one'
      ..sessionId = sessionId;
