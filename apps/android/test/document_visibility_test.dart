import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';

import 'live_test.dart' show FakeGateway;

Future<LiveController> _readyController(FakeGateway gateway) async {
  final controller = LiveController(gateway);
  await controller.boot();
  await controller.open('s');
  gateway.publish('s');
  return controller;
}

int _countCalls(FakeGateway gateway, String method) =>
    gateway.calls.where((call) => call.$1 == method).length;

void main() {
  test(
    'covered documents suppress app visibility until the last uncover',
    () async {
      final gateway = FakeGateway();
      final controller = await _readyController(gateway);
      addTearDown(() async {
        controller.dispose();
        await gateway.stream.close();
      });
      final watchesBeforeCover = _countCalls(gateway, 'watch');

      await controller.coverDocument();
      expect(controller.active, isFalse);
      expect(_countCalls(gateway, 'unwatch'), 1);
      expect(_countCalls(gateway, 'watch'), watchesBeforeCover);

      await controller.coverDocument();
      await controller.lifecycle(false);
      await controller.lifecycle(true);
      expect(controller.active, isFalse);
      expect(_countCalls(gateway, 'watch'), watchesBeforeCover);

      await controller.uncoverDocument();
      expect(controller.active, isFalse);
      expect(_countCalls(gateway, 'watch'), watchesBeforeCover);

      await controller.uncoverDocument();
      expect(controller.active, isTrue);
      expect(_countCalls(gateway, 'watch'), watchesBeforeCover + 1);
      expect(
        gateway.calls.lastWhere((call) => call.$1 == 'watch').$2['sessionId'],
        's',
      );
    },
  );

  test(
    'uncovering while the app is backgrounded does not restore watch',
    () async {
      final gateway = FakeGateway();
      final controller = await _readyController(gateway);
      addTearDown(() async {
        controller.dispose();
        await gateway.stream.close();
      });

      await controller.coverDocument();
      await controller.lifecycle(false);
      final watchesWhileCovered = _countCalls(gateway, 'watch');

      await controller.uncoverDocument();
      expect(controller.active, isFalse);
      expect(_countCalls(gateway, 'watch'), watchesWhileCovered);

      await controller.lifecycle(true);
      expect(controller.active, isTrue);
      expect(_countCalls(gateway, 'watch'), watchesWhileCovered + 1);
    },
  );

  test('a stale hide does not unwatch after a newer show', () async {
    final gateway = FakeGateway();
    final controller = await _readyController(gateway);
    addTearDown(() async {
      controller.dispose();
      await gateway.stream.close();
    });
    final draftStarted = Completer<void>();
    final releaseDraft = Completer<void>();
    gateway.handler = (method, args) async {
      if (method == 'draft') {
        if (!draftStarted.isCompleted) draftStarted.complete();
        await releaseDraft.future;
      }
      return gateway.normal(method, args);
    };
    controller.editDraft('keep this edit');
    final watchesBeforeHide = _countCalls(gateway, 'watch');

    final hiding = controller.lifecycle(false);
    expect(controller.active, isFalse);
    await draftStarted.future;

    final showing = controller.lifecycle(true);
    expect(controller.active, isTrue);
    await showing;
    expect(_countCalls(gateway, 'watch'), watchesBeforeHide + 1);

    releaseDraft.complete();
    await hiding;
    expect(_countCalls(gateway, 'unwatch'), 0);
    expect(_countCalls(gateway, 'watch'), watchesBeforeHide + 1);
  });
}
