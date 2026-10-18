import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/conversation_timeline.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'live_test.dart' show FakeGateway, theme;

Json turn({String entryId = 'new'}) => {
  'id': 'user-$entryId',
  'entryId': entryId,
  'role': 'user',
  'content': 'Current question',
  'branches': [
    {'entryId': 'old', 'text': 'Old question', 'selected': false},
    {'entryId': 'new', 'text': 'Current question', 'selected': true},
  ],
};

LiveController ready(FakeGateway gateway) => LiveController(gateway)
  ..sessionId = 's'
  ..connection = 'live'
  ..control = {'held': true}
  ..state = {
    'messages': [turn()],
  };

void main() {
  test(
    'edit sends persistent ID, exact text and refreshes accepted state',
    () async {
      final gateway = FakeGateway();
      final controller = ready(gateway);
      gateway.snapshot['messages'] = [turn(entryId: 'fresh')];
      expect(
        await controller.changeMessageHistory('new', message: ' Revised '),
        isTrue,
      );
      final command = gateway.calls
          .singleWhere((call) => call.$1 == 'command')
          .$2;
      expect(command['payload'], {
        'type': 'edit_message',
        'entryId': 'new',
        'message': ' Revised ',
      });
      expect(controller.messages.single['entryId'], 'fresh');
      controller.dispose();
    },
  );

  test(
    'branches target an available sibling and reject stale or busy mutations',
    () async {
      final gateway = FakeGateway();
      final controller = ready(gateway);
      expect(await controller.changeMessageHistory('missing'), isFalse);
      expect(await controller.changeMessageHistory('new'), isFalse);
      expect(
        await controller.changeMessageHistory('stale', message: 'Edit'),
        isFalse,
      );
      expect(
        await controller.changeMessageHistory('new', message: '  '),
        isFalse,
      );
      controller.state['run'] = {'status': 'running'};
      expect(await controller.changeMessageHistory('old'), isFalse);
      controller.state.remove('run');
      controller.control = {'held': false};
      expect(await controller.changeMessageHistory('old'), isFalse);
      controller.control = {'held': true};
      controller.busy = true;
      expect(await controller.changeMessageHistory('old'), isFalse);
      controller.busy = false;
      controller.unknownCommand = true;
      expect(await controller.changeMessageHistory('old'), isFalse);
      controller.unknownCommand = false;
      expect(gateway.calls, isEmpty);
      expect(await controller.changeMessageHistory('old'), isTrue);
      final command = gateway.calls
          .singleWhere((call) => call.$1 == 'command')
          .$2;
      expect(command['payload'], {'type': 'switch_branch', 'entryId': 'old'});
      controller.dispose();
    },
  );

  test('refresh blocks further edits until fresh IDs arrive', () async {
    final gateway = FakeGateway(), pending = Completer<dynamic>();
    final controller = ready(gateway);
    gateway.handler = (method, args) async =>
        method == 'refresh' ? pending.future : gateway.normal(method, args);
    final result = controller.changeMessageHistory('new', message: 'Edit');
    await Future<void>.delayed(Duration.zero);
    expect(controller.canChangeHistory, isFalse);
    expect(
      await controller.changeMessageHistory('new', message: 'Duplicate'),
      isFalse,
    );
    pending.complete({
      ...gateway.snapshot,
      'messages': [turn(entryId: 'fresh')],
    });
    expect(await result, isTrue);
    expect(controller.canChangeHistory, isTrue);
    expect(
      await controller.changeMessageHistory('new', message: 'Stale'),
      isFalse,
    );
    controller.dispose();
  });

  test('pre-edit refresh cannot replace an accepted edit snapshot', () async {
    final gateway = FakeGateway(), stale = Completer<dynamic>();
    final controller = ready(gateway);
    var refreshes = 0;
    gateway.handler = (method, args) async {
      if (method == 'refresh' && refreshes++ == 0) return stale.future;
      return {
        ...gateway.snapshot,
        'messages': [turn(entryId: 'fresh')],
      };
    };
    final oldRefresh = controller.refreshSession();
    gateway.handler = (method, args) async {
      if (method == 'command') return {'status': 'accepted'};
      return {
        ...gateway.snapshot,
        'messages': [turn(entryId: 'fresh')],
      };
    };
    expect(
      await controller.changeMessageHistory('new', message: 'Edit'),
      isTrue,
    );
    stale.complete({
      'messages': [turn()],
    });
    await oldRefresh;
    expect(controller.messages.single['entryId'], 'fresh');
    controller.dispose();
  });

  test(
    'accepted edit with failed refresh cannot be resubmitted using stale IDs',
    () async {
      final gateway = FakeGateway();
      final controller = ready(gateway);
      gateway.handler = (method, args) async {
        if (method == 'refresh') throw StateError('offline');
        return gateway.normal(method, args);
      };
      expect(
        await controller.changeMessageHistory('new', message: 'Edit'),
        isTrue,
      );
      expect(controller.canChangeHistory, isFalse);
      expect(
        await controller.changeMessageHistory('new', message: 'Duplicate'),
        isFalse,
      );
      gateway.handler = null;
      gateway.snapshot['messages'] = [turn(entryId: 'fresh')];
      await controller.refreshSession();
      expect(controller.canChangeHistory, isTrue);
      controller.dispose();
    },
  );

  test('session changes never refresh a different session', () async {
    final gateway = FakeGateway(), pending = Completer<dynamic>();
    final controller = ready(gateway);
    gateway.handler = (method, args) async =>
        method == 'command' ? pending.future : gateway.normal(method, args);
    final result = controller.changeMessageHistory('new', message: 'Edit');
    expect(controller.canChangeHistory, isFalse);
    controller.sessionId = 'other';
    pending.complete({'status': 'accepted'});
    expect(await result, isFalse);
    expect(gateway.calls.where((call) => call.$1 == 'refresh'), isEmpty);
    controller.dispose();
  });

  testWidgets(
    'version navigation switches by entry ID and responds to control loss',
    (tester) async {
      final gateway = FakeGateway();
      final controller = ready(gateway);
      await tester.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.light),
          home: Scaffold(body: ConversationTimeline(controller: controller)),
        ),
      );
      await tester.tap(find.byTooltip('Previous version'));
      await tester.pumpAndSettle();
      final command = gateway.calls
          .singleWhere((call) => call.$1 == 'command')
          .$2;
      expect(command['payload'], {'type': 'switch_branch', 'entryId': 'old'});
      controller.state = {
        'messages': [turn()],
      };
      controller.control = {'held': false};
      controller.changed();
      await tester.pump();
      await tester.tap(find.byTooltip('Edit message'));
      await tester.pump();
      expect(find.byType(TextField), findsNothing);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
  );

  testWidgets('failed edits preserve draft and cancel restores message', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final controller = ready(gateway);
    gateway.handler = (method, args) async => method == 'command'
        ? {'status': 'rejected', 'message': 'Try again'}
        : gateway.normal(method, args);
    await tester.pumpWidget(
      MaterialApp(
        theme: theme.build(Brightness.light),
        home: Scaffold(
          body: SingleChildScrollView(
            child: ConversationTimeline(controller: controller),
          ),
        ),
      ),
    );
    await tester.tap(find.byTooltip('Edit message'));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'Preserved draft');
    await tester.tap(find.text('Save and regenerate'));
    await tester.pumpAndSettle();
    expect(find.text('Try again'), findsOneWidget);
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      'Preserved draft',
    );
    await tester.tap(find.text('Cancel'));
    await tester.pump();
    expect(find.byType(TextField), findsNothing);
    expect(find.text('Current question'), findsOneWidget);
    expect(find.text('2/2'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    controller.dispose();
  });
}
